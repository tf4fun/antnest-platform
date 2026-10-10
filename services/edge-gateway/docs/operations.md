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

Deploy Identity revision 14 before this Gateway batch. Console, UI, ACP and
Controller workload/CCT consumers and deployment mounts are separate pending
batches; use the coordinated branch only after the final integration acceptance.

| Variable | Required | Default | Description |
| --- | --- | --- | --- |
| `ANTNEST_EDGE_LISTEN` | no | `:8080` | HTTP or native HTTPS listen address |
| `ANTNEST_EDGE_PUBLIC_ORIGIN` | except direct loopback HTTP | - | canonical browser origin, including any non-default port |
| `ANTNEST_EDGE_TLS_CERT_FILE` | with key | - | native public TLS certificate chain PEM |
| `ANTNEST_EDGE_TLS_KEY_FILE` | with certificate | - | native public TLS private key PEM |
| `ANTNEST_EDGE_TLS_CA_FILE` | no | system trust | extra stable private CA bundle for native-TLS local health |
| `ANTNEST_EDGE_TRUSTED_PROXIES` | for HTTPS termination upstream | empty | comma-separated trusted proxy CIDRs; empty trusts none |
| `ANTNEST_IDENTITY_SERVICE_URL` | yes | - | trusted Identity Service base URL |
| `ANTNEST_ADMIN_CONSOLE_URL` | yes | - | trusted Admin Console base URL |
| `ANTNEST_AGENT_UI_URL` | yes | - | internal Node Agent UI base URL for authenticated HTML, static assets, the Workspace HTTP API and SSE |
| `ANTNEST_AGENT_CONTROLLER_URL` | yes | - | trusted Agent Controller base URL for ID/name discovery only |
| `ANTNEST_AGENT_ACP_URL` | yes | - | trusted Agent ACP Service base URL |
| `ANTNEST_EDGE_COOKIE_SECURE` | no | `true` | Secure cookies; false requires a literal loopback HTTP listener |
| `ANTNEST_EDGE_REQUEST_TIMEOUT` | no | `10s` | non-streaming dependency and forwarded admin request timeout |
| `ANTNEST_EDGE_SHUTDOWN_TIMEOUT` | no | `15s` | ordinary HTTP graceful-drain budget |
| `ANTNEST_EDGE_STREAM_LEASE` | no | `5m` | maximum authenticated SSE lifetime |
| `ANTNEST_EDGE_LOGIN_WINDOW` | no | `5m` | in-memory login admission window |
| `ANTNEST_EDGE_LOGIN_SOURCE_MAX` | no | `30` | attempts per source per window |
| `ANTNEST_EDGE_LOGIN_ACCOUNT_MAX` | no | `10` | attempts per normalized account per window |
| `ANTNEST_ENVIRONMENT` | no | empty | deployment environment telemetry attribute |
| `OTEL_*` | no | - | standard OTLP HTTP/protobuf signal configuration |

The forwarded admin request timeout (10 seconds by default) is shorter than
Admin Console's 15-second `ANTNEST_ADMIN_DEPENDENCY_TIMEOUT`. A Console request
whose dependencies take longer than the Gateway deadline is cut off by the
Gateway with `503`, even though Console itself would still be waiting. Keep the
Gateway timeout at least as long as the Console timeout if Console's own error
responses should reach the browser.

Gateway supports native TLS and HTTPS termination at an explicitly trusted
proxy. Both set `ANTNEST_EDGE_PUBLIC_ORIGIN=https://<public-host>[:port]` and keep
Secure cookies. Existing Origin checks use that configured origin, independently
of Host, `X-Forwarded-Host` and `X-Forwarded-Proto`. HTTPS public origins receive
HSTS with `max-age=31536000`, including errors and WebSocket upgrades; Gateway
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
defines configuration, trust and staged integration acceptance. Mandatory Origin
on additional routes, cookie prefixes and session-bound CSRF remain separate
work in #10 and #62; this deployment change does not claim their completion.

`GET /status` reports Gateway's own initialized listener. It never probes
Identity, Controller, Console, UI or ACP. Check each container's health and real
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
existing WebSockets:

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
send a Workspace message and initialize an ACP client over WSS. An internal
Gateway health check alone cannot validate the TLS proxy or public certificate.

