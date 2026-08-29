# Antnest Platform

Antnest Platform is the Docker-first service architecture for Antnest. This
repository is organized around independently understandable services rather
than around one shared application package.

## Service Map

| Component | Target role | Status |
| --- | --- | --- |
| Antnest Runtime | Executes one Agent's process and filesystem operations and transports Agent packets | Implemented and aligned with Egress |
| Runtime Egress | Rust service owning Agent addresses, network policy, UDP/TUN forwarding, rejection, and address reuse | Implemented and accepted with Runtime |
| Runtime Controller | Thin Docker/Kubernetes execution and resource-association adapter | Future rewrite |
| Agent Controller | Owns Agent lifecycle, Runtime generations, rollout, deletion, and execution admission | Future service |
| ACP Service | Owns Runs, sessions, Agent loop, and MCP calls under an execution grant | Future service |
| Contracts | Language-neutral Runtime, Egress, and internal RPC contracts | Evolving with each rewritten component |

The repository layout and ownership rules are defined in
[`docs/service-layout.md`](docs/service-layout.md). The corrected greenfield
Stage 1 design is canonical in
[`docs/stage-1-runtime.md`](docs/stage-1-runtime.md).

## Current Integration Status

The Rust Runtime and Runtime Egress are implemented and accepted together.
Existing Go service code is a non-authoritative prototype and creates no
compatibility obligation. The thin Runtime Controller and Agent Controller are
the next delivery targets. Stage 1 has an isolated end-to-end acceptance path;
it is not yet an end-user quick start.

## Repository Commands

```bash
make fmt-check   # Go and Rust formatting
make lint        # Go vet and Rust clippy
make test        # Unit and integration tests that need no running Compose stack
make docker-build
make compose-up
make e2e-stage1  # Isolated disposable Stage 1 Runtime/Egress acceptance
```

Use the service-local README before changing a component. It states what that
component owns, what it must not own, and which narrower command validates it.
