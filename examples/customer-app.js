import { readFile } from 'node:fs/promises'
import { channel } from 'node:diagnostics_channel'
import { createServer } from 'node:http'
import { fileURLToPath } from 'node:url'
import { OpenFeature } from '@openfeature/server-sdk'
import tracer from 'dd-trace'

tracer.init({ startupLogs: false })

// Accessing tracer.openfeature starts the SDK poller. With the custom base URL
// below, configuration is fetched from the customer proxy and evaluations stay
// in this process.
await OpenFeature.setProviderAndWait(tracer.openfeature)

const client = OpenFeature.getClient('proxy-demo')
const flagKey = required('FLAG_KEY')
const port = Number(process.env.APP_PORT || 3000)
const host = process.env.APP_HOST || '127.0.0.1'
const proxyUrl = new URL(required('DD_FEATURE_FLAGS_CONFIGURATION_SOURCE_AGENTLESS_BASE_URL'))
const proxyAdminToken = await secret('PROXY_ADMIN_TOKEN')
const dashboardHtml = await readFile(
  fileURLToPath(new URL('./dashboard.html', import.meta.url)),
  'utf8'
)
const startedAt = Date.now()
let evaluationCount = 0
let exposureEventsEmitted = 0
const exposureChannel = channel('ffe:exposure:submit')
const countExposures = (events) => {
  exposureEventsEmitted += Array.isArray(events) ? events.length : 1
}
exposureChannel.subscribe(countExposures)

const server = createServer(async (request, response) => {
  const url = new URL(request.url, 'http://app.local')

  if (url.pathname === '/dashboard') {
    response.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Content-Security-Policy': "default-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'",
      'X-Content-Type-Options': 'nosniff',
    })
    response.end(dashboardHtml)
    return
  }

  if (url.pathname === '/_stats') {
    sendJson(response, 200, applicationStats())
    return
  }

  if (url.pathname === '/api/dashboard') {
    try {
      const proxyResponse = await fetch(new URL('/_stats', proxyUrl), {
        headers: { Authorization: `Bearer ${proxyAdminToken}` },
      })
      if (!proxyResponse.ok) throw new Error(`Proxy returned HTTP ${proxyResponse.status}`)
      sendJson(response, 200, {
        application: applicationStats(),
        proxy: await proxyResponse.json(),
      })
    } catch (error) {
      sendJson(response, 502, { error: error.message })
    }
    return
  }

  if (url.pathname !== '/' && url.pathname !== '/api/evaluate') {
    response.writeHead(404).end()
    return
  }

  sendJson(response, 200, await evaluate(url.searchParams.get('user') || 'anonymous'))
})

server.listen(port, host, () => {
  console.log(`Example app: http://${host}:${port}/?user=customer-123`)
  console.log(`Live dashboard: http://${host}:${port}/dashboard`)
})

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => server.close(async () => {
    exposureChannel.unsubscribe(countExposures)
    await OpenFeature.close()
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

async function evaluate(targetingKey) {
  const details = await client.getBooleanDetails(flagKey, false, { targetingKey })
  evaluationCount++
  return {
    exposureEligible: details.flagMetadata?.__dd_do_log === true,
    flagKey,
    reason: details.reason,
    targetingKey,
    value: details.value,
    variant: details.variant,
  }
}

function applicationStats() {
  const uptimeSeconds = Math.max(0.001, (Date.now() - startedAt) / 1000)
  return {
    averageEvaluationsPerSecond: evaluationCount / uptimeSeconds,
    evaluationCount,
    exposureEventsEmitted,
    uptimeSeconds,
  }
}

function sendJson(response, status, value) {
  response.writeHead(status, {
    'Cache-Control': 'no-store',
    'Content-Type': 'application/json',
    'X-Content-Type-Options': 'nosniff',
  })
  response.end(JSON.stringify(value))
}
