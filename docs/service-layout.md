# Service Layout And Ownership

This document defines how Antnest Platform services are separated. Its goal is
not to create more directories. Its goal is to let a maintainer understand and
change one service without reconstructing the whole platform in their head.

## Repository Layers

| Path | Meaning | May contain |
| --- | --- | --- |
| `services/<name>/` | Long-lived control-plane or business service | Entrypoints, domain/application code, adapters, service tests, image definition |
| `runtimes/<name>/` | Managed execution process with a distinct trust or resource boundary | Runtime protocol implementation, side effects, privilege and platform code |
| `contracts/` | Language-neutral inter-service contracts | OpenAPI, JSON Schema, examples, compatibility notes |
| `docs/` | Cross-service architecture and acceptance | Service map, stage integration, deployment-wide decisions |

A service must not import another service's implementation. Communication
crosses a contract in `contracts/`; shared source code is not a substitute for
a service boundary.

## Required Service Documentation

Every service or runtime must contain:

1. `README.md`: mission, owned resources, non-responsibilities, dependencies,
   public/internal interfaces, local commands, and links to deeper documents.
2. `docs/architecture.md`: internal model, state transitions, package/module
   map, invariants, failure semantics, and rules for extending the service.
3. An operations or security document when the component owns processes,
   credentials, network access, persistent data, or privileged resources.

The README is the entry point, not a second architecture specification. A fact
has one canonical home: service internals live beside the service; deployment
and cross-service invariants live under the repository `docs/`; wire schemas
live under `contracts/`.

## Current Ownership

| Capability | Owner | Explicitly outside the owner |
| --- | --- | --- |
| Runtime desired/observed state and generations | Runtime Controller | Agent prompts, models, sessions, and user identity |
| Docker container and workspace volume effects | Docker Runtime Provider | Desired state, retries, and reconciliation |
| Runtime admission and Work dispatch | Runtime Controller | End-user authentication and authorization |
| Network intent and reservation ordering | Runtime Controller | Packet forwarding and kernel policy |
| Unrestricted egress data plane and DNS | Runtime Egress | Runtime lifecycle and policy authoring |
| Process and filesystem side effects | Antnest Runtime | Docker, PostgreSQL, lifecycle reconciliation |
| TUN bootstrap and local restricted-mode rejection | Antnest Runtime | Selecting the Agent's network policy |
| Lifecycle and Work HTTP API | `runtime-controller-v1.yaml` | Runtime transport implementation details |
| Controller-to-Runtime messages | `contracts/runtime/contract.json` | Business records owned by future services |

## Dependency Direction

The current dependency graph is intentionally small:

```text
future internal callers
        |
        v
Runtime Controller HTTP API ----> PostgreSQL
        |----> Docker Runtime Provider ----> Docker Engine
        |----> Runtime Egress -------------> Linux TUN/network
        v
Controller-to-Runtime contract
        |
        v
Antnest Runtime ----> /workspace, /skills, child processes
```

The Runtime never calls PostgreSQL or Docker. It opens control to Controller and
packet transport to Egress. Controller owns no host privilege: it has neither
Docker socket nor TUN access. Future services call Controller through its
internal API instead of reading its database or calling providers directly.

## Adding A Service

Before implementation, define:

1. One sentence describing the service's only reason to exist.
2. The records and external resources it exclusively owns.
3. Inputs and outputs as a language-neutral contract.
4. At least three non-responsibilities that prevent scope growth.
5. Startup dependencies, readiness conditions, and failure semantics.
6. Service-local test commands and one cross-service acceptance path.

Do not add a service merely to reduce file count. Split only when ownership,
deployment, scaling, failure isolation, security, or implementation language
creates a real boundary.

## Change Rules

1. A service contract change updates `contracts/` and its compatibility tests
   in the same change.
2. A service-local behavior change updates that service's documentation, not a
   platform-wide document by default.
3. A cross-service invariant change updates the applicable stage document and
   E2E acceptance.
4. A new dependency must be named in the service README and readiness model.
5. No service reads another service's database tables, volumes, or bootstrap
   secrets.
