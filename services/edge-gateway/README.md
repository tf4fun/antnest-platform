# Edge Gateway

Edge Gateway is the single external application entry of Antnest Platform. It
turns an Identity Service access credential into one trusted internal principal
and routes the request to the owning service without owning the requested
business operation. It is written in Go.

The Gateway owns the browser credential boundary: cookies, CSRF, same-origin
checks and identity revalidation. Every other service receives only trusted
identity headers that the Gateway sets after verification; browser-supplied
identity headers, cookies and access tokens never reach internal services.

## Responsibilities

- Public HTTP listener and route policy.
- Browser cookie and CSRF policy.
- Access-token resolution and administrator admission.
- Bounded login admission before Identity performs password verification.
- Browser OIDC discovery, start and callback, and transparent SCIM protocol
  ingress to Identity.
- Metadata-only Agent workspace discovery (`GET /api/app/bootstrap`); ACP owns
  per-Agent access decisions.
- Authenticated workspace state snapshots and subscriptions with bounded leases.
- Same-origin ACP v1/v2 WebSocket routing with per-message browser session
  revalidation, and ACP v1 Streamable HTTP routing with per-request browser
  authentication.
- Scoped Agent UI proxy through `ANTNEST_AGENT_UI_URL`: `/workspace/` HTML,
  hashed assets, and the Workspace HTTP/SSE API with leased SSE observation.
- Trusted principal headers, security headers, request limits and tracing.
- Proxy availability and external error projection.

## Non-responsibilities

- Users, organizations, credentials or authorization facts (Identity Service).
- Models, Templates, Agents, lifecycle operations or Runtime state (Agent
  Controller and Runtime Controller).
- Admin Console page state or view aggregation.
- ACP Session state, messages, model execution or Tool dispatch (Agent ACP
  Service).
- Any PostgreSQL schema. The Gateway has no database, migration, backup or
  persistent volume.

## Interfaces

| Direction | Interface | Purpose |
| --- | --- | --- |
| Inbound | `/api/session`, `/api/session/login`, `/api/session/login-methods`, `/api/session/oidc/start`, `GET /protocol/oidc/callback` | Browser session read, login, logout (`DELETE /api/session`) and OIDC; see the [session contract](../../contracts/edge-gateway/session-contract.json) |
| Inbound | `/scim/v2/*` | Protocol-preserving SCIM proxy to Identity |
| Inbound | `/api/admin/*` and Console application | Administrator-only BFF routes forwarded to Admin Console with CSRF checks |
| Inbound | `GET /api/app/bootstrap` | Principal display facts and accessible Agent IDs and names |
| Inbound | `/api/app/agents/{agent_id}/state`, `/state/watch` | [Workspace state](docs/workspace-state.md) snapshot and SSE watch |
| Inbound | `/api/app/agents/{agent_id}/v1/acp`, `/v2/acp`, `/acp` (v1 alias) | ACP WebSocket (v1 and v2) and v1 Streamable HTTP relay |
| Inbound | `/workspace/*`, `/api/app/workspace/v1/*` | Agent UI HTML, assets and Workspace HTTP/SSE API |
| Inbound | `GET /status` | Local readiness only; it never probes another service |
| Outbound | Identity Service RPC | Login, token resolution, revocation, OIDC |
| Outbound | Agent Controller RPC | Principal-scoped Agent ID/name discovery only |
| Outbound | Agent ACP Service | ACP protocol traffic and execution-state reads/watches |
| Outbound | Admin Console, Agent UI | Reverse-proxied application traffic |

All other service interfaces are private deployment details. ACP HTTP and
WebSocket behavior is described in [Architecture](docs/architecture.md).

## Configuration