## Request Diagnostics

The public response carries `X-Antnest-Trace-ID`. In Jaeger, expect Gateway
SERVER -> shared HTTP CLIENT -> downstream SERVER. Identity and Controller RPC
clients do not create a second CLIENT span. Reverse proxies share the same
Transport; the WebSocket dial wrapper traces its handshake separately from messages.

Each client ACP request or notification starts a bounded Gateway message trace,
linked to the connection trace rather than parented by its long-lived HTTP span.
The message SERVER includes session revalidation; its PRODUCER covers forwarding
to ACP, not waiting for the eventual protocol response. W3C context is injected
into standard ACP `params._meta`; caller-supplied trace context is replaced.
`antnest.operation.phase=relay` on the message SERVER and `forward` on the
outbound PRODUCER make those bounded lifetimes explicit in Jaeger. The outbound
span ending before ACP dispatch or Run completion is expected.
ACP dispatch, Run execution, model and Runtime calls inherit this context.
Message spans record method and byte count only, never prompt or response content.
Responses, binary frames and malformed envelopes remain unchanged; validation
and execution semantics remain ACP responsibilities. Gateway creates no
per-chunk spans and holds no Run state.
The HTTP CLIENT span ends when its response body reaches EOF, fails, or closes,
not when response headers arrive. SSE is not pre-read or buffered for tracing.

Gateway records normalized routes, method, status, peer host/port, observed body
sizes and failure classifications. Returned handler errors are observed at
the HTTP boundary, with bounded cause types and safe messages; arbitrary error
strings, query strings, cookies, Authorization, OIDC codes/state and access
subjects are excluded. Handler panic payloads are not exported to traces.

Gateway never collects request/response contents or Header values. This applies
to login, JSON APIs, opaque proxy traffic, files, SSE and WebSocket frames alike.
The observer counts bytes already consumed by the transport; it never buffers
them or reads ahead. There is no Gateway content-mode setting, projection map,
custom payload budget or omission event. Typed RPC diagnostics belong to the
receiving service's protocol adapter and its shared RPC-content switch, not to
this HTTP forwarding layer. Standard SDK export configuration remains available.

Gateway follows the [platform observability contract](../../../docs/observability-contract.md)
but cannot repair a missing downstream SERVER span itself.

## Shutdown And Streams

Signal and listener-error exits cancel and drain WebSocket handlers separately
before telemetry shutdown; ordinary HTTP requests keep their normal drain
window. Deadline exhaustion is reported as a shutdown failure, not a clean drain.
For an admitted WebSocket, cancellation sends a bounded `1001 going away` close
frame in both directions before closing the sockets and joining both relay
workers. Closing the TCP sockets first would hide normal maintenance behind
an abnormal `1006` disconnect. This notification does not cancel a durable Run.

The shutdown contract includes every receive-only long-lived transport: ACP
WebSockets, ACP v1 GET/SSE (including the unversioned v1 alias), Workspace state
Watch and administrator Agent event Watch. Stop cancels their upstream receive
requests and waits for handlers and request telemetry. It never sends an ACP
cancel command or retries a prompt. Ordinary HTTP requests, including ACP
POST/DELETE, keep graceful drain. Regression tests must cover all four HTTP
receive routes on a real listener and signal/restart behavior in Docker;
testing only WebSocket or one Watch route is insufficient.

Managed HTTP receive streams also interrupt blocked downstream writes on
stop. Later per-frame deadlines cannot reopen writing after that cancellation.
If graceful drain expires, Gateway force-closes connections and allows a
separate bounded five-second handler/telemetry cleanup, retaining the original
deadline error. The request-completion counter covers ordinary HTTP as well as
streams, while only receive streams are cancelled before their graceful-drain
window. Compose gives Gateway 30 seconds: the default 15-second grace, up to
five seconds for cancelled handlers, up to five seconds for exporter shutdown,
and margin. Increase the platform stop grace as well when increasing the HTTP
shutdown budget.

Run the service-owned signal regression from the repository root after building
its image:

