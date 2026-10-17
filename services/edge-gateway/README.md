# Edge Gateway

Edge Gateway is the single external application entry of Antnest Platform. It
turns an Identity Service access credential into one trusted internal principal
and routes the request to the owning service without owning the requested
business operation. It is written in Go.

The accepted [workspace entry decision](../../docs/architecture/browser-workspace-entry.md)
is implemented by Gateway 24: the unused direct bootstrap, state and ACP
browser routes return 404; the shipped Agent UI Bridge remains.
See the [shared retirement contract](../../contracts/edge-gateway/workspace-entry-retirement.md)
for Bridge preservation, capacity admission and pending consumer integration.

The Gateway owns the browser credential boundary: cookies, CSRF, same-origin
checks and identity revalidation. Internal dependencies receive verified
workload authentication and the unchanged Identity-signed caller context.
Browser-supplied authentication/identity headers and cookies are removed;
presentation hints are regenerated from the verified principal. User access
tokens reach only Identity's authenticated credential RPCs.

An active SSE closed by the session-revocation feed records its actual winning
cause on the original HTTP span. The event keeps bounded mutation provenance
and verified scope, with no SID, Cookie, CCT or raw traceparent. A later feed
event cannot relabel an earlier client cancellation or live-check failure.

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
- Browser-session admission and bounded live checks for retained SSE observers.

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
| Inbound   | `/workspace/*`, `/api/app/workspace/v1/*`                                                                                                                   | Agent UI HTML, assets and Workspace HTTP/SSE API                                                                                                     |
| Inbound   | `GET /status`                                                                                                                                               | Local readiness only; it never probes another service                                                                                                |
| Outbound  | Identity Service RPC                                                                                                                                        | Login, non-touch resolution, account/session controls, OIDC and the private session-revocation feed                                                  |
| Outbound  | Admin Console, Agent UI                                                                                                                                     | Reverse-proxied application traffic                                                                                                                  |

Gateway connects only to Identity, Admin Console and Agent UI. Controller and
ACP remain private Agent UI dependencies; see [Architecture](docs/architecture.md).

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
authority. Returned CCT validity, session expiry and the independent
stale-output timer remain enforced throughout the recheck. Initial requests
keep their existing rejection behavior.

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
checks their shared HTTPS password, revocation and idle behavior. Gateway 24
removes the unused legacy `/api/app/bootstrap` projection; the Bridge bootstrap
remains owned by Agent UI.

## Configuration

Internal dependencies additionally require the exact shared
[service-authentication configuration](../../contracts/edge-gateway/service-authentication.md).
Token mode requires Gateway's read-only callers file (normally `{}`) and three
separate outgoing credential files for Identity, Console and Agent UI. No mode is selected by default, and an
invalid or missing credential prevents startup. HTTPS pins each dependency's
DNS name and service URI; HTTP requires the explicit disposable-development
opt-in. Public Gateway readiness probes the local listener with HTTP or verified
HTTPS according to its configured transport.

Authenticated dependency requests disable
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
- Agent UI: required for `/workspace/*` and the Workspace API.
- OTLP collector: optional, when trace export is configured.

`GET /status` reports only Gateway readiness. Downstream outages are reported by
the affected business request.

## Build and test

Commands run from the repository root unless stated.

```sh
# Unit tests (from services/edge-gateway)
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

# Real Bridge load/outage admission
node tests/e2e/edge-gateway/resolve-cache-docker.mjs
```

Integration sources live in
[`tests/integration/go/edge-gateway`](../../tests/integration/go/edge-gateway).
Real TCP backpressure tests use a 500 ms revalidation interval and a 3 s
staleness bound so race-detector scheduling can establish a blocked write before
revocation. They still require cancellation and writer cleanup within that bound;
the guard's exact timing boundaries use Go's virtual test clock.
Root targets: `make test-go-unit`, `make test-go` and `make test-integration-go`
include the Gateway.

The real-stack [Identity end-to-end client](../../tests/e2e/identity-closeout/README.md)
and ACP session suites exercise browser behavior through the Bridge and owning
protocol behavior through authenticated private ACP entrypoints. The
Resolve-cache Docker runner counts 100 actual same-scope Bridge calls within
eight seconds and at most three actual Resolve calls, including initialization
and refresh. It also exercises the real five-second Identity outage, output,
Runtime cancellation and recovery under the active cache policy.

`make e2e-agent-ui-upload-capacity` runs two real users and Agents with independent
clients and production Gateway, Agent UI, ACP and Runtime processes. With 64
active SSE streams, one user submits a valid near-limit attachment while the
other cancels the same held Runtime work through direct cancel or `/stop`.
Original HTTP phase receipts prove both incomplete-body and EOF-processing
overlap. Admission requires accepted cancellation, the original Run's terminal
state and observed Runtime process-group quiescence within one second. See the
[Agent UI capacity gate](../agent-ui/README.md) for limits and evidence.

Each consumer retains its own Docker admission; complete integration CI remains
a separate merge gate. Evidence stays under `artifacts/verification/`, with
owned-resource cleanup and the original strict diagnostics preserved.

## Documentation

- [Architecture](docs/architecture.md) - request pipeline, OIDC binding, Bridge routing and failure semantics.
- [Operations](docs/operations.md) - configuration, diagnostics, shutdown, capacity and deployment limits.
- [Workspace Bridge entry](docs/workspace-state.md) - retained HTTP/SSE boundary and downstream-owned state.
- [Execution boundary](docs/execution-boundary.md) - Gateway, Agent UI and private execution ownership.
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
