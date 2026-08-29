# Runtime Controller

Runtime Controller owns desired Runtime state and reconciliation. Given an
`agent_id` and specification, it asks internal providers to converge resources,
admits the matching Rust Runtime generation, and dispatches exclusive Work.

## Responsibilities

- Persist Runtime desired/observed state, generations, and lifecycle operations.
- Reconcile create, stop, replace, retire, and purge intent through a Runtime Provider.
- Authenticate generation-bound Runtime reverse connections.
- Fence stale Runtime generations and Work epochs.
- Dispatch process/file operations without silently retrying ambiguous effects.
- Coordinate `restricted` or `unrestricted` intent with Runtime Egress.
- Expose health, readiness, lifecycle, and Work APIs on the trusted network.

## Non-Responsibilities

- It does not authenticate users or expose a public API.
- It does not own Agent, Prompt, Run, Memory, Skill, Channel, or identity data.
- It does not execute model or Agent-loop logic.
- It does not allow callers to manipulate Docker resources directly.
- It does not execute process or file side effects itself; the Runtime does.
- It does not access Docker Engine, `/dev/net/tun`, nftables, or conntrack.

## Interfaces And Dependencies

| Direction | Interface |
| --- | --- |
| Inbound | Internal HTTP API at `:8080`, defined by [`../../contracts/openapi/runtime-controller-v1.yaml`](../../contracts/openapi/runtime-controller-v1.yaml) |
| Runtime inbound | Reverse WebSocket control endpoint at `:8091` |
| Persistence | PostgreSQL schema owned by this service |
| Compute outbound | Docker Runtime Provider HTTP API |
| Egress outbound | Runtime Egress reservation HTTP API |

Runtime containers connect back to the advertised `:8091` endpoint. The
Controller never dials a Runtime container by a mutable container address.

## Local Development

From the repository root:

```bash
make fmt-check
make go-vet
make test-go
docker compose up -d postgres runtime-egress runtime-provider-docker runtime-controller
curl --fail http://127.0.0.1:8080/readyz
```

Running the service outside Compose requires PostgreSQL plus reachable Egress
and Runtime Provider endpoints. It requires no host privilege.

## Maintainer Guide

- [`docs/architecture.md`](docs/architecture.md): domain model, request flow,
  package ownership, invariants, and extension rules.
- [`docs/operations.md`](docs/operations.md): configuration, ports, privileges,
  resources, readiness, and failure diagnosis.
- [`../../docs/stage-1-runtime.md`](../../docs/stage-1-runtime.md): cross-service
  lifecycle and executable Stage 1 acceptance.
- [`../../contracts/README.md`](../../contracts/README.md): contract ownership
  and compatibility rules.