```sh
docker build -f services/edge-gateway/Dockerfile -t antnest/edge-gateway:local .
node tests/e2e/edge-gateway/shutdown-docker.mjs
```

The regression starts only a Gateway container and a controlled Node HTTP
dependency. Four active receive routes must close on SIGTERM, reopen after a
restart, and close on SIGINT, with both exits zero and no extra upstream
commands. It verifies the image ID and removes only its labeled containers and
network. No database, model Provider or retained deployment is used.

## State, Limits And Capacity

The service has no database, migration, backup, or persistent volume.
Login admission is deliberately replica-local and bounded to 4096 source and
4096 account keys per replica. When a table is full and pruning expired windows
frees no space, new keys are refused with `429` instead of evicting existing
windows. It protects Argon2 work before Identity is called; a shared limiter is
justified only if deployment-scale measurements require cross-replica
enforcement. Event streams are force-reconnected at the stream lease so
Identity revocation and principal disable are rechecked without an Identity
call for every event.

OIDC method discovery and login start are public, no-store browser APIs. The
callback establishes cookies and redirects to `/`; it never returns an access
token to JavaScript. Unknown OIDC paths return JSON `404`, not Console HTML.
SCIM clients use the Identity-issued Bearer credential at the Edge
`/scim/v2` path. A SCIM upstream transport failure is a canonical SCIM `503`.

Workspace WebSockets require a same-origin `Origin` and a valid browser session.
Trusted Organization/Principal/Agent headers are injected server-side.
Browser-supplied identity and the retired access subject are discarded.
ACP owns Agent/Session authorization; Controller is not a chat dependency.
Each client data message performs a bounded Identity resolution before relay;
server output and ping/pong do not create Identity requests. There is no idle
polling. A 1008 close requires fresh session/Agent access;
1013 signals temporary admission unavailability. Neither close changes HTTP
cookies or promises Run cancellation. A reconnect must repeat admission.
The relay supports complete messages up to 64 MiB in either direction and uses
the request timeout for socket writes, not as a maximum Run duration.

The process permits 64 admitting/open ACP connections and four buffered
messages across both directions; this also bounds concurrent message-level
Identity calls. Capacity waits use the dependency timeout. Message assembly
has a one-minute absolute deadline after acquiring a buffer slot, with compression
disabled. Capacity errors return HTTP 503 or WebSocket 1013. Allow memory
headroom beyond the 256 MiB live-payload ceiling for Go allocation/GC and other
service work; these limits are not per-user quotas.
Ping/pong are hop-local; Edge does not generate a new heartbeat. The direct
Docker entry has no idle-proxy lease. An additional load balancer must
configure its WebSocket idle timeout explicitly; keepalive behavior through
arbitrary third-party proxies is not verified.

HTTP/SSE trace completion also runs when a handler unwinds, including
`http.ErrAbortHandler` from interrupted reverse-proxy streams. Gateway ends the
span, retains any already-written HTTP status and marks the execution as
aborted. It does not swallow the panic, write a second response or log its
payload. This keeps the exported ACP/Controller spans attached to an observable
Gateway parent. The boolean `antnest.http.request_cancelled` is emitted only
when the handler unwinds with `http.ErrAbortHandler` and its request context is
cancelled. The span remains `handler_aborted`, not a successful completion. An
arbitrary panic, a live-context abort or an errored dependency is not treated
as normal stream cancellation.

Workspace state GET/SSE uses the same browser identity boundary, with no caller
scope parameters. Its stream is capped by `ANTNEST_EDGE_STREAM_LEASE`; every
reconnect revalidates Identity and reads fresh ACP state. A quiet stream
may therefore retain its last snapshot until lease expiry. On transport loss,
the UI must close actionable state and reconnect with backoff, not poll or
replay a prompt. See [Workspace state](workspace-state.md) for the consumer
contract. State subscriptions have 64 independent slots and do not consume ACP
cancellation capacity. Workspace API SSE streams have their own 64 slots. On
shutdown they are explicitly cancelled and drained, including their trace spans.
No Controller/ACP operation is cancelled by this observation cleanup.
