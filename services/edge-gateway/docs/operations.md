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
