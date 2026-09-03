# Admin Console Operations

## Configuration

| Variable | Required | Purpose |
| --- | --- | --- |
| `ANTNEST_ADMIN_CONSOLE_LISTEN` | no | HTTP listen address, default `:8080` |
| `ANTNEST_IDENTITY_SERVICE_URL` | yes | trusted Identity Service base URL |
| `ANTNEST_AGENT_CONTROLLER_URL` | yes | trusted Agent Controller base URL |
| `ANTNEST_ADMIN_DEFAULT_RUNTIME_IMAGE_REF` | no | digest-prefill shown when creating a Template |
| `ANTNEST_ADMIN_DEPENDENCY_TIMEOUT` | no | bounded non-streaming RPC timeout |
| `OTEL_*` | no | standard OTLP HTTP/protobuf signal configuration |

`GET /status` requires both dependencies to be ready. The compiled React assets
are embedded into the binary, so no writable web volume is required.

Admin Console must not be published directly. Edge Gateway is its only
supported external path. The service has no database, migrations, backup, or
persistent volume.

The browser derives OIDC and SCIM setup addresses from the public Edge origin,
so there is deliberately no Admin Console environment variable for either
external URL. A reverse proxy must preserve the public origin seen by the
browser and route `/protocol/oidc/callback` and `/scim/v2` to Edge Gateway.

Local password rotation has no service-side configuration. Credential fields
are request-only and must not be added to access logs, traces, environment
variables, or retry storage. Existing browser sessions remain governed by
Identity access-token lifetime and explicit logout.

An overview with unavailable Agent inventory is never emitted: that failure
fails the request. Optional section envelopes should be surfaced as partial-data
notices by the UI. Repeated degradation indicates an owning service or network
fault; there is no aggregate cache to repair.
