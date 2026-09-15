# Edge Gateway Operations

## Configuration

| Variable | Required | Purpose |
| --- | --- | --- |
| `ANTNEST_EDGE_LISTEN` | no | HTTP listen address, default `:8080` |
| `ANTNEST_IDENTITY_SERVICE_URL` | yes | trusted Identity Service base URL |
| `ANTNEST_ADMIN_CONSOLE_URL` | yes | trusted Admin Console base URL |
| `ANTNEST_AGENT_UI_URL` | yes | trusted Agent UI static-service base URL |
| `ANTNEST_AGENT_CONTROLLER_URL` | yes | trusted Agent Controller base URL for ID/name discovery only |
| `ANTNEST_AGENT_ACP_URL` | yes | trusted Agent ACP Service base URL |
| `ANTNEST_EDGE_COOKIE_SECURE` | no | require HTTPS cookies, default `true` |
| `ANTNEST_EDGE_REQUEST_TIMEOUT` | no | non-streaming dependency timeout |
| `ANTNEST_EDGE_SHUTDOWN_TIMEOUT` | no | ordinary HTTP graceful-drain budget, default `15s` |
| `ANTNEST_EDGE_STREAM_LEASE` | no | maximum authenticated SSE lifetime, default `5m` |
| `ANTNEST_EDGE_LOGIN_WINDOW` | no | in-memory login admission window, default `5m` |
| `ANTNEST_EDGE_LOGIN_SOURCE_MAX` | no | attempts per source/window, default `30` |
| `ANTNEST_EDGE_LOGIN_ACCOUNT_MAX` | no | attempts per normalized account/window, default `10` |
| `OTEL_*` | no | standard OTLP HTTP/protobuf signal configuration |

The accepted deployment is the direct, loopback HTTP Docker entry with the
explicit development cookie policy. Production TLS termination needs separate
proxy/trust design and acceptance: same-origin checks derive the scheme from
the actual request TLS state, not forwarded headers. An HTTPS-facing proxy
forwarding plain HTTP is not supported merely by preserving the Host or adding
`X-Forwarded-Proto`. Secure cookies alone do not resolve that mismatch.

`GET /status` reports Gateway's own initialized listener. It never probes
Identity, Controller, Console, UI or ACP. Check each container's health and real
business requests separately to establish deployment readiness. Shutdown
stops admission, drains HTTP requests, and flushes OTLP within a bounded
timeout.

## Request Diagnostics

The public response carries `X-Antnest-Trace-ID`. In Jaeger, expect Gateway
SERVER -> shared HTTP CLIENT -> downstream SERVER. Identity/Controller RPC
clients no longer create a second CLIENT span. Reverse proxies share the same
Transport; the WebSocket dial wrapper traces its handshake separately from messages.

Each client ACP request or notification starts a bounded Gateway message trace,
linked to the connection trace rather than parented by its long-lived HTTP span.
The message SERVER includes session revalidation; its CLIENT covers forwarding
to ACP, not waiting for the eventual protocol response. W3C context is injected
into standard ACP `params._meta`; caller-supplied trace context is replaced.
ACP dispatch, Run execution, model and Runtime calls inherit this context.
Message spans record method and byte count only, never prompt or response content.
Responses, binary frames and malformed envelopes remain unchanged; validation
and execution semantics remain ACP responsibilities. No per-chunk spans or
Gateway Run state is introduced.
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

This Gateway implementation does not claim that other services already obey
the [platform contract](../../../docs/observability-contract.md). In particular,
Gateway cannot repair a missing downstream SERVER span itself.

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
POST/DELETE, keep graceful drain. The C5-04 regression batch must prove all four
HTTP receive routes on a real listener and signal/restart behavior in Docker;
testing only WebSocket or one Watch route is insufficient.
Managed HTTP receive streams must also interrupt blocked downstream writes on
stop. Later per-frame deadlines cannot reopen writing after that cancellation.
If graceful drain expires, force-close connections and allow a separate bounded
five-second handler/telemetry cleanup; retain the original deadline error.
The request-completion counter covers ordinary HTTP as well as streams, while
only receive streams are cancelled before their graceful-drain window.
Compose gives Gateway 30 seconds: the default 15-second grace, up to five
seconds for cancelled handlers, up to five seconds for exporter shutdown, and
margin. Increase the platform stop grace as well when increasing the HTTP
shutdown budget.

