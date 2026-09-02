# Service Layout And Ownership

> Status: target service boundaries<br>
> Updated: 2026-08-30

This document defines how Antnest Platform services are separated. Its goal is
not to create more directories. Its goal is to let a maintainer understand and
change one service without reconstructing the whole platform in their head.

Cross-service behavior must also remain understandable from its entrypoint.
The implemented call chains and persistence boundaries are indexed in
[`business-sequences.md`](business-sequences.md); a service-boundary change is
incomplete until the affected sequence is updated.

Antnest Runtime, Runtime Egress, Runtime Controller, Agent ACP Service,
Identity Service, Agent Controller, Edge Gateway, and Admin Console are
implemented. Agent UI, Channel Gateway, and Skill Registry remain pending until
their delivery stage says otherwise.

## Repository Layers

| Path               | Meaning                                                              | May contain                                                                                          |
| ------------------ | -------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `services/<name>/` | Long-lived control-plane or business service                         | Entrypoints, domain/application code, adapters, private persistence, service tests, image definition |
| `runtimes/<name>/` | Managed execution process with a distinct trust or resource boundary | Runtime protocol, side effects, privilege and platform code                                          |
| `contracts/`       | Language-neutral inter-service contracts                             | JSON Schema, RPC schema, examples, compatibility notes                                               |
| `docs/`            | Cross-service architecture and acceptance                            | Service map, stage integration, deployment-wide decisions                                            |

A service must not import another service's implementation. Communication
crosses a language-neutral contract in `contracts/`; shared source code is not
a substitute for a service boundary.

## Required Service Documentation

Every service or runtime must contain:

1. `README.md`: mission, owned resources, non-responsibilities, dependencies,
   interfaces, local commands, implementation status, and links to deeper
   documents.
2. `docs/architecture.md`: domain model, state transitions, module map,
   invariants, failure semantics, and extension rules.
3. An operations or security document when the component owns processes,
   credentials, network access, persistent data, or privileged resources.

The README is the entry point, not a second architecture specification. A fact
has one canonical home: service internals live beside the service; deployment
and cross-service invariants live under repository `docs/`; wire schemas live
under `contracts/`.

## Target Services

| Component          | Sole reason to exist                                     | Owned facts/resources                                                                                                                                          | Explicitly outside it                                                              |
| ------------------ | -------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| Identity Service   | Enterprise identity authority                            | Users, organizations, groups, memberships, OIDC, SCIM, sessions, identity events                                                                               | Agent authorization, Channel signatures, model credentials                         |
| Admin Console      | Administrator UI and thin BFF                            | Page-local presentation state only                                                                                                                             | Business records, direct database access, domain workflows                         |
| Agent UI           | End-user Agent conversation experience                   | Page-local presentation state only                                                                                                                             | Agent Core implementation, Runtime endpoints, lifecycle state                      |
| Channel Gateway    | Adapt external IM protocols to ACP semantics             | Connectors, bindings, external conversation mapping, inbound receipts, deliveries                                                                              | Agent lifecycle, Runs, platform resources                                          |
| Agent Controller   | Agent aggregate and lifecycle authority                  | AgentSpec, immutable configuration/execution revisions, Provider/Model profiles, current Runtime binding, Run admission, rebuild workflow, Agent event journal | Runs, MCP execution, platform SDKs, packets, Skill package bytes                   |
| Runtime Controller | Realize and observe one logical Runtime Environment per Agent | Environment lifecycle head, opaque Runtime revisions, private compute generations, deployment operations, platform associations, bounded Runtime observation journal, platform credentials | Agent desired state, Agent rebuild policy, Agent admission, Tool dispatch, Egress policy |
| Runtime Egress     | Own Agent network identity and outbound packet decisions | Tunnel IPv4 allocation, address quarantine, policy revisions and assignments, packet flows and conntrack                                                       | Runtime lifecycle, Agent generations, Runs, Tools                                  |
| Antnest Runtime    | Expose one isolated Agent workspace through MCP          | Process-local execution state, TUN, four MCP tools                                                                                                             | Durable control state, containers, policy decisions, Agent loop                    |
| Agent ACP Service  | Execute ACP v1/v2 Sessions and Agent Runs                | Sessions, Runs, Turns, context, compression checkpoints, client MCP, Tool attempts                                                                             | Agent construction, Runtime rebuild, platform APIs, Channel objects                |
| Skill Registry     | Govern reusable organization Skill packages              | Skill identity, immutable versions, package, review, distribution manifest                                                                                     | Skill execution, Runtime construction, Agent lifecycle                             |
| Edge Gateway       | Be the sole external application entry                    | Browser sessions, trusted principal projection, external routing, admission, request limits, security headers, and trace propagation                           | Business databases and domain state machines                                       |

