import { spawn } from 'node:child_process'
import { readFile } from 'node:fs/promises'

required('DD_ENV')
required('FLAG_KEY')
requiredSecret('DD_API_KEY')
requiredSecret('ADMIN_TOKEN')

const proxyPort = process.env.PORT || '8080'
const appPort = process.env.APP_PORT || '3000'
const proxyUrl = `http://127.0.0.1:${proxyPort}`
const exposureDelivery = process.env.EXPOSURE_DELIVERY || 'agent'
const evaluationMetrics = process.env.EVALUATION_METRICS ||
  (process.env.OTEL_EXPORTER_OTLP_ENDPOINT ? 'agent' : 'disabled')
const children = []
let stopping = false

if (!['agent', 'direct'].includes(exposureDelivery)) {
  throw new Error('EXPOSURE_DELIVERY must be agent or direct')
}
if (!['agent', 'disabled'].includes(evaluationMetrics)) {
  throw new Error('EVALUATION_METRICS must be agent or disabled')
}
if (evaluationMetrics === 'agent') required('OTEL_EXPORTER_OTLP_ENDPOINT')

const proxy = start('proxy', ['src/server.js'], process.env)
children.push(proxy)

await waitUntilReady(`${proxyUrl}/readyz`, 20_000)

const {
  ADMIN_TOKEN: _adminToken,
  ADMIN_TOKEN_FILE: _adminTokenFile,
  DD_API_KEY: _apiKey,
  DD_API_KEY_FILE: _apiKeyFile,
  ...safeAppEnvironment
} = process.env
const appEnv = {
  ...safeAppEnvironment,
  DD_FEATURE_FLAGS_CONFIGURATION_SOURCE: 'agentless',
  DD_FEATURE_FLAGS_CONFIGURATION_SOURCE_AGENTLESS_BASE_URL: proxyUrl,
  PROXY_ADMIN_TOKEN: process.env.ADMIN_TOKEN,
  PROXY_ADMIN_TOKEN_FILE: process.env.ADMIN_TOKEN_FILE,
}
if (exposureDelivery === 'direct') {
  appEnv.DD_API_KEY = await secret('DD_API_KEY')
}
if (evaluationMetrics !== 'disabled') {
  appEnv.DD_METRICS_OTEL_ENABLED = 'true'
  appEnv.OTEL_EXPORTER_OTLP_ENDPOINT = process.env.OTEL_EXPORTER_OTLP_ENDPOINT
}
const app = start('app', ['examples/customer-app.js'], appEnv)
children.push(app)

console.log(`\nCustomer dashboard: http://127.0.0.1:${appPort}/dashboard`)
console.log(`Exposure delivery: ${exposureDelivery}`)
console.log(`Server evaluation metrics: ${evaluationMetrics}`)
console.log('Press Ctrl+C to stop the demo.\n')

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => stop(signal))
}

function start(name, args, env) {
  const child = spawn(process.execPath, args, {
    env,
    stdio: 'inherit',
  })
  child.on('exit', (code, signal) => {
    if (!stopping) {
      console.error(`${name} exited unexpectedly (${signal || code})`)
      stop('SIGTERM')
    }
  })
  return child
}

async function waitUntilReady(url, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      if ((await fetch(url)).ok) return
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  stop('SIGTERM')
  throw new Error(`Proxy did not become ready within ${timeoutMs}ms`)
}

function stop(signal) {
  if (stopping) return
  stopping = true
  for (const child of children) {
    if (!child.killed) child.kill(signal)
  }
}

function required(name) {
  if (!process.env[name]?.trim()) throw new Error(`${name} is required`)
}

function requiredSecret(name) {
  if (!process.env[name]?.trim() && !process.env[`${name}_FILE`]?.trim()) {
    throw new Error(`${name} or ${name}_FILE is required`)
  }
}

async function secret(name) {
  const file = process.env[`${name}_FILE`]?.trim()
  if (file) {
    const value = (await readFile(file, 'utf8')).trim()
    if (!value) throw new Error(`${name}_FILE is empty`)
    return value
  }
  const value = process.env[name]?.trim()
  if (!value) throw new Error(`${name} is required`)
  return value
}
