# Antnest Platform

Antnest Platform is the Docker-first service architecture for Antnest. This
repository is organized around independently understandable services rather
than around one shared application package.

## Service Map

| Component | Role | Maintainer entry point |
| --- | --- | --- |
| Runtime Controller | Owns Runtime desired state, admission, reconciliation, and Work dispatch | [`services/runtime-controller/README.md`](services/runtime-controller/README.md) |
| Runtime Egress | Owns privileged TUN, DNS, packet forwarding, and network reservations | [`services/runtime-egress/README.md`](services/runtime-egress/README.md) |
| Docker Runtime Provider | Applies stateless container and volume effects through Docker Engine | [`services/runtime-provider-docker/README.md`](services/runtime-provider-docker/README.md) |
| Antnest Runtime | Executes one Agent's process and file operations inside an isolated container | [`runtimes/antnest-runtime/README.md`](runtimes/antnest-runtime/README.md) |
| Contracts | Defines the HTTP and Controller-to-Runtime protocol boundary | [`contracts/README.md`](contracts/README.md) |

The repository layout and documentation rules for current and future services
are defined in [`docs/service-layout.md`](docs/service-layout.md). The earlier
Stage 1 cross-service behavior is retained only as a historical architecture
snapshot in [`docs/stage-1-runtime.md`](docs/stage-1-runtime.md).

## Current Integration Status

The Rust Runtime now implements the repository's sole Runtime contract. The Go
Controller and Egress prototypes have not yet been rebuilt around that contract,
so the repository intentionally has no current end-to-end quick start. Validate
each rewritten component through its local README until cross-service acceptance
is restored.

## Repository Commands

```bash
make fmt-check   # Go and Rust formatting
make lint        # Go vet and Rust clippy
make test        # Unit and integration tests that need no running Compose stack
make docker-build
make compose-up
make e2e-stage1  # Destructive Stage 1 acceptance against the local stack
```

Use the service-local README before changing a component. It states what that
component owns, what it must not own, and which narrower command validates it.
