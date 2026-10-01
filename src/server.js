import { readFile } from 'node:fs/promises'
import { MemoryCacheStore, RedisCacheStore } from './cache-store.js'
import {
  FlagConfigurationCache,
  buildUpstreamUrl,
  createFlagProxyServer,
} from './proxy.js'

const port = positiveInteger('PORT', 8080)
const host = process.env.HOST || '127.0.0.1'
const site = process.env.DD_SITE || 'datadoghq.com'
const environment = required('DD_ENV')
const apiKey = await secret('DD_API_KEY')
const adminToken = await secret('ADMIN_TOKEN')
const redisUrl = process.env.REDIS_URL?.trim()

const upstreamUrl = buildUpstreamUrl({
  site,
  environment,
})
const store = redisUrl
  ? await RedisCacheStore.connect({
      url: redisUrl,
      prefix: process.env.REDIS_PREFIX || `datadog-flag-proxy:${site}:${environment}`,
    })
  : new MemoryCacheStore()
const cache = new FlagConfigurationCache({
  upstreamUrl,
  apiKey,
  ttlMs: positiveInteger('CACHE_TTL_MS', 30_000),
  timeoutMs: positiveInteger('UPSTREAM_TIMEOUT_MS', 5_000),
  maxStaleMs: positiveInteger('MAX_STALE_MS', 5 * 60_000),
  store,
})
const server = createFlagProxyServer({
  adminToken,
  cache,
})

await cache.get().catch((error) => {
  console.warn(`Initial flag configuration fetch failed; readiness remains false: ${error.message}`)
})

server.listen(port, host, () => {
  console.log(`Datadog flag proxy listening on http://${host}:${port}`)
})

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => server.close(async () => {
    await cache.close()
    process.exit(0)
  }))
}

function required(name) {
  const value = process.env[name]?.trim()
  if (!value) throw new Error(`${name} is required`)
  return value
}

async function secret(name) {
  const file = process.env[`${name}_FILE`]?.trim()
  if (file) {
    const value = (await readFile(file, 'utf8')).trim()
    if (!value) throw new Error(`${name}_FILE is empty`)
    return value
  }
  return required(name)
}

function positiveInteger(name, fallback) {
  const raw = process.env[name]
  if (raw === undefined) return fallback
  const value = Number(raw)
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${name} must be a positive integer`)
  }
  return value
}

