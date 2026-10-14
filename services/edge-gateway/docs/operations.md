# Edge Gateway Operations

This document covers Edge Gateway configuration, deployment limits, request
diagnostics, shutdown behavior for long-lived streams, and capacity bounds.

## Configuration

Internal connection configuration is mandatory in the
[Gateway authentication contract](../../../contracts/edge-gateway/service-authentication.md).
Supply the exact shared `ANTNEST_SERVICE_AUTH_MODE`, receiver hash file and
outgoing token directory in token mode; supply complete trusted TLS material
unless explicitly opting into disposable-development HTTP. Token files are
read at startup and again for every request/connection; replacements with
whitespace, malformed bytes or missing files fail closed with the existing
dependency-unavailable projection, without clearing browser cookies.
Rotate by first installing current/next hashes at the receiver, then atomically
replacing the caller file, and finally removing the previous receiver hash.
Do not restart into an intermediate configuration or change receiver origins
through browser inputs. Public listener TLS uses a separate certificate and key;
it does not reuse internal workload credentials.

Gateway 24 consumes Identity revision 18. Its required session
metadata, account/session RPCs, external identity list/unbind/notice RPCs and
private revocation feed must be available. The three new self routes preserve
cookies on success and failure; after unbinding the current session, the next
request returns 401. Stream retirement uses the existing private feed and live
session checks. Reading bindings or notices and acknowledging specific notices
does not extend the idle deadline. `make e2e-browser-sessions-https` verifies the
coordinated Identity, Gateway, Console and Agent UI linking workflow through
the reference proxy, including session retirement without Agent offboarding.
Identity policy defaults to a
30-minute idle deadline and a 12-hour absolute deadline; ordinary traffic does
not renew either. See the [session lifecycle contract](../../../contracts/identity/browser-sessions.md).

For login and password changes, `429 credential_rate_limited` means Identity's
persisted attempt backoff applies; `503 credential_busy` means its bounded
password capacity could not admit work. Both preserve the browser session and
carry one validated seconds value in `Retry-After`, with `retryable: true` and
`Cache-Control: no-store`. Gateway does not retry the operation. Malformed
upstream failure metadata returns generic `503 identity_unavailable` without
a retry hint. The existing edge `login_rate_limited` is a separate prefilter.
Console user creation also preserves the typed busy response. The real HTTPS
suite verifies all three routes against Identity, including one owning RPC per
rejection, unchanged Cookies and durable state, and explicit recovery after
KDF capacity returns.