| Variable | Required | Default | Description |
| --- | --- | --- | --- |
| `ANTNEST_EDGE_LISTEN` | no | `:8080` | HTTP listen address; the container health check uses its port |
| `ANTNEST_IDENTITY_SERVICE_URL` | yes | - | Identity Service base URL (absolute HTTP(S), no query or fragment) |
| `ANTNEST_ADMIN_CONSOLE_URL` | yes | - | Admin Console base URL |
| `ANTNEST_AGENT_UI_URL` | yes | - | Agent UI Node service base URL for `/workspace/` HTML, hashed assets and the Workspace HTTP/SSE API |
| `ANTNEST_AGENT_CONTROLLER_URL` | yes | - | Agent Controller base URL, used for ID/name discovery only |
| `ANTNEST_AGENT_ACP_URL` | yes | - | Agent ACP Service base URL |
| `ANTNEST_EDGE_COOKIE_SECURE` | no | `true` | Issue `Secure` cookies; set `false` only for plain-HTTP development |
| `ANTNEST_EDGE_REQUEST_TIMEOUT` | no | `10s` | Deadline for non-streaming dependency calls and forwarded admin requests |
| `ANTNEST_EDGE_STREAM_LEASE` | no | `5m` | Maximum lifetime of an authenticated SSE observation |
| `ANTNEST_EDGE_LOGIN_WINDOW` | no | `5m` | In-memory login admission window |
| `ANTNEST_EDGE_LOGIN_SOURCE_MAX` | no | `30` | Login attempts per source per window |
| `ANTNEST_EDGE_LOGIN_ACCOUNT_MAX` | no | `10` | Login attempts per normalized account per window |
| `ANTNEST_EDGE_SHUTDOWN_TIMEOUT` | no | `15s` | Graceful drain budget for ordinary HTTP requests |
| `ANTNEST_ENVIRONMENT` | no | empty | Deployment environment resource attribute for telemetry |
| `OTEL_*` | no | - | Standard OpenTelemetry SDK settings (`OTEL_SERVICE_NAME`, `OTEL_SDK_DISABLED`, `OTEL_TRACES_EXPORTER`, `OTEL_EXPORTER_OTLP_ENDPOINT`, `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT`) |

Durations use Go duration syntax and must be positive. The 10-second request
timeout bounds forwarded admin requests and is shorter than Admin Console's
15-second dependency timeout (`ANTNEST_ADMIN_DEPENDENCY_TIMEOUT`), so a slow
Console dependency surfaces as a Gateway `503` first. Raise both together if
needed. See [Operations](docs/operations.md) for TLS, shutdown and capacity
notes.

## Dependencies

- Identity Service: required for login, every authenticated request and
  per-message revalidation. Unavailability denies access with `503` without
  clearing browser cookies.
- Admin Console: required for administrator routes.
- Agent Controller: required only for first-load workspace discovery. ACP
  protocol and state traffic never depends on it.
- Agent ACP Service: required for ACP protocol traffic and workspace state.
- Agent UI: required for `/workspace/*` and the Workspace API.
- OTLP collector: optional, when trace export is configured.

`GET /status` reports only Gateway readiness. Downstream outages are reported by
the affected business request.

## Build and test

Commands run from the repository root unless stated.

```sh
# Unit and component tests (from services/edge-gateway)
GOWORK=off go test ./...

# Lint all Go services
make go-lint

# HTTP/TCP stream shutdown integration tests
node tests/integration/go/run.mjs edge-gateway

# Docker image (build context is the repository root)
docker build -f services/edge-gateway/Dockerfile -t antnest/edge-gateway:local .

# Docker signal regression for long-lived receive streams
node tests/e2e/edge-gateway/shutdown-docker.mjs
```

Integration sources live in
[`tests/integration/go/edge-gateway`](../../tests/integration/go/edge-gateway).
Root targets: `make test-go-unit`, `make test-go` and `make test-integration-go`
include the Gateway;
`make e2e-stage3` runs the real-stack
[Identity end-to-end client](../../tests/e2e/identity-closeout/README.md)
through the public entry (browser HTTP and ACP v1/v2 logout revocation, SCIM
provisioning, OIDC, Console projections and causal Jaeger spans);
`make e2e-acp-session` covers post-upgrade expiry, dependency outage and
recovery, and durable Run completion after logout or disconnect.

## Documentation

- [Architecture](docs/architecture.md) - request pipeline, OIDC binding, ACP relay and failure semantics.
- [Operations](docs/operations.md) - configuration, diagnostics, shutdown, capacity and deployment limits.
- [Workspace state](docs/workspace-state.md) - bootstrap and execution-state observation contract.
- [Execution boundary](docs/execution-boundary.md) - Controller and ACP ownership split.
- [Session contract](../../contracts/edge-gateway/session-contract.json) - public browser session interface.
- [Platform observability contract](../../docs/observability-contract.md).
- [Stage 3 admin control plane](../../docs/stage-3-admin-control-plane.md) - cross-service behavior.