Run the service-owned signal regression after building its image:

```sh
docker build -f services/edge-gateway/Dockerfile -t antnest/edge-gateway:local .
node services/edge-gateway/tests/shutdown-docker.mjs
```

The regression starts only a Gateway container and a controlled Node HTTP
dependency. Four active receive routes must close on SIGTERM, reopen after a
restart, and close on SIGINT, with both exits zero and no extra upstream
commands. It verifies the image ID and removes only its labeled containers and
network. No database, model Provider or retained deployment is used; the local
trace-order tests do not substitute for C6's Jaeger report.

The service has no database, migration, backup, or persistent volume.
Login admission is deliberately replica-local and bounded to 4096 source and
account keys per replica. It protects Argon2 work before Identity is called; a
future shared limiter is justified only if deployment-scale measurements require
cross-replica enforcement. Event streams are force-reconnected at the stream
lease so Identity revocation and principal disable are rechecked without an
Identity call for every event.

OIDC method discovery and login start are public, no-store browser APIs. The
callback establishes cookies and redirects to `/`; it never returns an access
token to JavaScript. Unknown OIDC paths must return JSON `404`, not Console HTML.
SCIM clients use the Identity-issued Bearer credential at the Edge
`/scim/v2` path. A SCIM upstream transport failure is a canonical SCIM `503`.

Workspace WebSockets require a same-origin `Origin` and a valid browser session.
Trusted Organization/Principal/Agent headers are injected server-side.
Browser-supplied identity and the retired access subject are discarded.
ACP owns Agent/Session authorization; Controller is not a chat dependency.
Each client data message performs a bounded Identity resolution before relay;
server output and ping/pong do not create Identity requests. There is no idle
polling or new configuration. A 1008 close requires fresh session/Agent access;
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
service work; these limits are not per-user quotas or a claim of load acceptance.
Ping/pong are hop-local; Edge does not generate a new heartbeat. The current
direct Docker entry has no idle-proxy lease. An additional load balancer must
configure its WebSocket idle timeout explicitly; arbitrary third-party proxy
keepalive behavior has not been accepted by this batch.

HTTP/SSE trace completion must also run when a handler unwinds, including
`http.ErrAbortHandler` from interrupted reverse-proxy streams. End the Gateway
span, retain any already-written HTTP status and mark the execution as aborted.
Do not swallow the panic, write a second response or log its payload. This keeps
the exported ACP/Controller spans attached to an observable Gateway parent.
The boolean `antnest.http.request_cancelled` is emitted only when the handler
unwinds with `http.ErrAbortHandler` and its request context is cancelled. The
span remains `handler_aborted`, not a successful completion. Maintenance
verification combines this marker with the exact Watch trace, HTTP 200, the
observed stop window and clean service exits. An arbitrary panic, a live-context
abort or an errored dependency is not accepted as normal stream cancellation.

Workspace state GET/SSE uses the same browser identity boundary, with no caller
scope parameters. Its stream is capped by `ANTNEST_EDGE_STREAM_LEASE`; every
reconnect revalidates Identity and reads fresh ACP state. A quiet stream
may therefore retain its last snapshot until lease expiry. On transport loss,
the UI must close actionable state and reconnect with backoff, not poll or
replay a prompt. See [Workspace state](workspace-state.md) for the consumer
contract. New subscriptions have 64 independent slots and do not consume ACP
cancellation capacity. On shutdown they are explicitly cancelled and drained,
including their trace spans. No Controller/ACP operation is cancelled by this
observation cleanup. This batch does not add a Gateway database.