| Variable                                  | Required                       | Default               | Description                                                                                                 |
| ----------------------------------------- | ------------------------------ | --------------------- | ----------------------------------------------------------------------------------------------------------- |
| `ANTNEST_EDGE_LISTEN`                     | no                             | `:8080`               | HTTP or native HTTPS listen address                                                                         |
| `ANTNEST_EDGE_PUBLIC_ORIGIN`              | except direct loopback HTTP    | -                     | canonical browser origin, including any non-default port                                                    |
| `ANTNEST_EDGE_TLS_CERT_FILE`              | with key                       | -                     | native public TLS certificate chain PEM                                                                     |
| `ANTNEST_EDGE_TLS_KEY_FILE`               | with certificate               | -                     | native public TLS private key PEM                                                                           |
| `ANTNEST_EDGE_TLS_CA_FILE`                | no                             | system trust          | extra stable private CA bundle for native-TLS local health                                                  |
| `ANTNEST_EDGE_TRUSTED_PROXIES`            | for HTTPS termination upstream | empty                 | comma-separated trusted proxy CIDRs; empty trusts none                                                      |
| `ANTNEST_IDENTITY_SERVICE_URL`            | yes                            | -                     | trusted Identity Service base URL                                                                           |
| `ANTNEST_ADMIN_CONSOLE_URL`               | yes                            | -                     | trusted Admin Console base URL                                                                              |
| `ANTNEST_AGENT_UI_URL`                    | yes                            | -                     | internal Node Agent UI base URL for authenticated HTML, static assets, the Workspace HTTP API and SSE       |
| `ANTNEST_EDGE_COOKIE_SECURE`              | no                             | `true`                | Secure cookies; false requires a literal loopback HTTP listener                                             |
| `ANTNEST_EDGE_CSRF_KEY_FILE`              | yes                            | -                     | readable regular file containing exactly 32 raw CSRF key bytes; identical on all replicas for one origin    |
| `ANTNEST_EDGE_ALLOW_ORIGINLESS_MUTATIONS` | no                             | `false`               | explicit compatibility for API mutations with both Origin and Fetch Metadata absent; logs a startup warning |
| `ANTNEST_EDGE_REQUEST_TIMEOUT`            | no                             | `10s`                 | non-streaming dependency and forwarded admin request timeout                                                |
| `ANTNEST_EDGE_RESOLVE_CACHE_TTL`          | no                             | `10s`                 | Resolve snapshot TTL, 0–30s; zero selects direct resolution                                                 |
| `ANTNEST_EDGE_RESOLVE_CACHE_SIZE`         | no                             | `50000`               | entry limit, 1–50,000, also validated when TTL is zero                                                      |
| `ANTNEST_EDGE_SHUTDOWN_TIMEOUT`           | no                             | `15s`                 | ordinary HTTP graceful-drain budget                                                                         |
| `ANTNEST_EDGE_STREAM_LEASE`               | no                             | `5m`                  | maximum authenticated SSE lifetime                                                                          |
| `ANTNEST_EDGE_LOGIN_WINDOW`               | no                             | `5m`                  | in-memory login admission window                                                                            |
| `ANTNEST_EDGE_LOGIN_SOURCE_MAX`           | no                             | `30`                  | password attempts per source per window                                                                     |
| `ANTNEST_EDGE_LOGIN_ACCOUNT_MAX`          | no                             | `10`                  | password attempts per normalized organization/account per window                                            |
| `ANTNEST_EDGE_OIDC_START_SOURCE_MAX`      | no                             | `30`                  | OIDC starts per source per window, independent of password limits                                           |
| `ANTNEST_EDGE_LOGIN_MAX_KEYS`             | no                             | `65536`               | entry capacity of each of the three independent login admission tables                                      |
| `ANTNEST_ENVIRONMENT`                     | no                             | empty                 | deployment environment telemetry attribute                                                                  |
| `OTEL_*`                                  | no                             | -                     | standard OTLP HTTP/protobuf signal configuration                                                            |
| `OTEL_METRICS_EXPORTER`                   | no                             | `none`                | Gateway metrics opt-in: `otlp` or `none`; independent of traces                                             |
| `OTEL_EXPORTER_OTLP_METRICS_ENDPOINT`     | no                             | generic OTLP endpoint | metrics-specific full HTTP URL, normally ending in `/v1/metrics`                                            |
| `OTEL_EXPORTER_OTLP_METRICS_PROTOCOL`     | no                             | generic OTLP protocol | only `http/protobuf` is supported                                                                           |
| `OTEL_METRIC_EXPORT_INTERVAL`             | no                             | `60000`               | periodic metrics collection interval in milliseconds                                                        |
| `OTEL_METRIC_EXPORT_TIMEOUT`              | no                             | `30000`               | periodic metrics export budget in milliseconds; shutdown is separately bounded                              |

The forwarded admin request timeout (10 seconds by default) is shorter than
Admin Console's 15-second `ANTNEST_ADMIN_DEPENDENCY_TIMEOUT`. A Console request
whose dependencies take longer than the Gateway deadline is cut off by the
Gateway with `503`, even though Console itself would still be waiting. Keep the
Gateway timeout at least as long as the Console timeout if Console's own error
responses should reach the browser.

Gateway supports native TLS and HTTPS termination at an explicitly trusted
proxy. Both set `ANTNEST_EDGE_PUBLIC_ORIGIN=https://<public-host>[:port]` and keep
Secure cookies. API Origin checks use that configured origin, independently
of Host, `X-Forwarded-Host` and `X-Forwarded-Proto`. HTTPS public origins receive
HSTS with `max-age=31536000`, including errors and retired-route responses; Gateway
overrides conflicting upstream HSTS. It does not opt subdomains into HSTS.

