# Antnest Platform

Antnest Platform is the Docker-first service architecture for Antnest. This
repository is organized around independently understandable services rather
than around one shared application package.

## Service Map

| Component | Target role | Status |
| --- | --- | --- |
| Antnest Runtime | Executes one Agent's process and filesystem operations and transports Agent packets | Implemented and aligned with Egress |
| Runtime Egress | Rust service owning Agent addresses, network policy, UDP/TUN forwarding, rejection, and address reuse | Implemented and accepted with Runtime |
| Runtime Controller | Logical Runtime Environment lifecycle, private deployment realization, and platform observation with an in-process Docker adapter | Implemented and accepted for Docker |
| Agent Controller | Owns Agent lifecycle, immutable configuration/execution revisions, explicit Runtime rebuild, Run admission, and Agent events | Future service |
| Agent ACP Service | Owns ACP v2 Sessions, Runs, context, model/Tool loop, and per-Run Runtime MCP calls | Implemented for Stage 2 |
| Identity Service | Owns Organizations, Users, local login, OIDC, SCIM, credentials, and the directory journal | Implemented for Stage 2 |
| Contracts | Language-neutral Runtime, Egress, Agent Controller, ACP, and Identity contracts | Evolving with each rewritten component |

The repository layout and ownership rules are defined in
[`docs/service-layout.md`](docs/service-layout.md). The greenfield Stage 1
Runtime/Egress design is canonical in
[`docs/stage-1-runtime.md`](docs/stage-1-runtime.md).

The reviewed Stage 2 Agent lifecycle and ACP target design is defined in
[`docs/stage-2-agent-and-acp.md`](docs/stage-2-agent-and-acp.md). It replaces
older candidate/active Runtime rollout and transparent MCP-switching concepts
for the future Agent Controller and Agent ACP Service.

## Current Integration Status

The Rust Runtime, Runtime Egress, and thin Go Runtime Controller are implemented
and accepted together. Stage 2 adds the independently deployable Agent ACP and
Identity services; Agent Controller remains the missing lifecycle authority
needed to connect those services into the complete Agent creation path. Stage
1 and completed Stage 2 services have isolated PostgreSQL and protocol
acceptance paths; this is not yet an end-user quick start.

## Repository Commands

```bash
make fmt-check   # Go and Rust formatting
make lint        # Go vet and Rust clippy
make test        # Unit and integration tests that need no running Compose stack
make docker-build
make compose-up
make e2e-stage1  # Isolated disposable Stage 1 Runtime/Egress acceptance
make e2e-runtime-controller  # Isolated Runtime Controller lifecycle acceptance
make test-agent-acp-postgres  # Agent ACP persistence and protocol acceptance
make test-identity-postgres   # Identity persistence, OIDC, and SCIM acceptance
```

Use the service-local README before changing a component. It states what that
component owns, what it must not own, and which narrower command validates it.
