# Service Layout And Ownership

> Status: current service boundaries; unstarted services explicitly marked<br>
> Updated: 2026-09-27

This document defines how Antnest Platform services are separated. Its goal is
not to create more directories. Its goal is to let a maintainer understand and
change one service without reconstructing the whole platform in their head.

Cross-service behavior must also remain understandable from its entrypoint.
Current flows are indexed in [business-flow-entrypoints.md](business-flow-entrypoints.md);
[business-sequences.md](business-sequences.md) retains earlier sequences and links
to their replacements. A service-boundary change is
incomplete until the affected sequence is updated.
Browser workflow ownership and feature-convergence status are maintained in
[`product-surfaces.md`](product-surfaces.md); an intentionally split or pending
surface must not be reported as an implemented Console feature.

Antnest Runtime, Runtime Egress, Runtime Controller, Agent ACP Service,
Identity Service, Agent Controller, Edge Gateway, and Admin Console are
implemented. Agent UI and its production Gateway-to-ACP v1 path are implemented.
Current acceptance is summarized in [current-status.md](current-status.md).
The [Stage 4 plan](stage-4-services.md) records Skill Registry (`skill-registry`),
Channel Manager (`channel-manager`) and Task Scheduler (`task-scheduler`).
Skill Registry has a [minimal technical design](skill-registry-minimal-design.md)
for hosting, Template references and read-only Runtime delivery. Its
[Registry-owned contract](../contracts/skill-registry/registry-api.md) and
[service code](../services/skill-registry/README.md) are present with unit,
contract and PostgreSQL evidence. The [Admin Console Skills module](../services/admin-console/docs/skills.md)
supports publication, frozen Template selection and lifecycle preparation
progress. Controller/RC consumers and the full Template-to-Runtime integration
have disposable Docker business and restore acceptance. Channel Manager and Task
Scheduler are the current names for the earlier planned Channel Gateway and
Scheduler; historical reports retain their original names. The current
[single-node closeout](docker-single-node-closeout.md) excludes these new
services, Kubernetes implementation and horizontal expansion.

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
| Channel Manager (Stage 4 planned) | Own external-channel interaction and adapt it to ACP semantics | Connectors, bindings, external conversation mapping, inbound receipts, deliveries | Agent lifecycle, authoritative Sessions/Runs, platform resources |
| Agent Controller   | Agent aggregate and lifecycle authority | AgentSpec, immutable build/execution revisions, current Provider/model configuration and credentials, Runtime binding, execution publication, lifecycle workflows, management events | Run admission and execution audit, MCP execution, platform SDKs, packets, Skill package bytes |
| Runtime Controller | Realize and observe one logical Runtime Environment per Agent | Environment lifecycle head, opaque Runtime revisions, private compute generations, deployment operations, platform associations, bounded Runtime observation journal, platform credentials | Agent desired state, Agent rebuild policy, Agent admission, Tool dispatch, Egress policy |
| Runtime Egress     | Own Agent network identity and outbound packet decisions | Tunnel IPv4 allocation, address quarantine, policy revisions and assignments, packet flows and conntrack                                                       | Runtime lifecycle, Agent generations, Runs, Tools                                  |
| Antnest Runtime    | Expose one isolated Agent workspace through MCP          | Process-local execution state, TUN, four built-in tools, managed stdio MCP children and bounded Runtime information                                                                                                             | Durable control state, containers, policy decisions, Agent loop                    |
| Agent ACP Service  | Execute ACP v1/v2 Sessions and Agent Runs | Local authorization/admission, Sessions, Runs, Turns, context, checkpoints, Tool attempts, approvals, execution state/audit, volatile Provider clients | Agent construction, Runtime rebuild, Provider administration, platform APIs, Channel objects |
| Skill Registry | Host reusable organization Skill packages | Skill identity, package, immutable versions, bounded metadata lists, organization isolation and fixed-artifact distribution | Template selection, Skill execution, Runtime construction, Agent lifecycle, authoritative installation state |
| Task Scheduler (Stage 4 planned) | Initiate scheduled Agent usage | Schedules and trigger records; detailed semantics pending | Agent lifecycle, ACP Sessions/Runs, Tool execution, another service's database |
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

