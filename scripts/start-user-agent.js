import { spawn } from 'node:child_process'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'

const projectRoot = path.resolve(import.meta.dirname, '..')
const secretPath = path.join(projectRoot, '.secrets', 'datadog_api_key')
const runtimeDirectory = path.join(projectRoot, '.runtime', 'datadog-agent')
const agentBinary = '/opt/datadog-agent/bin/agent/agent'
const otlpPort = process.env.LOCAL_AGENT_OTLP_PORT || '14318'

if (!(await readFile(secretPath, 'utf8')).trim()) {
  throw new Error(`${secretPath} is empty`)
}

await mkdir(path.join(runtimeDirectory, 'conf.d'), { recursive: true })

const configuration = `\
api_key: "ENC[datadog_api_key]"
site: ${process.env.DD_SITE || 'datadoghq.com'}
hostname: dd-flag-proxy-local

secret_backend_type: file.text
secret_backend_config:
  secrets_path: ${JSON.stringify(path.dirname(secretPath))}

cmd_port: 15051
expvar_port: 15050
GUI_port: -1
run_path: ${JSON.stringify(path.join(runtimeDirectory, 'run'))}
log_file: ${JSON.stringify(path.join(runtimeDirectory, 'agent.log'))}
logs_enabled: false
use_dogstatsd: false

apm_config:
  enabled: false
process_config:
  process_collection:
    enabled: false

otlp_config:
  receiver:
    protocols:
      http:
        endpoint: 127.0.0.1:${otlpPort}
`

await writeFile(path.join(runtimeDirectory, 'datadog.yaml'), configuration, {
  mode: 0o600,
})

console.log(`User Agent OTLP endpoint: http://127.0.0.1:${otlpPort}`)
console.log('The API key is resolved from .secrets and is not copied into the config.')

const agent = spawn(agentBinary, ['run', '--cfgpath', runtimeDirectory], {
  env: { ...process.env, DD_LOG_TO_CONSOLE: 'false' },
  stdio: 'inherit',
})

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => agent.kill(signal))
}

agent.on('exit', (code, signal) => {
  if (signal) process.kill(process.pid, signal)
  process.exit(code ?? 1)
})