For native TLS, mount a directory containing the certificate chain and private
key, set both public TLS file variables, and permit TLS 1.2 or newer. Replace
both files atomically, then send `SIGHUP` to the process. New handshakes use the
new pair; existing connections remain open. Invalid, expired, hostname-mismatched
or incomplete replacements retain the last valid pair and log a reload failure.
Mount the directory rather than individual files so replacements remain visible
inside the container. The initial pair must be valid for the public hostname
and TLS server authentication.

For proxy termination, leave the native TLS files unset and allow only the
proxy's source CIDR in `ANTNEST_EDGE_TRUSTED_PROXIES`. Keep the internal listener
isolated from public clients. The proxy must append or replace the actual
client's address correctly. Gateway scans `X-Forwarded-For` from the trusted
right-hand end to the first untrusted IP, ignoring any attacker-supplied prefix.
Malformed, absent and all-trusted chains fall back to the immediate peer.
`Forwarded` and `X-Real-IP` never determine the client address. Gateway rebuilds
all downstream forwarding headers from its resolved client and public origin.

The development Compose entry stays on host `127.0.0.1` HTTP with an explicit
loopback public origin and Secure cookies. Chromium supports this loopback
exception; use HTTPS for other browser/deployment combinations. The container
listener remains private and uses isolated ingress networking. A false Secure
cookie setting on that non-loopback listener is rejected at startup. Direct
process-only HTTP development may bind a literal loopback address, omit the
public origin and explicitly disable Secure cookies with a startup warning.
Existing development `.env` files with `ANTNEST_EDGE_COOKIE_SECURE=false` must
change that value to `true` before starting the upgraded Compose stack.

The [public-entry contract](../../../contracts/edge-gateway/public-entry.md)
defines configuration, trust and staged integration acceptance. Every `/api/`
request is checked before routing. GET, HEAD and OPTIONS may omit Origin, but
any supplied Origin must exactly match the configured public origin. All other
methods, including login and logout, require matching Origin or, when it is
absent, `Sec-Fetch-Site: same-origin`. `same-site` and `cross-site` reject
mutations even with matching Origin. Empty, malformed and duplicate evidence
is rejected; `none` requires matching Origin. Rejections return `403 forbidden`
with `Request origin is not allowed`. CSRF remains a separate check.

Update scripted HTTP clients to send `Origin: <ANTNEST_EDGE_PUBLIC_ORIGIN>`,
including when the transport connects to a private Gateway address. Standard
Compose keeps originless mutations disabled. If an explicit legacy-client
exception is necessary, set `ANTNEST_EDGE_ALLOW_ORIGINLESS_MUTATIONS=true` in
that Gateway process/container; startup emits a warning. This admits only
requests with both Origin and `Sec-Fetch-Site` absent and never waives session or CSRF checks. Remove the exception after migrating clients.
Secure mode uses only `__Host-antnest_session` and `__Host-antnest_csrf`.
CSRF is derived from Identity's stable token ID; a planted cookie/header pair
cannot authorize a request. The delivery cookie may be absent when a client
already holds the correct derived header. See [session security](../../../contracts/edge-gateway/session-security.md).

The development credential generator creates `edge-gateway/csrf.key` with mode
0600; Compose mounts this file read-only at `/etc/antnest/service-auth/csrf.key`
and refuses to create a directory if the source is absent.
To upgrade existing credentials, add a new independent 32-byte raw random file
there without regenerating workload credentials or database keys. Configure
every Gateway replica with that file and restart them together. Missing,
unreadable, non-regular or incorrectly sized keys prevent startup. Keep the key
out of environment values, logs and source control. Prefix migration requires
fresh login; key rotation also requires fresh login to receive the new derived
CSRF value. This revision has no dual-key rolling acceptance.