The Edge Gateway can be absent during internal development stages. Trusted
Compose clients may call internal RPCs directly, but those RPCs are not public
OpenAPI by implication.

## Runtime And Agent Facts

Six identities must remain distinct:

```text
agent_id               stable Agent identity, never reused
agent_spec_revision    immutable intended Agent behavior
execution_revision     atomically published executable Agent configuration
runtime_revision       opaque cross-service Runtime Environment revision
runtime_generation     private Runtime Controller compute revision
runtime_execution_id   fresh random identity generated on every Runtime PID 1 start
```

Runtime Controller observes platform facts. Agent Controller explicitly
rebuilds and publishes one current ExecutionRevision. Agent ACP Service acquires
one immutable Run snapshot and never caches its Runtime endpoint beyond that
Run.

```text
RuntimeObservation             ExecutionRevision              AgentEvent
platform fact                  published execution binding     Agent semantic fact
Runtime Controller owner       Agent Controller owner          Agent Controller owner
```

Runtime Controller exposes ordered `ListRuntimeObservations`, best-effort
`WatchRuntimeObservations`, and authoritative `InspectRuntime`. Agent
Controller exposes per-Agent `ListAgentEvents` and `WatchAgentEvents`. Watch is
a wake-up mechanism; sequence plus List/Inspect provides recovery correctness.

Agent Controller is not a generic event bus. It does not own arbitrary topics,
consumer groups, Channel messages, identity events, packet events, or raw
platform logs.

## Dependency Direction

The target dependency graph is intentionally acyclic:

```text
Management -> Agent Controller -> Runtime Controller -> Docker/Kubernetes
                     |
                     `-> Runtime Egress control -> Egress PostgreSQL

ACP Service -> Agent Controller Acquire/Finish Run admission
ACP Service -> Runtime MCP named by the immutable Run snapshot
Antnest Runtime -> Runtime Egress UDP/TUN -> destination network

Channel Gateway -> ACP Service
Admin Console / Agent UI -> owning internal services
Edge Gateway -> internal service entrypoints
```

Runtime never calls PostgreSQL or Docker. Runtime Controller owns platform
credentials but no Agent or Egress database. Runtime Egress owns its private
schema and network privilege. Agent Controller coordinates internal RPCs but
does not read another service's tables. ACP calls only the Runtime execution
named by an Agent Controller Run snapshot.

Docker and Kubernetes adapters live inside Runtime Controller. They are not
separate services. A new deployment platform adds an adapter behind the same
domain contract instead of another network hop.

## Data Ownership Rules

1. Every durable fact has exactly one writer service.
2. A service may use its own database, schema, role, migrations, and backup
   policy.
3. Sharing one PostgreSQL server in development does not permit cross-service
   SQL, foreign keys, transactions, or migrations.
   The Compose topology places each PostgreSQL container only on its owner's
   private network; loopback port publishing exists solely for local tests and
   administration.
4. No service reads another service's volume or bootstrap secret.
5. Cross-service deletion is a recoverable workflow of idempotent steps, not a
   distributed transaction.
6. Provider API keys are resolved through Agent Controller's `CredentialStore`
   port and never enter AgentSpec, RuntimeSpec, events, logs, traces, or durable
   Runs.

## Trust Rules

Docker or Kubernetes is trusted infrastructure. Internal control services
trust the deployment network and do not add service JWT, mTLS, or request
signatures during the Docker-first stages. Domain authorization remains the
owner service's responsibility.

The Runtime Supervisor is trusted platform code; Agent-selected operations run
as a separate UID/GID 1000 Executor with no capabilities.
`runtime_execution_id` is a consistency check against stale Runtime MCP calls,
not an authentication credential or rollout generation.

## Adding A Service

Before implementation, define:

1. One sentence describing the service's only reason to exist.
2. The records and external resources it exclusively owns.
3. Inputs and outputs as a language-neutral contract.
4. At least three non-responsibilities that prevent scope growth.
5. Startup dependencies, readiness conditions, and failure semantics.
6. Service-local test commands and one cross-service acceptance path.
7. Logs, traces, metrics, secret redaction, and high-cardinality boundaries.

Do not add a service merely to reduce file count. Split only when ownership,
deployment, scaling, failure isolation, security, or implementation language
creates a real boundary.

## Change Rules

1. A service contract change updates `contracts/` and compatibility tests in
   the same implementation change.
2. A target design may precede code only when it is visibly marked as pending;
   implementation documentation must continue to describe the actual binary.
3. A cross-service invariant change updates the applicable stage document and
   E2E acceptance.
4. A new dependency must be named in the service README and readiness model.
5. No service reads another service's database tables, volumes, or bootstrap
   secrets.
6. Packet forwarding does not emit per-packet traces or payload logs.
