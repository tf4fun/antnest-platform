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

## Target Ownership

Antnest Runtime and Runtime Egress are currently implemented. Other service
directories are design drafts and are not compatibility constraints. The
target ownership is:

| Capability | Owner | Explicitly outside the owner |
| --- | --- | --- |
| Agent desired state, generations, rollout, and execution admission | Agent Controller | Platform APIs, packets, policy persistence, MCP implementation |
| Runtime generation realization on Docker or Kubernetes | Runtime Controller | Generation selection, rollout, work dispatch, network policy |
| Agent workspace and platform resource effects | Runtime Controller | Agent retention policy and business records |
| Agent Tunnel IPv4, policy, forwarding, rejection, and address reuse | Rust Runtime Egress | Runtime lifecycle, Runs, Tools, Agent generations |
| Process, filesystem, TUN bootstrap, and MCP side effects | Antnest Runtime | Policy decisions, deployment resources, durable control state |
| Runs, sessions, Agent loop, and MCP invocation | ACP Service | Runtime rollout, address allocation, platform resources |
| Runtime status, MCP, specification, and packet bytes | `contracts/runtime/` | Agent, policy, and deployment-provider persistence |

## Dependency Direction

The target dependency graph is intentionally acyclic:

```text
Management -> Agent Controller -> Runtime Controller -> Docker/Kubernetes
                     |                    |
                     |                    `-> Runtime status
                     `-> Runtime Egress control -> Egress PostgreSQL

ACP Service -> Agent Controller execution grant
ACP Service -> active Antnest Runtime MCP
Antnest Runtime -> Runtime Egress UDP/TUN -> destination network
```

The Runtime never calls PostgreSQL or Docker. Runtime Controller holds platform
credentials but no Egress or Agent database. Runtime Egress owns its private
schema and network privilege. Agent Controller coordinates internal RPCs but
does not read another service's tables. ACP calls only the active Runtime named
by an Agent Controller execution grant.

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