`GET /status` reports Gateway's own initialized listener. It never probes
Identity, Console or Agent UI. Check each container's health and real
business requests separately to establish deployment readiness. Native-TLS
`--healthcheck` connects to that listener with certificate and public-hostname
verification; it never disables certificate validation. The native-TLS probe
uses system roots plus `ANTNEST_EDGE_TLS_CA_FILE` when supplied, independently
of replaceable leaf files, so failed rotation retains healthy existing service.
Proxy-mode local health uses HTTP, so external HTTPS must also be checked through
the proxy. Shutdown
stops admission, drains HTTP requests, and flushes OTLP within a bounded
timeout.

## HTTPS Compose Deployment

Prepare the normal deployment credentials and images as in the root README.
Place your public certificate chain in `cert.pem` and private key in `key.pem`
inside a private directory outside the Docker build context. The certificate
must cover the hostname or IP in the public origin. The native Gateway runs as
the generated service-auth UID/GID, which must be able to read that directory
and pair. A private-CA native deployment also places its stable CA bundle in
`ca.pem`; the health probe does not trust a rotating leaf certificate.

Set these values in the deployment `.env` (example paths and hostname):

```dotenv
ANTNEST_EDGE_PUBLIC_BASE_URL=https://antnest.example.com
ANTNEST_EDGE_TLS_DIRECTORY=/absolute/private/path/public-tls
ANTNEST_EDGE_TLS_HOST_PORT=443
ANTNEST_EDGE_TLS_BIND_ADDRESS=0.0.0.0
ANTNEST_EDGE_COOKIE_SECURE=true
# Native TLS only, when the certificate uses a private CA:
# ANTNEST_EDGE_TLS_CA_FILE=/etc/antnest/public-tls/ca.pem
```

`ANTNEST_EDGE_PUBLIC_BASE_URL` is the Compose input shared by Identity's public
URLs and Gateway's `ANTNEST_EDGE_PUBLIC_ORIGIN`; include a non-default public
port when applicable. Choose exactly one HTTPS overlay and use the same file
set for later Compose commands. These commands do not load diagnostic ports:

```sh
# Native TLS: the only published application port serves TLS directly.
docker compose -f compose.yaml -f compose.stage3.yaml -f compose.native-tls.yaml \
  --profile stage3 --profile observability up -d --wait

# Or Caddy termination: only Caddy is published; Gateway stays on a private bridge.
docker compose -f compose.yaml -f compose.stage3.yaml -f compose.tls.yaml \
  --profile stage3 --profile observability up -d --wait
```

When switching an existing stack to the proxy topology, first stop that stack
with its previous file set (`down`, without `-v`) so Compose can recreate the
ingress network as internal. Preserve database/runtime volumes. The reference
[Caddyfile](../../../deploy/tls/Caddyfile) uses manually supplied certificates,
disables its admin API and automatic certificate management, and overwrites
client forwarding headers using Caddy's direct peer. Gateway trusts only
`${ANTNEST_SERVICE_NETWORK_PREFIX}.131/32`, which is Caddy's address on their
private network. Additional proxies require their own reviewed trust and
network configuration; do not trust arbitrary client networks.

After installing both replacement files, native TLS reloads without dropping
existing HTTP connections:

```sh
docker compose -f compose.yaml -f compose.stage3.yaml -f compose.native-tls.yaml \
  kill --signal SIGHUP edge-gateway
```

Check the successful reload log and a fresh TLS handshake. Rejected pairs keep
the old certificate and connections; repair the files and signal again. For the
reference Caddy deployment, replace its pair and `restart tls-proxy` using the
proxy file set; that restart reconnects clients. The reference does not enable
ACME or a network-accessible reload endpoint.

Finally, check the public HTTPS `/status`, sign in, make a Console admin request,
send a Workspace message and observe events through the retained Bridge. An internal
Gateway health check alone cannot validate the TLS proxy or public certificate.

## Resolve Cache Operation

