# Runtime Controller Operations

## Runtime Requirements

The service requires:

- PostgreSQL 17-compatible storage.
- A reachable Docker Runtime Provider internal endpoint.
- A reachable Runtime Egress internal endpoint and advertised packet endpoint.
- A dedicated internal Docker network for Runtime reverse connections.
- A prebuilt `antnest/antnest-runtime:local` image in the development setup.

This service requires no host privilege. Docker socket access belongs only to
Docker Runtime Provider; TUN and `NET_ADMIN` belong only to Runtime Egress.

## Configuration

| Variable | Required | Default | Meaning |
| --- | --- | --- | --- |
| `ANTNEST_RUNTIME_DATABASE_URL` | yes | none | Controller-owned PostgreSQL DSN |
| `ANTNEST_RUNTIME_ADVERTISED_ENDPOINT` | yes | none | Stable IPv4 authority Runtime containers use for reverse connections |
| `ANTNEST_RUNTIME_EGRESS_URL` | yes | none | Runtime Egress internal reservation API |
| `ANTNEST_RUNTIME_EGRESS_ENDPOINT` | yes | none | Stable IPv4 authority Runtime containers use for packet tunnels |
| `ANTNEST_RUNTIME_PROVIDER_URL` | yes | none | Docker Runtime Provider internal API |
| `ANTNEST_RUNTIME_MANAGEMENT_NETWORK` | yes | none | Dedicated Docker network attached to Runtime containers |
| `ANTNEST_RUNTIME_TOKEN_SECRET` | yes | none | At least 32 bytes used to derive generation admission tokens |
| `ANTNEST_RUNTIME_LISTEN` | no | `:8080` | Internal lifecycle and Work API listen address |
| `ANTNEST_RUNTIME_CONTROL_LISTEN` | no | `:8091` | Runtime reverse control listen address |
| `ANTNEST_RUNTIME_TUNNEL_CIDR` | no | `100.64.0.0/10` | Virtual Runtime egress address pool |
| `ANTNEST_RUNTIME_DNS_IPV4` | no | `100.64.0.1` | Virtual DNS endpoint in the tunnel |

Standard OpenTelemetry environment variables configure telemetry export. Do
not place token secrets in command-line flags or logs.

## Ports And Networks

| Endpoint | Audience | Compose exposure |
| --- | --- | --- |
| `:8080` | Trusted internal callers and health checks | `127.0.0.1:8080` in development |
| `:8091` | Managed Runtime control | Runtime management network only |
| PostgreSQL `:5432` | Controller | Control network only; loopback `:55432` for development |

The management network is internal. Runtime containers attach only to it and
use TUN for unrestricted egress; they do not join the Controller's control or
egress network.

## Readiness And Startup

`/healthz` proves the process can serve HTTP. `/readyz` additionally requires:

1. PostgreSQL is reachable.
2. Runtime Egress reports ready.
3. Docker Runtime Provider reports ready.

On startup the service migrates its own schema, restores Ready Runtime
reservations through Egress, scans durable non-terminal operations, and opens
Runtime admission only after dependencies initialize.

## Coordinated Runtime Resources

For `agent_id=<id>` the Controller requests deterministic Provider resources:

- Container: `antnest-runtime-<id>`.
- Workspace volume: `antnest-workspace-<id>`.
- Shared system Skill volume managed for Runtime mounts.

Stop retains compute and workspace state. Retire removes compute but retains
the workspace. Purge removes both. Operators should use the lifecycle API, not
manual Docker deletion, so PostgreSQL and observed state remain convergent.

## Failure Diagnosis

1. Check `/readyz`; a failure isolates service dependencies from one Runtime's
   lifecycle failure.
2. Read the Runtime and lifecycle operation through the internal API. Branch on
   stable Problem Details `code`, not human-readable detail.
3. Inspect the deterministic container name and Provider/Controller logs using
   `agent_id`, generation, operation ID, and trace ID.
4. Treat `unknown` as an ambiguous external effect. Observe convergence; do not
   issue a replacement command until it resolves.
5. A Runtime that cannot connect usually indicates advertised endpoint,
   management network, token generation, image startup, or privilege failure.

## Development Commands

```bash
make test-go
make docker-build
make compose-up
make e2e-stage1
make compose-down
```

`make e2e-stage1` creates and destroys uniquely named Runtime resources. Run it
serially against the repository Compose stack.
