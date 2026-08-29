# Docker Runtime Provider Operations

## Privilege

The mounted Docker Unix socket grants host-level container administration. It
must be mounted only into this service. The Provider requires neither
`NET_ADMIN` nor `/dev/net/tun`.

## Configuration

| Variable | Required | Default | Meaning |
| --- | --- | --- | --- |
| `ANTNEST_RUNTIME_PROVIDER_LISTEN` | no | `:8082` | Internal Provider API |
| `ANTNEST_RUNTIME_DOCKER_SOCKET` | no | `/var/run/docker.sock` | Docker Engine Unix socket |

`/readyz` calls Docker `/_ping`; a running HTTP process without a reachable
Engine is not ready. The service is stateless and may be restarted without
reconstructing application state.