Each replica owns a separate volatile cache. Scope includes the exact browser
token hash, audience profile and Agent, so warming one scope does not admit a
different profile or Agent. Snapshots expire at the earliest of actual Resolve
start + TTL, idle, absolute and original CCT expiry. Hits never extend authority.
Only a complete terminal revocation-feed page applied to all consumers proves
catch-up, anchored to that page RPC's start. No proof at startup or proof age at
least TTL means live-only resolution. Four full pages, partial application or
a failed poll cannot refresh proof; an earlier still-fresh proof remains usable
until its original TTL boundary. Valid sequence gaps
remain legal; do not advance a cursor from wall time or a guessed sequence.

Capacity is bounded by 50,000 configured entries, 64 MiB of accounted entry
storage, 16 KiB per entry, 32 retained work slots, 128 waiters per exact scope
across generations and 1,024 total waiters. Accounted storage includes all
retained strings and entry overhead; it is not process RSS. Valid larger live
responses are not cached. Completed-but-undelivered and cancelled-but-unjoined
work still consumes a slot. Saturated misses return 503; no direct fallback
escapes the limit. TTL zero restores the previous direct path and disables these
new cache/shared-work budgets. Restart with the chosen TTL to switch modes.

The shared RPC timeout is `min(5s, request timeout, TTL)`. At half TTL, valid hits
may initiate bounded refresh. Failures do not extend the old snapshot, and
attempts for that entry remain spaced by at least half TTL. Revocation and
validated local security mutations evict/fence old authority before later delivery.
Concurrent live results also check a fixed 128-event session-revocation window
against their actual SID. Unrelated events preserve valid results. More than 128
events during one retained flight return 503 for that old work because its
history is incomplete; no automatic Resolve retry occurs. The next new live
request starts with current history. This window stores only 4096 bytes of SID
digests plus its counter; it does not retain an unbounded session denylist.
Validated activity evicts same-session entries and prevents identified old work
from accepting new readers or refilling the cache. Readers already attached may
finish with their original live result, subject to the original deadlines and
final revocation/cancellation checks. No CCT or deadline is edited, and there is
no automatic retry. Old and new generations both count against capacity; an old
authoritative denial still invalidates newer work and every cached token scope.

A short Identity outage can preserve admission only for a prewarmed exact scope
whose snapshot, proof, session, stale-output and returned CCT budgets
remain valid. It does not make new login, a cold scope or expired authority
available. Ordinary failure responses preserve cookies. Cache reuse does not
extend JWKS trust or the CCT validity of a reused snapshot;
reconnection still requires normal admission. Already accepted Runs retain their
independent execution lifetime.

After restoring an Identity database from backup, restart **all Gateway
replicas** to discard cached snapshots and restart the feed at cursor zero
before serving authenticated traffic. A restored sequence history cannot be
reconciled with an old in-memory cursor. This requires no new Identity schema
or second revocation interface. Names and slugs share the Principal TTL; users
observe a rename on the next real session/bootstrap/SSR read after expiry,
including that request's latency.

## Request Diagnostics

The public response carries `X-Antnest-Trace-ID`. In Jaeger, expect Gateway
SERVER -> shared HTTP CLIENT -> downstream SERVER. The Identity RPC client
does not create a second CLIENT span. Reverse proxies share the same Transport.

Gateway does not create ACP message traces or inject protocol message metadata.
Private ACP tracing belongs to the downstream execution path. Gateway keeps
request-level HTTP and Resolve evidence without per-chunk spans or Run state.

The HTTP CLIENT span ends when its response body reaches EOF, fails, or closes,
not when response headers arrive. SSE is not pre-read or buffered for tracing.

Gateway records normalized routes, method, status, peer host/port, observed body
sizes and failure classifications. Returned handler errors are observed at
the HTTP boundary, with bounded cause types and safe messages; arbitrary error
strings, query strings, cookies, Authorization, OIDC codes/state and access
subjects are excluded. Handler panic payloads are not exported to traces.

