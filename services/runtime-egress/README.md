# Runtime Egress

Runtime Egress is the privileged network data plane for Antnest Runtime
containers. It owns the shared TUN interface, packet validation, per-generation
reservations, DNS forwarding, and unrestricted Internet egress.

## Responsibilities

- Apply and release generation-scoped unrestricted-network reservations.
- Authenticate Runtime tunnel connections with short-lived Controller tokens.
- Forward validated IPv4/TCP packets between Runtime TUN devices and Linux.
- Enforce connection fencing, flow limits, rate limits, and fail-closed policy.
- Provide DNS-over-TCP on the virtual Runtime resolver address.

## Non-Responsibilities

- It does not own Runtime desired state, lifecycle operations, or PostgreSQL.
- It does not create containers or volumes and never receives the Docker socket.
- It does not execute Agent work or understand prompts, tools, or users.
- It does not author organization policy; Stage 1 accepts only restricted or
  unrestricted intent from Runtime Controller.

## Interfaces

| Direction | Interface |
| --- | --- |
| Controller inbound | Reservation HTTP API at `:8081`, defined by [`../../contracts/openapi/runtime-egress-v1.yaml`](../../contracts/openapi/runtime-egress-v1.yaml) |
| Runtime inbound | Authenticated packet WebSocket at `:8092/runtime/v1/tunnel` |
| Kernel | `/dev/net/tun`, nftables, conntrack, and Linux routes |
| External | DNS-over-TCP upstream and ordinary host egress |

The service keeps no database. A signed Runtime token can reconstruct an exact
or newer reservation after an Egress restart; an older generation token cannot
replace newer in-memory intent.

## Development

```bash
cd services/runtime-egress
go test ./...
go vet ./...
```

See [`docs/architecture.md`](docs/architecture.md),
[`docs/operations.md`](docs/operations.md), and the cross-service
[`../../docs/stage-1-runtime.md`](../../docs/stage-1-runtime.md).
