# Edge Gateway Operations

## Configuration

| Variable | Required | Purpose |
| --- | --- | --- |
| `ANTNEST_EDGE_LISTEN` | no | HTTP listen address, default `:8080` |
| `ANTNEST_IDENTITY_SERVICE_URL` | yes | trusted Identity Service base URL |
| `ANTNEST_ADMIN_CONSOLE_URL` | yes | trusted Admin Console base URL |
| `ANTNEST_AGENT_UI_URL` | yes | trusted Agent UI static-service base URL |
| `ANTNEST_AGENT_CONTROLLER_URL` | yes | trusted Agent Controller base URL for workspace projection |
| `ANTNEST_AGENT_ACP_URL` | yes | trusted Agent ACP Service base URL |
| `ANTNEST_EDGE_COOKIE_SECURE` | no | require HTTPS cookies, default `true` |
| `ANTNEST_EDGE_REQUEST_TIMEOUT` | no | non-streaming dependency timeout |
| `ANTNEST_EDGE_STREAM_LEASE` | no | maximum authenticated SSE lifetime, default `5m` |
| `ANTNEST_EDGE_LOGIN_WINDOW` | no | in-memory login admission window, default `5m` |
| `ANTNEST_EDGE_LOGIN_SOURCE_MAX` | no | attempts per source/window, default `30` |
| `ANTNEST_EDGE_LOGIN_ACCOUNT_MAX` | no | attempts per normalized account/window, default `10` |
| `OTEL_*` | no | standard OTLP HTTP/protobuf signal configuration |

Production TLS may terminate at a load balancer immediately before Edge
Gateway. In that case secure cookies remain enabled and the trusted proxy must
preserve the original scheme.

`GET /status` is ready only when Identity Service, Agent Controller, Admin
Console, Agent UI, and Agent ACP Service answer their status probes. Shutdown
stops admission, drains HTTP requests, and flushes OTLP within a bounded
timeout.
Signal and listener-error exits cancel and drain WebSocket handlers separately
before telemetry shutdown; ordinary HTTP requests keep their normal drain
window. Deadline exhaustion is reported as a shutdown failure, not a clean drain.

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
Agent access subjects are injected server-side and must never appear in browser
bootstrap JSON, logs, or traces.
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
