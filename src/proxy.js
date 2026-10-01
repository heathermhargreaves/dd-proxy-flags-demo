import { createHash, randomUUID, timingSafeEqual } from 'node:crypto'
import { createServer } from 'node:http'
import { MemoryCacheStore } from './cache-store.js'

export const CONFIG_PATH = '/api/v2/feature-flagging/config/rules-based/server'

const SUPPORTED_SITES = new Set([
  'datadoghq.com',
  'us3.datadoghq.com',
  'us5.datadoghq.com',
  'datadoghq.eu',
  'ap1.datadoghq.com',
  'ap2.datadoghq.com',
])

/**
 * Build the first-party Datadog CDN URL for the selected site and environment.
 */
export function buildUpstreamUrl({ site, environment }) {
  if (!SUPPORTED_SITES.has(site)) {
    throw new Error(`Unsupported DD_SITE: ${site}`)
  }

  const url = new URL(`https://ufc-server.ff-cdn.${site}${CONFIG_PATH}`)
  url.searchParams.set('dd_env', environment)
  return url
}

export class FlagConfigurationCache {
  constructor({
    upstreamUrl,
    apiKey,
    ttlMs = 30_000,
    timeoutMs = 5_000,
    maxStaleMs = 5 * 60_000,
    maxResponseBytes = 5 * 1024 * 1024,
    fetchImpl = fetch,
    logger = console,
    now = Date.now,
    store = new MemoryCacheStore(),
  }) {
    if (!(upstreamUrl instanceof URL)) throw new TypeError('upstreamUrl must be a URL')
    if (!apiKey) throw new Error('DD_API_KEY is required by the proxy')
    if (!Number.isFinite(ttlMs) || ttlMs < 1) throw new Error('CACHE_TTL_MS must be positive')
    if (!Number.isFinite(maxStaleMs) || maxStaleMs < ttlMs) {
      throw new Error('MAX_STALE_MS must be greater than or equal to CACHE_TTL_MS')
    }

    this.upstreamUrl = upstreamUrl
    this.apiKey = apiKey
    this.ttlMs = ttlMs
    this.timeoutMs = timeoutMs
    this.maxStaleMs = maxStaleMs
    this.maxResponseBytes = maxResponseBytes
    this.fetchImpl = fetchImpl
    this.logger = logger
    this.now = now
    this.store = store
    this.entry = undefined
    this.refreshPromise = undefined
    this.stats = {
      cacheHits: 0,
      coalescedRequests: 0,
      sharedCoalescedRequests: 0,
      staleExpired: 0,
      staleResponses: 0,
      upstreamNotModified: 0,
      upstreamRequests: 0,
      upstreamUpdates: 0,
    }
  }

  async get() {
    const storedEntry = await this.#readStoredEntry()
    if (storedEntry && (!this.entry || storedEntry.refreshedAt >= this.entry.refreshedAt)) {
      this.entry = storedEntry
    }

    if (
      this.entry &&
      (this.now() - this.entry.refreshedAt < this.ttlMs || this.now() < (this.entry.retryAfter || 0))
    ) {
      this.stats.cacheHits++
      return { entry: this.entry, status: 'hit' }
    }

    if (this.refreshPromise) {
      this.stats.coalescedRequests++
      const entry = await this.refreshPromise
      return { entry, status: 'coalesced' }
    }

    this.refreshPromise = this.#refreshWithDistributedLock()
    try {
      return { entry: await this.refreshPromise, status: 'refresh' }
    } finally {
      this.refreshPromise = undefined
    }
  }

  getHealth() {
    const ageMs = this.entry ? this.now() - this.entry.refreshedAt : undefined
    return {
      ageMs,
      hasConfiguration: Boolean(this.entry),
      maxStaleMs: this.maxStaleMs,
      ready: ageMs !== undefined && ageMs <= this.maxStaleMs,
    }
  }

  async close() {
    await this.store.close()
  }

  async #refreshWithDistributedLock() {
    const token = randomUUID()
    const lockTtlMs = this.timeoutMs + 5_000
    let acquired
    try {
      acquired = await this.store.acquireRefreshLock(token, lockTtlMs)
    } catch (error) {
      this.logger.warn?.(`Shared cache lock unavailable; refreshing locally: ${error.message}`)
      return this.#refresh()
    }

