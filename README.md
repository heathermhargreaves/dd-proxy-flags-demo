# Datadog server-side Feature Flag proxy

Customer-facing reference implementation for reducing Datadog server-side
[Monthly Flag Configuration Requests (MFCRs)](https://docs.datadoghq.com/feature_flags/concepts/monthly_flag_configuration_requests/).
A customer-owned proxy caches Universal Flag Configuration (UFC), while
applications continue to evaluate flags locally using a Datadog
[server SDK](https://docs.datadoghq.com/feature_flags/server/nodejs/).

```text
                         configuration
Application SDKs ─────────────────────────> customer proxy/cache ──> Datadog CDN
       │
       ├── local flag evaluation
       │
       └── feature_flag.evaluations ──────> Datadog Agent OTLP ───> Datadog
```

The configuration path and telemetry path are independent. The proxy does not
evaluate flags and does not receive evaluation metrics.

## Supported Datadog flag client integration

This proxy is for **server-side Datadog Feature Flag SDKs** that support a
[custom agentless configuration endpoint](https://docs.datadoghq.com/feature_flags/concepts/configuration_sources/#use-a-custom-agentless-endpoint).
This is the documented integration method for an operator-managed proxy:

```sh
DD_FEATURE_FLAGS_CONFIGURATION_SOURCE=agentless
DD_FEATURE_FLAGS_CONFIGURATION_SOURCE_AGENTLESS_BASE_URL=https://flags.example.com
```

When the URL contains only an origin or root path, the SDK appends:

```text
/api/v2/feature-flagging/config/rules-based/server
```

That is the endpoint implemented by this repository. A non-root URL is treated
by the SDK as the complete configuration endpoint, which also supports an API
gateway or ingress path:

```sh
DD_FEATURE_FLAGS_CONFIGURATION_SOURCE_AGENTLESS_BASE_URL=https://gateway.example.com/internal/flag-config
```

The SDK never forwards `DD_API_KEY` to a custom endpoint. The API key belongs
only in this proxy, which adds it when requesting configuration from Datadog.
Use HTTPS for every non-local proxy URL.

The following settings can tune SDK-to-proxy polling independently of the
proxy-to-Datadog cache interval:

```sh
DD_FEATURE_FLAGS_CONFIGURATION_SOURCE_AGENTLESS_POLL_INTERVAL_SECONDS=30
DD_FEATURE_FLAGS_CONFIGURATION_SOURCE_AGENTLESS_REQUEST_TIMEOUT_SECONDS=5
```

Other approaches have different behavior:

- **Agentless custom endpoint:** Supported by this implementation and
  recommended for a customer-owned caching proxy.
- **Agent Remote Configuration source:** Does not use this proxy. The SDK gets
  configuration from the Datadog Agent instead.
- **Generic outbound HTTP proxy:** Can control network egress, but does not
  automatically provide the shared UFC cache, request coalescing, or MFCR
  reduction implemented here.
- **Client-side SDKs:** Are outside this implementation. Do not expose the
  proxy's Datadog API key to browsers or mobile clients.
- **Evaluation metrics and experiment exposures:** Use their own telemetry
  paths and must not be routed to the configuration endpoint.

## Why this reduces MFCR

Every application SDK can poll the private proxy as frequently as needed.
Only a cache refresh causes a request to the Datadog CDN:

```text
upstream requests ≈ time period / CACHE_TTL_MS
billable server MFCR = upstream requests × 10
```

For example, one continuously running cache namespace with a 30-second TTL
makes approximately 86,400 upstream requests in 30 days, or 864,000 estimated
billable server MFCR. A five-minute TTL reduces that estimate to 86,400 MFCR.
Choose the longest TTL compatible with the required flag-change propagation
time.

Application count does not increase upstream request volume when all instances
share the same cache. Multiple proxy replicas must use Redis so that they share
configuration and a distributed refresh lock.

## What the proxy provides

- Datadog API key injection only for requests to the Datadog CDN
- In-memory caching for a single replica
- Optional Redis cache and distributed refresh lock for multiple replicas
- ETag revalidation and concurrent-request coalescing
- Validated, bounded UFC responses
- Bounded last-known-good configuration during upstream failures
- Liveness, readiness, protected statistics, and Prometheus metrics
- No mock flag data

## Choose a deployment model

### Self-hosted or container service

Use this option for Kubernetes, ECS/Fargate, a VM, or a long-running container
service. The proxy runs unchanged with `npm start`.

- One replica can use the in-memory cache.
- Multiple replicas should use Redis to share configuration and coordinate
  refreshes.
- Applications send evaluation metrics directly to a reachable Datadog Agent.
- This provides the most predictable cache lifetime and upstream request rate.

Follow the production setup below.

### Cloud function or serverless environment

A serverless container service such as Cloud Run is preferred over a native
function runtime. It can run the existing Docker image and `npm start` without
an HTTP-handler rewrite.

For a serverless container:

1. Build and deploy the included Docker image.
2. Mount `DD_API_KEY_FILE` and `ADMIN_TOKEN_FILE` from the platform secret
   manager.
3. Set `DD_SITE`, `DD_ENV`, and `CACHE_TTL_MS`.
4. Configure a managed Redis instance with `REDIS_URL`. Redis is required when
   the service can scale beyond one instance.
5. Restrict ingress so only application workloads can reach the proxy.
6. Configure a minimum instance count if predictable cache warmth is important.
7. Point application SDKs at the service's stable HTTPS URL.

A native AWS Lambda, Google Cloud Function, or Azure Function cannot run this
repository unchanged because `src/server.js` starts a persistent Node.js HTTP
server. To use a native function runtime:

1. Wrap `createFlagProxyServer` in the platform's HTTP adapter or use a
   container/web adapter.
2. Use managed Redis for all configuration state and refresh locking.
3. Reuse clients outside the invocation handler so warm invocations retain
   connections.
4. Set function timeout and memory limits above `UPSTREAM_TIMEOUT_MS`.
5. Keep the function behind private networking or an authenticated gateway that
   the SDK can access transparently.

Cold starts and parallel instances without Redis each trigger independent CDN
refreshes and increase MFCR. Do not rely on in-memory cache state in a native
function.

Serverless application evaluations do not pass through this proxy. Configure
`DD_METRICS_OTEL_ENABLED=true` and use the platform's supported Datadog
serverless telemetry path. Only set `OTEL_EXPORTER_OTLP_ENDPOINT` when that
environment exposes a supported OTLP endpoint; do not point it at the proxy.
See [Send feature flag telemetry in serverless
environments](https://docs.datadoghq.com/feature_flags/implementation_patterns/serverless/).

## Self-hosted production setup

### 1. Store proxy secrets

The proxy needs a
[Datadog API key](https://docs.datadoghq.com/account_management/api-app-keys/)
from the same organization as the feature flags. It does not need an
application key.

Mount secrets as files from the customer's secret manager:

```sh
DD_API_KEY_FILE=/run/secrets/datadog_api_key
ADMIN_TOKEN_FILE=/run/secrets/flag_proxy_admin_token
```

`ADMIN_TOKEN_FILE` protects the proxy statistics and Prometheus endpoints.
Never commit either secret or bake it into an image.

### 2. Start the configuration proxy

```sh
DD_API_KEY_FILE=/run/secrets/datadog_api_key \
ADMIN_TOKEN_FILE=/run/secrets/flag_proxy_admin_token \
DD_SITE=datadoghq.com \
DD_ENV=production \
CACHE_TTL_MS=300000 \
HOST=0.0.0.0 \
PORT=8080 \
npm start
```

The SDK configuration URL is:

```text
http://flag-proxy:8080/api/v2/feature-flagging/config/rules-based/server
```

Keep this endpoint private. Datadog server SDK custom endpoints do not support
adding an arbitrary proxy authentication header.

### 3. Point applications at the proxy

For the
[Node.js Datadog OpenFeature provider](https://docs.datadoghq.com/feature_flags/server/nodejs/):

```sh
DD_ENV=production
DD_SERVICE=customer-service
DD_FEATURE_FLAGS_CONFIGURATION_SOURCE=agentless
DD_FEATURE_FLAGS_CONFIGURATION_SOURCE_AGENTLESS_BASE_URL=http://flag-proxy:8080
```

The SDK polls the proxy and evaluates flags in the application process.
Individual evaluations do not call the proxy or Datadog CDN.

#### Select a flag and return its variation

The proxy returns the complete UFC configuration; it does not receive a flag
key or choose a variation. The application passes its flag key and evaluation
context to the Datadog OpenFeature provider:

```js
const client = OpenFeature.getClient('customer-service')

const details = await client.getBooleanDetails(
  'my-server-flag',
  false,
  { targetingKey: 'customer-123' }
)

console.log(details.value)
console.log(details.variant)
```

- `'my-server-flag'` is the Datadog flag key.
- `false` is returned if the flag cannot be evaluated.
- `targetingKey` and any additional context attributes are evaluated against
  the targeting rules cached from Datadog.
- `details.value` is the selected flag value.
- `details.variant` identifies the selected Datadog variation.

This evaluation is local. It does not create another configuration request or
consume additional MFCR.

### 4. Enable the Agent OTLP receiver

Server evaluation counts are emitted as the experimental
`feature_flag.evaluations` metric over OTLP. They are not APM traces or
experiment exposure events. See [Set Up Server-Side Flag Evaluation
Metrics](https://docs.datadoghq.com/feature_flags/guide/server_flag_evaluation_metrics/)
for supported tracer versions and language-specific requirements.

Enable OTLP/HTTP in the Datadog Agent as described in Datadog's
[OTLP ingestion guide](https://docs.datadoghq.com/opentelemetry/setup/otlp_ingest_in_the_agent/):

```yaml
otlp_config:
  receiver:
    protocols:
      http:
        endpoint: 0.0.0.0:4318
```

For a Docker Agent, the equivalent environment variable is:

```sh
DD_OTLP_CONFIG_RECEIVER_PROTOCOLS_HTTP_ENDPOINT=0.0.0.0:4318
```

Bind to `127.0.0.1:4318` instead when the application and Agent share a host.
Ensure the Agent uses an API key from the same Datadog organization as the
feature flag.

### 5. Send server evaluations directly to the Agent

Configure each application process:

```sh
DD_METRICS_OTEL_ENABLED=true
OTEL_EXPORTER_OTLP_ENDPOINT=http://datadog-agent:4318
```

The Agent must be reachable from the application at that address. The proxy is
not part of this telemetry path.

Verify the metric in Datadog Metrics Explorer:

```text
feature_flag.evaluations
```

The flag page groups it using tags such as `feature_flag.key` and
`feature_flag.result.variant`. `doLog` may be `false`; that setting controls
experiment exposures, not server evaluation metrics.

## Optional: experiment exposures

Experiment exposures are separate from `feature_flag.evaluations`. They are
emitted only when the evaluated allocation has `doLog: true`.

The recommended Agent-backed configuration is:

```sh
EXPOSURE_DELIVERY=agent
DD_TRACE_AGENT_URL=http://datadog-agent:8126
```

The tracer sends exposures through the Agent Event Platform Proxy. Port `8126`
is the standard APM/EVP port; customers with a customized Agent must use its
configured trace receiver port.

For environments without a compatible Agent/EVP path, the demo also supports
`EXPOSURE_DELIVERY=direct`. That mode supplies the API key to the application
at runtime and sends exposures directly to Datadog. Prefer Agent delivery so
application processes do not need the API key.

## Run the local demonstration

Install dependencies:

```sh
npm install
```

Create local secret files without committing them:

```text
.secrets/datadog_api_key
.secrets/flag_proxy_admin_token
```

If a local Agent is already configured for the correct Datadog organization,
enable its OTLP receiver and use `http://127.0.0.1:4318`.

For a macOS demonstration where the installed Agent cannot be modified, run
the included user-owned Agent in a separate terminal:

```sh
npm run agent:start
```

It reads `.secrets/datadog_api_key` through the Agent file secret backend and
listens on `127.0.0.1:14318`. It does not modify the system Agent or require
administrator privileges.

Start the proxy and sample application:

```sh
DD_API_KEY_FILE="$PWD/.secrets/datadog_api_key" \
ADMIN_TOKEN_FILE="$PWD/.secrets/flag_proxy_admin_token" \
DD_SITE=datadoghq.com \
DD_ENV=production \
DD_SERVICE=flag-proxy-poc \
FLAG_KEY=my-server-flag \
EVALUATION_METRICS=agent \
OTEL_EXPORTER_OTLP_ENDPOINT=http://127.0.0.1:14318 \
EXPOSURE_DELIVERY=agent \
npm run demo:start
```

Open `http://127.0.0.1:3000/dashboard`. The dashboard can generate continuous
local evaluations and displays SDK polls, Datadog CDN requests, estimated
billable MFCR, cache health, and optional exposure counts.

## Multiple proxy replicas

The default in-memory cache is appropriate for one proxy process. Configure
Redis for a shared cache:

```sh
REDIS_URL=redis://redis.internal:6379
REDIS_PREFIX=datadog-flag-proxy:production
```

Use a distinct prefix for each Datadog site and Feature Flags environment.
Without Redis, each proxy replica independently refreshes the CDN and increases
MFCR.

## Health and operational metrics

Liveness is public:

```sh
curl http://127.0.0.1:8080/livez
```

Readiness returns HTTP 503 until usable configuration is available:

```sh
curl http://127.0.0.1:8080/readyz
```

Statistics and Prometheus metrics require the administration token:

```sh
curl --header "Authorization: Bearer $(cat /run/secrets/flag_proxy_admin_token)" \
  http://127.0.0.1:8080/_stats

curl --header "Authorization: Bearer $(cat /run/secrets/flag_proxy_admin_token)" \
  http://127.0.0.1:8080/metrics
```

Do not expose these administration endpoints publicly.

## Configuration reference

Required:

- `DD_API_KEY` or `DD_API_KEY_FILE`: Datadog API key used by the proxy
- `ADMIN_TOKEN` or `ADMIN_TOKEN_FILE`: protects operational endpoints
- `DD_ENV`: Datadog Feature Flags environment

Optional:

- `DD_SITE`: defaults to `datadoghq.com`
- `HOST`: defaults to `127.0.0.1`
- `PORT`: defaults to `8080`
- `CACHE_TTL_MS`: defaults to `30000`
- `MAX_STALE_MS`: defaults to `300000`
- `UPSTREAM_TIMEOUT_MS`: defaults to `5000`
- `REDIS_URL`: enables the shared cache and distributed refresh lock
- `REDIS_PREFIX`: isolates shared cache entries

The worst-case normal flag-change propagation delay is approximately the proxy
cache TTL plus the SDK polling interval.

## Datadog documentation

- [Datadog documentation](https://docs.datadoghq.com/)
- [Monthly Flag Configuration Requests](https://docs.datadoghq.com/feature_flags/concepts/monthly_flag_configuration_requests/)
- [Set Up Server-Side Flag Evaluation Metrics](https://docs.datadoghq.com/feature_flags/guide/server_flag_evaluation_metrics/)
- [OTLP Ingestion by the Datadog Agent](https://docs.datadoghq.com/opentelemetry/setup/otlp_ingest_in_the_agent/)
- [Server SDK configuration sources](https://docs.datadoghq.com/feature_flags/concepts/configuration_sources/)
- [Node.js server-side Feature Flags](https://docs.datadoghq.com/feature_flags/server/nodejs/)
- [API and application keys](https://docs.datadoghq.com/account_management/api-app-keys/)
- [Agent secrets management](https://docs.datadoghq.com/agent/configuration/secrets-management/)
