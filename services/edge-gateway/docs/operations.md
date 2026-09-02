# Edge Gateway Operations

## Configuration

| Variable | Required | Purpose |
| --- | --- | --- |
| `ANTNEST_EDGE_LISTEN` | no | HTTP listen address, default `:8080` |
| `ANTNEST_IDENTITY_SERVICE_URL` | yes | trusted Identity Service base URL |
| `ANTNEST_ADMIN_CONSOLE_URL` | yes | trusted Admin Console base URL |
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

`GET /status` is ready only when Identity Service and Admin Console answer their
status probes. Shutdown stops admission, drains HTTP requests, and flushes OTLP
within a bounded timeout.

The service has no database, migration, backup, or persistent volume.
Login admission is deliberately replica-local and bounded to 4096 source and
account keys per replica. It protects Argon2 work before Identity is called; a
future shared limiter is justified only if deployment-scale measurements require
cross-replica enforcement. Event streams are force-reconnected at the stream
lease so Identity revocation and principal disable are rechecked without an
Identity call for every event.

Before OIDC/SCIM ingress is connected, a JSON `503 protocol_unavailable` on the
reserved prefixes is expected. An HTML `200` on either prefix is a routing
regression.