    if (!acquired) {
      this.stats.sharedCoalescedRequests++
      const previousRefresh = this.entry?.refreshedAt || 0
      const deadline = this.now() + lockTtlMs

      while (this.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 100))
        const entry = await this.#readStoredEntry()
        if (entry && entry.refreshedAt > previousRefresh) {
          this.entry = entry
          return entry
        }
      }

      if (this.entry && this.now() - this.entry.refreshedAt <= this.maxStaleMs) {
        return this.entry
      }
      throw new Error('Timed out waiting for the shared configuration refresh')
    }

    try {
      return await this.#refresh()
    } finally {
      try {
        await this.store.releaseRefreshLock(token)
      } catch (error) {
        this.logger.warn?.(`Could not release shared cache lock: ${error.message}`)
      }
    }
  }

  async #readStoredEntry() {
    try {
      return await this.store.get()
    } catch (error) {
      this.logger.warn?.(`Shared cache read failed; using local state: ${error.message}`)
      return undefined
    }
  }

  async #saveEntry() {
    try {
      await this.store.set(this.entry)
    } catch (error) {
      this.logger.warn?.(`Shared cache write failed; retaining local state: ${error.message}`)
    }
  }

  async #refresh() {
    this.stats.upstreamRequests++
    const headers = {
      Accept: 'application/vnd.api+json, application/json',
      'Accept-Encoding': 'gzip',
      'DD-API-KEY': this.apiKey,
      'User-Agent': 'datadog-server-feature-flag-proxy/0.1',
    }
    if (this.entry?.upstreamEtag) headers['If-None-Match'] = this.entry.upstreamEtag

    try {
      const response = await this.fetchImpl(this.upstreamUrl, {
        method: 'GET',
        headers,
        redirect: 'error',
        signal: AbortSignal.timeout(this.timeoutMs),
      })

      if (response.status === 304 && this.entry) {
        this.stats.upstreamNotModified++
        this.entry = { ...this.entry, refreshedAt: this.now(), retryAfter: 0 }
        await this.#saveEntry()
        return this.entry
      }

      if (response.status !== 200) {
        throw new Error(`Datadog CDN returned HTTP ${response.status}`)
      }

      const declaredLength = Number(response.headers.get('content-length'))
      if (declaredLength > this.maxResponseBytes) {
        throw new Error(`Datadog CDN response exceeds ${this.maxResponseBytes} bytes`)
      }

      const body = await response.text()
      if (Buffer.byteLength(body) > this.maxResponseBytes) {
        throw new Error(`Datadog CDN response exceeds ${this.maxResponseBytes} bytes`)
      }
      validateUfcResponse(body)

      const upstreamEtag = response.headers.get('etag') || undefined
      const etag = upstreamEtag || `"${createHash('sha256').update(body).digest('base64url')}"`
      this.entry = {
        body,
        contentType: response.headers.get('content-type') || 'application/json',
        etag,
        refreshedAt: this.now(),
        retryAfter: 0,
        upstreamEtag,
      }
      await this.#saveEntry()
      this.stats.upstreamUpdates++
      return this.entry
    } catch (error) {
      if (!this.entry) throw error
      if (this.now() - this.entry.refreshedAt > this.maxStaleMs) {
        this.stats.staleExpired++
        throw new Error('Last-known-good flag configuration exceeded MAX_STALE_MS', { cause: error })
      }

      this.stats.staleResponses++
      // Avoid turning an upstream outage into one failed CDN request per SDK
      // poll. Retry at most once per cache window while stale data is usable.
      this.entry = { ...this.entry, retryAfter: this.now() + this.ttlMs }
      await this.#saveEntry()
      this.logger.warn?.(`Flag proxy refresh failed; serving last-known-good configuration: ${error.message}`)
      return this.entry
    }
  }
}