Gateway never collects request/response contents or Header values. This applies
to login, JSON APIs, opaque proxy traffic, files and SSE alike.
The observer counts bytes already consumed by the transport; it never buffers
them or reads ahead. There is no Gateway content-mode setting, projection map,
custom payload budget or omission event. Typed RPC diagnostics belong to the
receiving service's protocol adapter and its shared RPC-content switch, not to
this HTTP forwarding layer. Standard SDK export configuration remains available.

Gateway follows the [platform observability contract](../../../docs/observability-contract.md)
but cannot repair a missing downstream SERVER span itself.

Each Resolve invocation ends a `gateway.identity.resolve` INTERNAL marker under
its actual HTTP request root. `source=rpc|cache|shared`, the fixed profile
and `outcome=admitted|rejected|unavailable` describe the decision. A cache hit
records fractional `snapshot_age_ms`, `proof_age_ms` and positive `valid_for_ms`
at admission. Shared decisions link the exact actual CLIENT span; background
refresh has its own root linked to its trigger. Archive source traces and check
both parent chains. A cancelled shared wait may lack a CLIENT only under the
explicit `cancelled-before-client` boundary in the [cache contract](../../../contracts/edge-gateway/resolve-cache.md).
Neither that marker nor unrelated SQL excuses a missing parent (#247).

Every actual session-revocation feed CLIENT records the fixed
`rpc.method=list_session_revocations`, `rpc.service=identity` and
`rpc.system.name=antnest.http-json`, including a failed send with no receiver.
The Identity adapter supplies these fields; URL/header values never select
them. Feed contents and private cursors remain excluded. Consumers must bind
this method to the observed outage and the original transport error before
classifying it. Historical anonymous CLIENT failures remain pending evidence;
the producer marker alone does not complete feed-outage admission.

The recovery HTTP E2E gate binds the observed logout, password change and
Membership changes to their actual Gateway/Console/Identity chain and committed
Identity transaction. Session-feed inserts must match the number of revoked
token rows; password replacement and deactivation's principal feed remain
required. Parameterized SQL does not establish individual token IDs or reasons.
The old-session and rejected-login checks require the exact 401 response,
credential scope, Identity receipt and successful lookup. Only the matched
Trace/span pairs are classified as expected refusals. Raw errors, warnings and
the strict Trace result remain intact; HTTP admission alone does not complete
stream retirement, feed-outage or full CI acceptance.

To export metrics, enable the SDK and set `OTEL_METRICS_EXPORTER=otlp` with a
reachable metrics receiver, normally via `OTEL_EXPORTER_OTLP_METRICS_ENDPOINT`.
Jaeger supplies trace storage, not a metrics backend. `OTEL_TRACES_EXPORTER=none`
does not disable metrics; `OTEL_SDK_DISABLED=true` disables both. Endpoint and
protocol settings alone do not opt Gateway into metrics. Compose forwards the
metrics endpoint/protocol and periodic interval/timeout settings.

The counter `antnest_edge_login_admission_total` records one decision per
request that reaches login admission after Origin and payload validation. Its
only attributes are `flow=password|oidc_start` and
`outcome=admitted|source_limited|account_limited|evicted`. An admitted request
that evicts from one or both tables records only `evicted`; expired-window
pruning alone does not count as eviction. When both password limits are exhausted,
`source_limited` wins. OIDC cannot emit `account_limited`. An Identity failure
does not add a second decision. No source, account, organization, provider or
digest is exported as a metric label.

Metrics under `antnest.gateway.identity.resolve.` are:

| Suffix                                       | Meaning                                                                                                                                |
| -------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `decisions`                                  | request count by fixed `source`, `profile`, `outcome`                                                                                  |
| `rpc.calls`, `rpc.duration`                  | actual live attempt count and duration in seconds, including response validation and background refresh, by fixed `profile`, `outcome` |
| `cache.entries`, `cache.accounted_bytes`     | retained entry count and accounted bytes, including entries awaiting lazy expiry                                                       |
| `cache.work`, `cache.waiters`                | retained work slots and attached callers                                                                                               |
| `cache.proof.available`, `cache.proof.fresh` | 0/1 observations for a known proof and proof within TTL                                                                                |
| `cache.proof.age`                            | dynamically collected age in seconds; absent until a proof exists                                                                      |

Cache gauges describe the process's single Identity client. None contains token,
token hash, SID, CCT, cache key or arbitrary Identity error text. TTL zero still
counts direct attempts and decisions, but produces no cache gauges. Collection
does not perform Identity I/O. Export is asynchronous to admission; final
shutdown flushes remaining counters/histograms after cache observers unregister.
Those final exports do not promise a zero-valued final cache gauge or backend
durability. Receiver acceptance/storage requires receiver-side evidence.

## Shutdown And Streams

Signal and listener-error exits cancel and drain Workspace Bridge events and
administrator Agent event watches before telemetry shutdown. Stop cancels their
upstream receive requests and waits for handlers and request telemetry; it does
not send a business cancellation command or retry a prompt.

Ordinary HTTP requests, including Bridge commands/prompts, keep their normal
graceful-drain window. Deadline exhaustion remains a shutdown failure.
Regression tests cover both retained receive routes on a real listener and
signal/restart behavior in Docker, including requests carrying Upgrade headers.

Managed HTTP receive streams also interrupt blocked downstream writes on
stop. Later per-frame deadlines cannot reopen writing after that cancellation.
If graceful drain expires, Gateway force-closes connections and allows a
separate bounded five-second handler/telemetry cleanup, retaining the original
deadline error. The request-completion counter covers ordinary HTTP as well as
streams, while only receive streams are cancelled before their graceful-drain
window. Compose gives Gateway 40 seconds: the default 15-second grace, up to
five seconds for cancelled handlers, five seconds for metrics shutdown,
five seconds to drain traces and up to five seconds for trace exporter cleanup,
and margin. Increase the platform stop grace as well when increasing the HTTP
shutdown budget.

Main owns one private session-revocation poller and cancels/joins it before
transport teardown on both signal and listener failure. It starts from cursor
zero after restart, reads at most 500 events per page and four pages per catch-up
pass, and fans events to active stream registrations and the Resolve cache.
Shutdown rejects new cache work, cancels and joins shared/refresh RPCs and the
feed, clears entries, and unregisters metric callbacks before transport and
telemetry teardown. Feed outage or lag never waives each stream's independent
bounded checks. Constructors start no cache worker or poller.

Telemetry cleanup uses fresh bounded contexts even if its caller has already
expired, and retains that cancellation in the returned error. At trace drain
expiry, Gateway cancels active exporter HTTP requests, rejects further queued
uploads and joins the SDK batch worker before closing exporter resources.
An export timeout remains a shutdown failure; discarded measurements are not
reported as successful delivery.

Run the service-owned signal regression from the repository root after building
its image:

```sh
docker build -f services/edge-gateway/Dockerfile -t antnest/edge-gateway:local .
node tests/e2e/edge-gateway/shutdown-docker.mjs
```

The regression starts only a Gateway container and a controlled Node HTTP
dependency. Both retained receive routes must close on SIGTERM, reopen after a
restart, and close on SIGINT, with both exits zero and no extra upstream
commands. It verifies the image ID and removes only its labeled containers and
network. No database, model Provider or retained deployment is used.

## State, Limits And Capacity

The service has no database, migration, backup, or persistent volume.
Login admission is replica-local, with three independent fixed-window tables:
password source, password organization/account and OIDC-start source. Each
table defaults to 65,536 entries, controlled by `ANTNEST_EDGE_LOGIN_MAX_KEYS`;
this is a retained-entry limit, not an RSS guarantee. The window defaults to
five minutes, with password limits of 30 per source and 10 per normalized
organization/account, and an independent OIDC source limit of 30. OIDC has no
shared organization/provider budget, and the two flows cannot consume each
other's allowances. Empty or whitespace-only admission environment settings
select defaults; explicit zero, negative, malformed or overflowing values
prevent startup.

Trusted-proxy selection already normalizes IPv4-mapped addresses. The limiter
also accepts mapped addresses and applies IPv6 `/64` aggregation only to its
keys. Forwarded headers and diagnostics retain the actual selected canonical
address. Invalid or zoned limiter inputs share one unknown
limiter key. Keys occupy 32 bytes; account keys hash length-prefixed normalized
organization and email with a password-specific domain, without retaining raw
identifiers.

An exhausted retained key returns `429 login_rate_limited` before Identity is
called, with `no-store`, no Cookie writes and one `Retry-After` equal to the
whole configured window rounded up to seconds. Rejection changes no table,
including expired entries. On admission, expired windows are pruned first;
if a new key still needs space in a full table, its earliest-expiring live
window is evicted. Hits do not evict another key, extend expiry or move FIFO order. Eviction can
reset an old key's allowance under high cardinality, so this is a best-effort
prefilter, not a distributed quota. Identity enforces
the shared password-attempt policy in PostgreSQL across replicas and separately
bounds Argon2 memory, concurrency and queue waits in each process; internal
callers receive the same admission checks. See Identity's
[password resource admission](../../identity-service/docs/operations.md#password-resource-admission).
The exact Gateway policy is in the
[login admission contract](../../../contracts/edge-gateway/login-admission.md).
The #2 consumer and real two-source HTTPS/OIDC admissions remain separate
delivery gates until recorded complete in the global TODO.
Event streams retain their maximum lease and independently check
Identity even without incoming events. Checks run at the smaller of 10 seconds
and Identity's activity hint. The 30-second stale-output bound includes time
spent in the RPC and at most one second for closing sockets. Initial resolution
must fit 10 seconds and the returned hint before any upstream opens; reducing
the request timeout can tighten this further. Checks never record user activity.

OIDC method discovery and login start are public, no-store browser APIs. The
callback establishes cookies and redirects to `/`; it never returns an access
token to JavaScript. Unknown OIDC paths return JSON `404`, not Console HTML.
SCIM clients use the Identity-issued Bearer credential at the Edge
`/scim/v2` path. A SCIM upstream transport failure is a canonical SCIM `503`.

Workspace traffic uses the authenticated Agent UI Bridge. Its HTTP bodies are
limited to 64 MiB, and ordinary requests have a 65-second deadline. The process
has 64 Bridge SSE slots; the next stream is refused with
`503 workspace_unavailable`. Commands use no SSE slot. These are Gateway
bounds, not a per-user quota, process RSS guarantee or Node event-loop fairness
proof. Gateway no longer owns the old ACP connection/message or state pools.

The Agent UI owning batch and explicit integration must independently prove
near-limit upload reception and EOF processing do not prevent another user's
same held Runtime work from actually stopping within one second. Body parsing,
hashing and serialization are part of that overlap; a later upstream wait is
not a substitute. See the [retirement contract](../../../contracts/edge-gateway/workspace-entry-retirement.md).

HTTP/SSE trace completion also runs when a handler unwinds, including
`http.ErrAbortHandler` from interrupted reverse-proxy streams. Gateway ends the
span, retains any already-written HTTP status and marks the execution as
aborted. It does not swallow the panic, write a second response or log its
payload. This keeps downstream spans attached to an observable
Gateway parent. The boolean `antnest.http.request_cancelled` is emitted only
when the handler unwinds with `http.ErrAbortHandler` and its request context is
cancelled. The span remains `handler_aborted`, not a successful completion. An
arbitrary panic, a live-context abort or an errored dependency is not treated
as normal stream cancellation.

Bridge events retain their lease, bounded non-touch checks, private-feed
invalidation and original absolute session deadline. Every reconnect performs
normal admission. Agent UI owns event DTOs, Last-Event-ID recovery and browser
state; Gateway does not parse/re-encode the old six-field ACP state projection.
Disconnect or shutdown cancels and joins only the observer. It does not cancel
an accepted durable Run. See [Workspace Bridge entry](workspace-state.md).