Runtime Controller observes platform facts. Agent Controller explicitly rebuilds
and publishes the current execution binding. ACP creates an immutable local Run
snapshot from the applied configuration and Session overrides; a Run cannot move
to a replacement Runtime. Organization configuration publication revisions are
separate from immutable build/execution revisions. Current Provider credentials
are updated in volatile clients and are not pinned into Run snapshots.

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

The implemented management and execution paths are separate:

```text
Browser -> Edge Gateway -> Console BFF -> Identity / Agent Controller / ACP audit
Console BFF -> Provider model discovery (current credentials from Controller)
Agent Controller -> Runtime Controller -> Docker (Kubernetes planned)
Agent Controller -> Runtime Egress control -> Egress PostgreSQL
Agent Controller -> ACP configuration publication / Agent settlement

Agent UI / ACP client -> Edge Gateway -> ACP local admission and execution
ACP Service -> Provider model API / Runtime MCP from its local Run snapshot
Antnest Runtime -> Runtime Egress UDP/TUN -> destination network

Edge Gateway -> Identity authentication / Controller discovery / ACP state
Channel Manager -> ACP Service (Stage 4 planned; contract pending)
Task Scheduler -> ACP Service (Stage 4 planned; contract pending)
```

Skill Registry package distribution and its Controller/Runtime consumers follow
the implemented Stage 4 shared contracts.
The [minimal design](skill-registry-minimal-design.md) assigns package versions to
Registry, immutable Template/AgentSpec references to Agent Controller, and
per-Agent artifact preparation/read-only mounts to Runtime Controller. It reuses
Runtime Skill discovery; ACP rejects the retired full-text channel and reads
Skill bodies on demand. Preparation precedes lifecycle disruption and reuses
verified sets by Agent and content identity. Current Agents mount their prepared
per-Agent Skill volume read-only. There is no old business data to migrate in
this development deployment; legacy shared-volume migration is outside its scope.

The independent [Skill learning proposal](skill-learning-design.md) assigns
Agent policy, maintenance scope and budgets to Controller; candidates, evidence,
confirmation and foreground-priority maintenance to ACP; and bounded file
operations to Runtime. Its first delivery requires user confirmation before
idle-time activation and does not execute candidates in the user's Runtime.
Runtime maintenance uses a planned, credential-checked internal endpoint outside
`tools/list`; RC bootstraps its current/next verification key set and freezes the
full set with each accepted operation's deployment identity in a separate L1R
batch. Recovery must not reread changed key configuration. ACP owns signing-key
selection and the authenticated user-action record; explicit Runtime rebuilds
rotate trusted sets, with isolation on compromise. Model tools
remain the four built-ins plus configured MCP tools. These are planned
service-owned batches, not additional implemented ownership
or a fourth Stage 4 service, and do not block the Registry first delivery.

Runtime never calls PostgreSQL or Docker. Runtime Controller owns platform
credentials but no Agent or Egress database. Runtime Egress owns its private
schema and network privilege. Agent Controller coordinates internal RPCs but
does not read another service's tables. Ordinary ACP execution does not call
Controller; it uses the locally applied execution configuration and owns its
terminal audit without a cross-service finish receipt.

The Docker adapter lives inside Runtime Controller. Kubernetes remains planned;
its future implementation belongs behind the same domain contract rather than
in a separate deployment service.

## Data Ownership Rules

1. Every durable fact has exactly one writer service.
2. A service may use its own database, schema, role, migrations, and backup
   policy.
3. Sharing one PostgreSQL server in development does not permit cross-service
   SQL, foreign keys, transactions, or migrations.
   Development and test Compose use one physical PostgreSQL instance with
   separate owner databases and login roles. Loopback publishing is for local
   tests and administration; this topology does not require a shared production
   database server or permit cross-service table access.
4. No service reads another service's volume or bootstrap secret.
5. Cross-service deletion is a recoverable workflow of idempotent steps, not a
   distributed transaction.
6. Controller persists encrypted Provider credentials and publishes current
   authentication to ACP's volatile clients. Console may resolve current
   credentials internally for model discovery. These secret-bearing boundaries
   use metadata-only telemetry; credentials never enter browser responses,
   AgentSpec, RuntimeSpec, audit, Temporal history or durable Runs.

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