export function createFlagProxyServer({
  cache,
  logger = console,
  adminToken,
}) {
  const downstreamStats = {
    clientNotModified: 0,
    clientRequests: 0,
    clientResponses: 0,
    errors: 0,
  }
  const server = createServer(async (request, response) => {
    const url = new URL(request.url, 'http://proxy.local')

    if (url.pathname === '/livez') {
      sendJson(response, 200, { ok: true })
      return
    }

    if (url.pathname === '/healthz' || url.pathname === '/readyz') {
      const health = cache.getHealth()
      sendJson(response, health.ready ? 200 : 503, health)
      return
    }

    if (url.pathname === '/_stats') {
      if (!isAdminRequest(request, adminToken)) {
        sendJson(response, 404, { error: 'not_found' })
        return
      }
      sendJson(response, 200, {
        cache: cache.stats,
        downstream: downstreamStats,
        health: cache.getHealth(),
        mfcr: {
          estimatedBillableServerMfcr: cache.stats.upstreamRequests * 10,
          rawDatadogConfigurationRequests: cache.stats.upstreamRequests,
        },
        upstream: redactUrl(cache.upstreamUrl),
      })
      return
    }

    if (url.pathname === '/metrics') {
      if (!isAdminRequest(request, adminToken)) {
        sendJson(response, 404, { error: 'not_found' })
        return
      }
      sendMetrics(response, cache, downstreamStats)
      return
    }

    if (url.pathname !== CONFIG_PATH) {
      sendJson(response, 404, { error: 'not_found' })
      return
    }

    if (request.method !== 'GET') {
      response.setHeader('Allow', 'GET')
      sendJson(response, 405, { error: 'method_not_allowed' })
      return
    }

    downstreamStats.clientRequests++
    try {
      const { entry, status } = await cache.get()
      setConfigurationHeaders(response, entry, status)

      if (etagMatches(request.headers['if-none-match'], entry.etag)) {
        downstreamStats.clientNotModified++
        response.writeHead(304)
        response.end()
        return
      }

      downstreamStats.clientResponses++
      response.writeHead(200)
      response.end(entry.body)
    } catch (error) {
      downstreamStats.errors++
      logger.error?.('Flag proxy could not load configuration', error)
      sendJson(response, 502, { error: 'configuration_unavailable' })
    }
  })

  return server
}

function validateUfcResponse(body) {
  let parsed
  try {
    parsed = JSON.parse(body)
  } catch {
    throw new Error('Datadog CDN returned invalid JSON')
  }

  const data = parsed?.data
  const attributes = data?.attributes
  if (
    data?.type !== 'universal-flag-configuration' ||
    typeof attributes?.format !== 'string' ||
    typeof attributes?.createdAt !== 'string' ||
    typeof attributes?.environment?.name !== 'string' ||
    !attributes?.flags ||
    typeof attributes.flags !== 'object' ||
    Array.isArray(attributes.flags)
  ) {
    throw new Error('Datadog CDN returned an invalid Universal Flag Configuration')
  }
  return attributes
}

function etagMatches(header, etag) {
  if (!header) return false
  return header === '*' || header.split(',').some((candidate) => candidate.trim() === etag)
}

function isAdminRequest(request, adminToken) {
  if (!adminToken) return false
  const supplied = request.headers.authorization?.replace(/^Bearer\s+/i, '') || ''
  const expectedBuffer = Buffer.from(adminToken)
  const suppliedBuffer = Buffer.from(supplied)
  return expectedBuffer.length === suppliedBuffer.length &&
    timingSafeEqual(expectedBuffer, suppliedBuffer)
}

function setConfigurationHeaders(response, entry, cacheStatus) {
  response.setHeader('Cache-Control', 'private, no-store')
  response.setHeader('Content-Type', entry.contentType)
  response.setHeader('ETag', entry.etag)
  response.setHeader('X-Content-Type-Options', 'nosniff')
  response.setHeader('X-Flag-Proxy-Cache', cacheStatus)
}

function sendJson(response, status, value) {
  response.writeHead(status, {
    'Cache-Control': 'no-store',
    'Content-Type': 'application/json',
    'X-Content-Type-Options': 'nosniff',
  })
  response.end(JSON.stringify(value))
}

function sendMetrics(response, cache, downstreamStats) {
  const health = cache.getHealth()
  const values = {
    flag_proxy_billable_server_mfcr_estimate_total: cache.stats.upstreamRequests * 10,
    flag_proxy_cache_hits_total: cache.stats.cacheHits,
    flag_proxy_client_requests_total: downstreamStats.clientRequests,
    flag_proxy_configuration_age_seconds: health.ageMs === undefined ? -1 : health.ageMs / 1000,
    flag_proxy_ready: health.ready ? 1 : 0,
    flag_proxy_stale_responses_total: cache.stats.staleResponses,
    flag_proxy_upstream_requests_total: cache.stats.upstreamRequests,
  }
  const body = Object.entries(values)
    .map(([name, value]) => `${name} ${value}`)
    .join('\n')

  response.writeHead(200, {
    'Cache-Control': 'no-store',
    'Content-Type': 'text/plain; version=0.0.4',
  })
  response.end(`${body}\n`)
}

function redactUrl(url) {
  return `${url.origin}${url.pathname}`
}
