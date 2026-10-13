# Edge Gateway

Edge Gateway is the single external application entry of Antnest Platform. It
turns an Identity Service access credential into one trusted internal principal
and routes the request to the owning service without owning the requested
business operation. It is written in Go.

The Gateway owns the browser credential boundary: cookies, CSRF, same-origin
checks and identity revalidation. Internal dependencies receive verified
workload authentication and the unchanged Identity-signed caller context.
Browser-supplied authentication/identity headers and cookies are removed;
presentation hints are regenerated from the verified principal. User access
tokens reach only Identity's authenticated credential RPCs.

Every HTTP proxy applies the route-specific
[request header allowlist](../../contracts/edge-gateway/request-headers.md),
discards browser trailers and injects verified identity after hop-by-hop filtering.
The reserved-prefix rule covers both `X-Antnest-*` and `Antnest-*`, including
unknown future fields.

Internal token/mTLS verification and outbound transport use the
[shared Go module](../../modules/service-authentication/README.md), with the
Gateway forwarding policy for its verified presentation hints and SCIM bearer.
Gateway still owns browser credential stripping and route authorization.

## Responsibilities

- Public HTTP listener and route policy.
- Browser cookie and CSRF policy.
- Current-account, password rotation, explicit activity and self-session controls.
- Access-token resolution and administrator admission.
- Separate bounded password and OIDC-source admission before calling Identity.
- Browser OIDC discovery, start and callback, and transparent SCIM protocol
  ingress to Identity.
- Metadata-only Agent workspace discovery (`GET /api/app/bootstrap`); ACP owns
  per-Agent access decisions.
- Authenticated workspace state snapshots and subscriptions with bounded leases.
- Same-origin ACP v1/v2 WebSocket and ACP v1 Streamable HTTP routing, with
  bounded live browser-session checks on quiet streams and per-message admission.
- Scoped Agent UI proxy through `ANTNEST_AGENT_UI_URL`: `/workspace/` HTML,
  hashed assets, and the Workspace HTTP/SSE API with leased SSE observation.
- Per-dependency workload credentials, route-selected caller context, verified
  presentation headers, security headers, request limits and tracing.
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

| Direction | Interface                                                                                                                                                   | Purpose                                                                                                                                              |
| --------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| Inbound   | `/api/session`, `/api/session/login`, `/api/session/login-methods`, `/api/session/oidc/start`, `GET /protocol/oidc/callback`                                | Browser session read, login, logout (`DELETE /api/session`) and OIDC; see the [session contract](../../contracts/edge-gateway/session-contract.json) |
| Inbound   | `/api/session/account`, `/api/session/password`, `/api/session/activity`, `/api/session/sessions`, `/api/session/sessions/revoke`                           | Current account, password rotation, explicit user activity, self inventory and revocation                                                            |
| Inbound   | `GET /api/session/external-identities`, `DELETE /api/session/external-identities/{binding_id}`, `POST /api/session/external-identities/notices/acknowledge` | Self binding inventory, explicit unbind and individual notice acknowledgment                                                                         |
| Inbound   | `/scim/v2/*`                                                                                                                                                | Protocol-preserving SCIM proxy to Identity                                                                                                           |
| Inbound   | `/api/admin/*` and Console application                                                                                                                      | Administrator-only BFF routes forwarded to Admin Console with CSRF checks                                                                            |
| Inbound   | `GET /api/app/bootstrap`                                                                                                                                    | Principal display facts and accessible Agent IDs and names                                                                                           |
| Inbound   | `/api/app/agents/{agent_id}/state`, `/state/watch`                                                                                                          | [Workspace state](docs/workspace-state.md) snapshot and SSE watch                                                                                    |
| Inbound   | `/api/app/agents/{agent_id}/v1/acp`, `/v2/acp`, `/acp` (v1 alias)                                                                                           | ACP WebSocket (v1 and v2) and v1 Streamable HTTP relay                                                                                               |
| Inbound   | `/workspace/*`, `/api/app/workspace/v1/*`                                                                                                                   | Agent UI HTML, assets and Workspace HTTP/SSE API                                                                                                     |
| Inbound   | `GET /status`                                                                                                                                               | Local readiness only; it never probes another service                                                                                                |
| Outbound  | Identity Service RPC                                                                                                                                        | Login, non-touch resolution, account/session controls, OIDC and the private session-revocation feed                                                  |
| Outbound  | Agent Controller RPC                                                                                                                                        | Principal-scoped Agent ID/name discovery only                                                                                                        |
| Outbound  | Agent ACP Service                                                                                                                                           | ACP protocol traffic and execution-state reads/watches                                                                                               |
| Outbound  | Admin Console, Agent UI                                                                                                                                     | Reverse-proxied application traffic                                                                                                                  |

