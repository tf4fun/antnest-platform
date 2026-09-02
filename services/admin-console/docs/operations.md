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

An overview with unavailable Agent inventory is never emitted: that failure
fails the request. Optional section envelopes should be surfaced as partial-data
notices by the UI. Repeated degradation indicates an owning service or network
fault; there is no aggregate cache to repair.