All other service interfaces are private deployment details. ACP HTTP and
WebSocket behavior is described in [Architecture](docs/architecture.md).

Identity supplies absolute and idle deadlines plus an activity scheduling hint.
Ordinary requests and stream checks never extend idle expiry; only the explicit
Origin/CSRF-admitted activity route does. Gateway writes session/CSRF cookies on
login, OIDC completion, password rotation and logout, using absolute expiry.
Ordinary 401 responses, SSR rejection, activity and revocation preserve cookies.
See the [browser lifecycle contract](../../contracts/identity/browser-sessions.md)
for the logout matrix, password recovery and consumer integration.

Gateway consumes Identity revision 18's password admission failures, external
identity controls and existing private revocation feed. Its bounded Resolve cache defaults to
10 seconds, clips every snapshot to the original session and CCT deadlines,
and bypasses cached authority until the feed proves catch-up. Scope includes
the exact token hash, server-owned audience profile and Agent. TTL zero restores
direct resolution. See the [cache contract](../../contracts/edge-gateway/resolve-cache.md)
and [operations guide](docs/operations.md) for capacity, outages and diagnostics.
Successful activity retires old cache observations while preserving already
attached live readers within their original deadlines and security checks.
Subsequent reads resolve again; obsolete results cannot refill the cache.

Login and password change validate Identity's complete status, body and single
`Retry-After` value before returning `429 credential_rate_limited` (1–900
seconds) or `503 credential_busy` (1 second). Both responses have the fixed
public message, `retryable: true`, `no-store` and no Cookie writes. Invalid
metadata produces `503 identity_unavailable` without a retry hint; neither path
replays the password request. Edge `login_rate_limited` keeps its separate
429 response contract. Console user creation also consumes Identity's typed busy response.
The HTTPS integration suite verifies real KDF rejection, unchanged browser
Cookies and durable state, and explicit recovery through all three routes.

Gateway revision 23 login admission uses independent password-source,
password-account and OIDC-source tables, each configurable with a default
capacity of 65,536 keys.
OIDC has no organization/provider account bucket. The limiter groups IPv6 by
`/64`, retains fixed-size digests and evicts the earliest fixed window at
capacity. Retained exhausted keys still reject without changing any table.
One counter records each admission decision with only flow/outcome labels.
See the [login admission contract](../../contracts/edge-gateway/login-admission.md)
and [operations guide](docs/operations.md#state-limits-and-capacity) for defaults,
eviction tradeoffs and the independent Identity password controls. Consumer
catalog references are synchronized; #2 completed the real two-client
HTTPS/OIDC gate. Its admission and evidence limits are recorded in the
[global TODO](../../TODO.md).

Periodic stream checks discard a cache hit that was valid when the check
started but crossed only its TTL during delivery. They may resolve once more
within that same check's context and deadline. The expired hit cannot renew
authority, and session expiry, the original WebSocket CCT and the independent
stale-output timer remain enforced throughout the recheck. Initial requests
and ACP message admission keep their existing rejection behavior.

Self inventory includes the User's bindings across organizations and independently
paginated immutable notices. Unbind and notice acknowledgment enforce the same
Origin/session-bound CSRF boundary; all three routes use `no-store` and preserve
cookies, including a successful unbind that revokes the current session. Gateway
forwards the verified session CCT and derives self scope and actor locally.
It does not offer browser binding creation or a Provider chooser. See the
[OIDC linking contract](../../contracts/identity/oidc-linking.md).
Console and Agent UI consumption and the real HTTPS linking workflow were
delivered with #61. The #59 Trace/display consumer batch and real HTTPS
outage/load integration are also admitted; the [global TODO](../../TODO.md)
records their evidence and retained diagnostic limits.

Browser login and session principals preserve Identity's required Organization
slug/name. Gateway projects these display facts to the active Node Workspace
API and SSR as verified UTF-8 Base64URL headers; see
[Organization projection](../../contracts/agent-ui/organization-projection.md).
The complete Principal uses the bounded Resolve snapshot. A rename becomes
visible on the next real session/bootstrap/SSR read after snapshot expiry,
including that request's latency, without changing authorization scope. Organization display delivery
[#92](https://github.com/tf4fun/antnest-platform/issues/92) and
[#93](https://github.com/tf4fun/antnest-platform/issues/93) are complete. The
workload/CCT deployment and integration admissions are recorded in the
[authentication rollout ledger](../../contracts/platform/service-authentication-rollout.json).
Console and Agent UI consume the session lifecycle; `make e2e-browser-sessions-https`
checks their shared HTTPS password, revocation and idle behavior. The unused legacy
`/api/app/bootstrap` projection is unchanged, pending
[#64](https://github.com/tf4fun/antnest-platform/issues/64).

## Configuration

Internal dependencies additionally require the exact shared
[service-authentication configuration](../../contracts/edge-gateway/service-authentication.md).
Token mode requires Gateway's read-only callers file (normally `{}`) and five
separate outgoing credential files. No mode is selected by default, and an
invalid or missing credential prevents startup. HTTPS pins each dependency's
DNS name and service URI; HTTP requires the explicit disposable-development
opt-in. Public Gateway readiness probes the local listener with HTTP or verified
HTTPS according to its configured transport.

Authenticated dependency requests and ACP WebSocket handshakes disable
environment/default-transport proxies. Service tokens and signed caller
context are sent directly to the configured service origin.

| Variable                                                   | Required                    | Default      | Description                                                                                                                                                                 |
| ---------------------------------------------------------- | --------------------------- | ------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ANTNEST_EDGE_LISTEN`                                      | no                          | `:8080`      | HTTP or native HTTPS address; local health follows the configured host and port.                                                                                            |
| `ANTNEST_EDGE_PUBLIC_ORIGIN`                               | except direct loopback HTTP | -            | canonical browser origin; HTTPS outside literal loopback addresses                                                                                                          |
| `ANTNEST_EDGE_TLS_CERT_FILE` / `ANTNEST_EDGE_TLS_KEY_FILE` | together                    | -            | public native TLS pair; rotate with SIGHUP without closing existing connections                                                                                             |
| `ANTNEST_EDGE_TLS_CA_FILE`                                 | no                          | system trust | extra private CA trust for the native-TLS health probe                                                                                                                      |
| `ANTNEST_EDGE_TRUSTED_PROXIES`                             | for HTTPS proxy mode        | empty        | trusted source CIDRs for client-address derivation                                                                                                                          |
| `ANTNEST_IDENTITY_SERVICE_URL`                             | yes                         | -            | Identity Service base URL (absolute HTTP(S), no query or fragment)                                                                                                          |
| `ANTNEST_ADMIN_CONSOLE_URL`                                | yes                         | -            | Admin Console base URL                                                                                                                                                      |
| `ANTNEST_AGENT_UI_URL`                                     | yes                         | -            | Agent UI Node service base URL for `/workspace/` HTML, hashed assets and the Workspace HTTP/SSE API                                                                         |
| `ANTNEST_AGENT_CONTROLLER_URL`                             | yes                         | -            | Agent Controller base URL, used for ID/name discovery only                                                                                                                  |
| `ANTNEST_AGENT_ACP_URL`                                    | yes                         | -            | Agent ACP Service base URL                                                                                                                                                  |
| `ANTNEST_EDGE_COOKIE_SECURE`                               | no                          | `true`       | Secure cookies; false is accepted only on a literal loopback HTTP listener                                                                                                  |
| `ANTNEST_EDGE_CSRF_KEY_FILE`                               | yes                         | -            | exactly 32 raw private bytes in a readable regular file; shared across Gateway replicas                                                                                     |
| `ANTNEST_EDGE_ALLOW_ORIGINLESS_MUTATIONS`                  | no                          | `false`      | compatibility for API mutations with both Origin and Fetch Metadata absent; emits a startup warning; CSRF still required                                                    |
| `ANTNEST_EDGE_REQUEST_TIMEOUT`                             | no                          | `10s`        | Deadline for non-streaming dependency calls and forwarded admin requests                                                                                                    |
| `ANTNEST_EDGE_RESOLVE_CACHE_TTL`                           | no                          | `10s`        | Resolve cache TTL, 0–30s; zero restores direct resolution                                                                                                                   |
| `ANTNEST_EDGE_RESOLVE_CACHE_SIZE`                          | no                          | `50000`      | cache entry limit, 1–50,000                                                                                                                                                 |
| `ANTNEST_EDGE_STREAM_LEASE`                                | no                          | `5m`         | Maximum lifetime of an authenticated SSE observation                                                                                                                        |
| `ANTNEST_EDGE_LOGIN_WINDOW`                                | no                          | `5m`         | In-memory login admission window                                                                                                                                            |
| `ANTNEST_EDGE_LOGIN_SOURCE_MAX`                            | no                          | `30`         | Password attempts per source per window                                                                                                                                     |
| `ANTNEST_EDGE_LOGIN_ACCOUNT_MAX`                           | no                          | `10`         | Password attempts per normalized organization/account per window                                                                                                            |
| `ANTNEST_EDGE_OIDC_START_SOURCE_MAX`                       | no                          | `30`         | OIDC starts per source per window, independent of password limits                                                                                                           |
| `ANTNEST_EDGE_LOGIN_MAX_KEYS`                              | no                          | `65536`      | Entry capacity of each of the three independent login admission tables                                                                                                      |
| `ANTNEST_EDGE_SHUTDOWN_TIMEOUT`                            | no                          | `15s`        | Graceful drain budget for ordinary HTTP requests                                                                                                                            |
| `ANTNEST_ENVIRONMENT`                                      | no                          | empty        | Deployment environment resource attribute for telemetry                                                                                                                     |
| `OTEL_*`                                                   | no                          | -            | Standard OpenTelemetry SDK settings (`OTEL_SERVICE_NAME`, `OTEL_SDK_DISABLED`, `OTEL_TRACES_EXPORTER`, `OTEL_EXPORTER_OTLP_ENDPOINT`, `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT`) |

`--healthcheck` probes local `/status`, including configured IPv6 addresses,
using verified HTTPS for native TLS and HTTP for a proxy's internal listener.
It disables environment proxies and refuses redirects, so
another endpoint cannot report Gateway healthy. This follows the
[purpose-listener deployment contract](../../contracts/platform/service-authentication.md#5-networkdeployment-batch).

Durations use Go duration syntax and must be positive, except Resolve cache TTL
which also accepts zero to disable caching. The 10-second request
timeout bounds forwarded admin requests and is shorter than Admin Console's
15-second dependency timeout (`ANTNEST_ADMIN_DEPENDENCY_TIMEOUT`), so a slow
Console dependency surfaces as a Gateway `503` first. Raise both together if
needed. See [Operations](docs/operations.md) for TLS, shutdown and capacity
notes.

See the [public-entry contract](../../contracts/edge-gateway/public-entry.md)
for exact Origin matching, proxy trust, forwarding headers and certificate
rotation. Public TLS configuration is independent of internal service TLS.

## Dependencies

- Identity Service: required for login, every authenticated request and live
  stream revalidation. Unavailability denies finite requests with `503` and
  closes active streams within their authorization bound, preserving cookies.
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

# Isolated authenticated forwarding against dependency doubles
node tests/e2e/service-authentication/gateway/run.mjs

# Docker image (build context is the repository root)
docker build -f services/edge-gateway/Dockerfile -t antnest/edge-gateway:local .

# Docker signal regression for long-lived receive streams
node tests/e2e/edge-gateway/shutdown-docker.mjs

# HTTPS Resolve-cache load batch (default 10-second TTL)
node tests/e2e/edge-gateway/resolve-cache-docker.mjs
```

Integration sources live in
[`tests/integration/go/edge-gateway`](../../tests/integration/go/edge-gateway).
Real TCP backpressure tests use a 500 ms revalidation interval and a 3 s
staleness bound so race-detector scheduling can establish a blocked write before
revocation. They still require cancellation and writer cleanup within that bound;
the guard's exact timing boundaries use Go's virtual test clock.
Root targets: `make test-go-unit`, `make test-go` and `make test-integration-go`
include the Gateway;
`make e2e-stage3` runs the real-stack
[Identity end-to-end client](../../tests/e2e/identity-closeout/README.md)
through the public entry (browser HTTP and ACP v1/v2 logout revocation, SCIM
provisioning, OIDC, Console projections and causal Jaeger spans);
`make e2e-acp-session` covers post-upgrade expiry, dependency outage and
recovery, and durable Run completion after logout or disconnect.

The standalone Resolve-cache load batch builds isolated service candidates and
uses a fresh HTTPS session for the measured WSS connection. Dial, initialize
and 100 sequential `session/list` exchanges must finish within eight seconds;
the test crosses half TTL to witness an actual background refresh. It counts
Gateway Resolve CLIENT attempts and Identity SERVER receipts independently,
including handshake, connection probes and refresh, with a maximum of three
each. Full raw trace closure and warnings remain in private evidence. Set
`ANTNEST_RESOLVE_CACHE_E2E_OUTPUT` to select an unused directory under
`artifacts/verification/`. Cleanup verifies the retained environment and removes
owned candidates. This standalone load batch does not establish outage/recovery;
the separate outage/recovery gate was admitted under #59, with evidence and
limitations recorded in the [global TODO](../../TODO.md).

## Documentation

- [Architecture](docs/architecture.md) - request pipeline, OIDC binding, ACP relay and failure semantics.
- [Operations](docs/operations.md) - configuration, diagnostics, shutdown, capacity and deployment limits.
- [Workspace state](docs/workspace-state.md) - bootstrap and execution-state observation contract.
- [Execution boundary](docs/execution-boundary.md) - Controller and ACP ownership split.
- [Session contract](../../contracts/edge-gateway/session-contract.json) - public browser session interface.
- [Session security](../../contracts/edge-gateway/session-security.md) - exclusive `__Host-` cookie names in Secure mode, session-bound CSRF, key upgrade and the separate Admin-origin plan.
- [Service admission](../../contracts/edge-gateway/service-authentication.md) - exact internal credentials, CCT scope, and pending consumers.
- [Platform observability contract](../../docs/observability-contract.md).
- [Stage 3 admin control plane](../../docs/stage-3-admin-control-plane.md) - cross-service behavior.

For administrator network-policy writes, Gateway validates the existing
`X-Antnest-Expected-Principal` account-switch guard privately and forwards one
canonical match to Console. It rejects stale or ambiguous guards before proxying;
this check preserves the browser contract without accepting unsigned identity
as authorization. See the [authentication contract](../../contracts/edge-gateway/service-authentication.md).
