# Runtime Controller Architecture

> Status: implemented for Docker; Kubernetes adapter pending<br>
> Updated: 2026-09-07

## Mission

Execute the explicit Initialize, Update, Disable, Enable, and Delete lifecycle
of one Agent Runtime Environment on a deployment platform. Physical compute,
workspace, generation, and platform identity stay private. Agent Controller
decides when each command is issued; network policy and Tool execution stay
outside this service.

## Core Model

```text
RuntimeEnvironment
  agent_id
  opaque runtime_revision
  lifecycle_state

RuntimeConfiguration
  immutable image
  Egress attachment
  resource policy

PrivateDeployment
  agent_id
  internal generation
  injected RuntimeSpec
  platform mapping

DeploymentOperation
  request_id
  agent_id
  target_revision
  kind: initialize | update | disable | enable | delete
  request_digest
  state: running | completed | failed | unknown
  effect: completed | not_started | unknown

RuntimeInspection
  agent_id
  runtime_revision
  lifecycle_state
  health
  endpoint
  execution_id, when status has been verified
  observed_at

RuntimeObservation
  sequence
  scope: service | environment | runtime_generation
  agent_id and runtime_revision for non-service facts
  execution_id, when known
  kind
  observed_at
  diagnostic_summary
```

`RuntimeConfiguration` is caller-owned intent supplied to Initialize, Update,
and Enable. It is not a durable Agent desired-state replica. Runtime Controller
injects identity, generation, listener and filesystem invariants, then maps the
result to private platform resources. The platform remains physical
current-state authority; the private Environment head records only lifecycle
and concurrency facts that cannot be inferred from platform presence.

The immutable digest is computed from the canonical Docker create request and
resource name, not from a parallel summary or only the caller's JSON. It
therefore covers the selected management network, system-Skill volume,
forwarded Runtime telemetry environment, mount types, device permissions,
capability drop/add sets, security options, healthcheck, resource limits, and
restart policy. A versioned adapter mapping makes a physical mapping change
explicit.

The observation journal is a bounded diagnostic and delivery history. It does
not replace platform List/Inspect as current-state authority.

## Identity

`agent_id` identifies one Runtime Environment. `runtime_revision` is an opaque
cross-service CAS token. An operation's `target_revision` is derived before
execution and remains stable through `running`, `unknown`, and terminal retry.
It becomes the Environment's current `runtime_revision` only when that
operation commits the corresponding lifecycle head. Callers compare these
values but never parse or increment them.

Runtime Controller privately allocates a numeric generation whenever
Initialize, Update, or Enable creates compute. `(agent_id, generation)` remains
the immutable platform identity and is permanently bound to one deployment
digest. Container presence is not authority for that binding. A present
resource without a matching private claim is drift and is never adopted,
reported as valid, or deleted through the ordinary lifecycle path.

`execution_id` identifies one Runtime PID 1 lifetime. Runtime creates it, not
Runtime Controller. A same-generation process restart must produce a new value.
Runtime Controller reads the value from `/status` only after platform health is
Healthy.

Platform resource IDs, container IPs, restart counters, and endpoint addresses
are observations, not Agent identity.

Domain inspection, operation, and observation values store Runtime identity
once. Flattening `agent_id` and `generation` for JSON or SQL is an adapter
concern; adapters must never combine a requested key with labels read from a
different platform resource.

## Mutation Serialization

All Runtime and workspace mutations for one Agent execute under one
PostgreSQL-backed Agent lock. The lock is the cross-replica execution right,
not merely a request de-duplication record. It removes these races:

- concurrent retries executing the same Docker mutation twice;
- Create/Delete overtaking one another;
- workspace deletion between Create's storage check and container creation;
- a stale attempt overwriting a newer terminal operation result.

Advisory locks use a bounded connection pool separate from ordinary repository
queries. Holding many long platform operations therefore cannot consume every
query connection. A lock connection that cannot be conclusively unlocked is
discarded instead of being returned to the pool with session state attached.
The lock session is probed on that same reserved connection throughout the
mutation. Session loss cancels the callback with a stable cause and discards
the connection.
The service-level mutation deadline covers lock acquisition, persistence,
platform calls, and readiness verification. Lock acquisition uses bounded
`pg_try_advisory_lock` retries rather than an unbounded database wait.
After leadership is acquired, the service reserves part of the same absolute
deadline for terminal persistence. Client cancellation may be detached for
that safety write but never creates a later deadline; an expired lock session
is discarded so PostgreSQL releases it with the connection.

After acquiring the lock, the service reloads the operation. A terminal
operation is returned without a platform call. A `running` or `unknown`
operation left by a crashed process is reconciled idempotently while the lock
is held. A partial unique database constraint permits only one such
non-terminal operation per Agent; a different request ID cannot start until it
becomes terminal, while the exact original request may reconcile it. This
durable operation slot closes the interval between PostgreSQL releasing a lost
advisory-lock session and its former holder observing cancellation. Every
recovery claims a monotonically increasing private attempt number. Terminal
persistence compares that attempt, so a stale executor cannot overwrite the
recovering executor. The Docker adapter re-inspects deterministic containers
and volumes after concurrent-create conflicts and converges only exact
identity. Attempt numbers never enter the RPC contract. Terminal persistence
uses an attempt-checked update and a bounded
service context after a platform side effect may have begun so client
disconnect cannot strand the operation at `running`.

## Lifecycle Commands

Every command validates its lifecycle precondition and expected revision while
holding the Agent mutation lock. The operation journal and Environment head are
updated transactionally. Platform substeps are idempotent convergence actions;
the service does not persist an imperative step counter.

### Initialize

Initialize is valid only when no Environment exists. Runtime Controller creates
or adopts the owned workspace, allocates a private generation, builds the full
RuntimeSpec from caller configuration plus service invariants, creates compute,
waits for platform health, verifies Runtime `/status`, and commits state
`ready`. A workspace created before compute failure remains owned by the Agent
and is reused by the exact retry.

### Update

Update is valid only from `ready` with a matching expected revision. Runtime
Controller removes the exact current compute resource, preserves the workspace,
allocates a new private generation, creates and verifies the replacement, then
commits a new revision. It does not roll back to old compute after a destructive
effect; uncertainty retains the mutation slot for exact-request recovery.

### Disable And Enable

Disable is valid only from `ready`. It deletes compute and commits `disabled`
while preserving workspace. A stopped container is not retained because that
would leak Docker behavior and would not release portable compute resources.

Enable is valid only from `disabled`. It receives the latest complete caller
configuration, allocates a new private generation, and creates verified compute
over the existing workspace. Runtime Controller therefore stores no Agent
desired configuration while disabled.

### Delete

Delete is valid from `ready` or `disabled`. It removes exact owned compute when
present, then removes the owned workspace and commits the terminal `deleted`
state. A deleted Agent identifier cannot be initialized again. Partial deletion
is retried under the same operation identity.

### Inspect

Inspect loads the logical Environment head. For `ready`, it verifies the private
generation claim against platform identity and performs one bounded Runtime
`/status` request. The cross-service response contains lifecycle, opaque
revision, health, MCP endpoint, execution identity, and observation time only.
It never returns generation, digest, container/Pod ID, volume ID, or platform
phase.

Runtime Controller does not resolve Egress configuration or choose an image.
Agent Controller and Runtime Egress provide that policy input. Runtime
Controller alone injects physical RuntimeSpec and platform invariants.

### Resolve Image

The separate read-only image query translates a caller-selected `repository:tag`
into an installed Docker image ID. It does not choose the image, pull from a
registry, or change an Environment. The Docker adapter owns reference parsing
and inspection; the control layer delegates without repository access, an Agent
lock, or an operation journal entry. A mutable tag lookup is not cached.

The response includes only the normalized named reference and immutable image
ID. Docker configuration, environment variables, labels, and history never
leave the adapter. A locally built image need not have a registry manifest
digest; its image ID must not be presented as a `repository@manifest-digest`.
The caller is responsible for freezing the resolved ID when publishing its
configuration. Subsequent lifecycle commands still require an immutable image.
Resolution has the ordinary RPC deadline and a short platform child span, with
bounded operation labels rather than image names or IDs in metric dimensions.

## Observation Pipeline

Runtime Controller uses both platform List and Watch:

```text
Docker/Kubernetes health and events
  -> platform adapter normalization
  -> optional one-shot Runtime status verification
  -> RuntimeObservation append
  -> List/Watch RPC consumers
```

Exactly one Controller replica holds the PostgreSQL observation-leadership
lock and consumes the platform Watch. The leader announces shared readiness
only after the deployment platform accepts the Watch request; inventory
reconciliation alone is never treated as an active stream. Followers probe
that shared readiness lease rather than trusting leadership ownership. Other
replicas remain available for control RPCs and continuously contend for
leadership. Observation commits send
a transaction-scoped PostgreSQL notification; every replica turns that shared
wakeup into a local SSE Hub notification. Notifications carry no facts and may
coalesce: consumers always recover facts from the ordered journal.

Startup verifies the journal and wake-up paths separately. An insert/read probe
uses a reserved explicit sequence and is rolled back, so it neither creates a
fake Runtime fact nor advances the production sequence. A uniquely identified,
payload-only `NOTIFY` is committed and must return through the local LISTEN
callback; every replica filters these probe payloads before waking clients.

Rules:

1. Platform List/Inspect is the current-state authority.
2. Watch lowers detection latency but may disconnect, repeat, reorder, or omit
   intermediate events.
3. Every stored observation receives one monotonically increasing, potentially
   sparse service sequence. Numeric discontinuity alone is not data loss.
4. A consumer resumes with `ListRuntimeObservations(after_sequence)` before
   reopening Watch.
5. A cursor older than the retained journal receives
   `observation_cursor_expired` plus a reset sequence. The consumer reconstructs
   from logical Runtime List before resuming; retention expiry is not a
   platform observation gap.
6. On a detected platform gap, the service first records one service-wide
   `observation_gap`, reconciles physical inventory in both directions against
   logical ready Environment heads, and records one service-wide `reconciled`
   fact. Missing expected compute emits `runtime_missing`. A gap is valid even
   when List returns no Runtime.
7. Consumers treat a service-wide gap as a requirement to List logical Runtime
   Environments. It is not a fabricated per-Runtime transition.
8. It never fabricates a restart count, cause, or intermediate transition.
   A failed Runtime `/status` request is `status_unverified`, not
   `unhealthy`; platform health and status verification are separate facts.
9. Candidate and active semantics do not exist here. Agent Controller owns Run
   admission around lifecycle commands; physical generations stay private.
10. A resource selected by the Antnest managed-resource filter but carrying
   malformed or incomplete identity labels is explicit drift. List or Watch
   fails reconciliation and keeps observation readiness false; it is never
   silently skipped before a `reconciled` fact.
11. Every Runtime-scoped platform event carries the observed deployment digest
    and must match the private generation claim before it enters the journal.

Runtime Controller records private platform evidence, resolves it through the
generation claim, and publishes one of three disjoint fact shapes. Service
facts (`observation_gap`, `reconciled`) carry no Runtime identity. Environment
facts (`initialized`, `updated`, `disabled`, `enabled`, `deleted`, and storage
drift) carry Agent ID plus revision but no generation identity. Runtime
generation facts (`healthy`, `unhealthy`, `restarted`, `exited`,
`runtime_deleted`, `runtime_missing`, and `status_unverified`) are validated
against a private generation claim before their logical projection is
published. Transient platform inspection failure fails reconciliation instead
of fabricating a fact. Agent Controller decides whether a fact creates an
Agent event.

## Runtime Status Verification

Runtime `/status` target response:

```json
{
  "agent_id": "agent-123",
  "generation": 8,
  "execution_id": "01J...",
  "status": "ready"
}
```

The Controller does not poll every Runtime forever. Docker/Kubernetes owns
liveness and restart policy. Runtime Controller verifies status:

1. after a resource first becomes Healthy;
2. after a platform event indicates a restart or new healthy process;
3. during every explicit Inspect or List read of a platform-Healthy, ready
   Environment.

A status mismatch is a failed inspection and an observation. It is never
silently corrected by mutating labels or Runtime identity.

## Persistence Ownership

The private store contains only facts this service must recover:

1. one Runtime Environment lifecycle head per Agent, including opaque revision,
   stable or transitional state, and private current/target deployment identity;
2. idempotent lifecycle operations and payload digests;
3. immutable private Runtime generation claims mapped to opaque revisions;
4. ordered, bounded Runtime observations and consumer recovery sequence.

It also provides coordination primitives, not business data: Agent-scoped
mutation advisory locks, one observation-monitor leadership lock, a separate
Watch-readiness lease, and transactional `LISTEN/NOTIFY` wakeups for journal
consumers.

It does not store AgentSpec, desired/candidate configuration, operation
admission, Run, Tool, Provider, Egress policy, Channel, or identity records.
The Environment head is execution ownership and command fencing, not a replica
of Agent Controller desired state. Update and Enable always receive complete
configuration from the caller.

No other service reads these tables. Agent Controller consumes RPCs.

## Module Map

| Module | Responsibility | Must not absorb |
| --- | --- | --- |
| `deployment` | Private generation, physical deployment, inspection, observation, and operation outcomes | HTTP DTOs, SQL records, Docker types |
| `control` | Initialize, Update, Disable, Enable, Delete, Inspect, List, and observation use cases over narrow ports | Agent admission and Tool dispatch |
| `observation` | In-process Watch wake-up hub and repository notification decorator | Durable history or platform semantics |
| `platform` | Platform-neutral adapter ports and normalized event model | Docker/Kubernetes branching outside adapters |
| `platform/docker` | Docker resource mapping, health, List/Watch, and deterministic labels | Agent or Egress logic |
| `platform/monitor` | Initial List reconciliation, Watch reconnect, gap records, and healthy-status verification | Agent event interpretation |
| `runtimeclient` | Bounded `/status` verification | MCP Tool execution |
| `repository` | Platform-neutral Store, Agent lock, observation leadership, and notification ports | SQL records and queries |
| `repository/postgres` | Private Environment heads, operations, generation claims, and bounded observation journal | Cross-service tables |
| `rpc` | Internal request/response DTO mapping and Watch transport | Public OpenAPI and domain branching |
| `telemetry` | Structured logs, traces, metrics | Control flow |
| `cmd/runtime-controller` | Composition and process lifecycle | Domain decisions |

## Failure Semantics

1. A read failure is retryable within the caller's deadline.
2. A mutation that definitely did not start may return `not_started`.
3. A completed platform mutation returns `completed` plus inspection.
4. A lost response after a possible platform mutation returns `unknown`.
5. A readiness deadline after successful platform creation remains `unknown`;
   retrying the same request ID reconciles readiness under the Agent lock.
6. Unknown mutations are inspected; they are never blindly replayed under a
   new operation ID.
7. Operation terminal state and its operation-caused observation commit in one
   private-database transaction. The in-process Watch hub is notified only
   after commit.
8. Observation persistence failure does not rewrite platform reality, but it
   makes Runtime Controller unready until the journal can recover.
9. Runtime status failure is local readiness failure for that Environment, not
   process-wide Controller unhealthiness.
10. Losing the Agent lock session cancels the mutation. The caller retries only
    the same request ID; another request remains blocked by the durable
    non-terminal operation slot.

## Observability

Control RPCs and platform operations create spans. Cross-service logs carry
trace ID, operation ID, Agent ID, opaque Runtime revision, execution ID when
known, and result class. Private adapter logs may additionally carry generation
and platform resource ID. High-cardinality IDs are not metric labels.
Reconciliation is a root operation span. Each platform event creates a
consumer span whose children include current-state inspection, Runtime status
verification, and journal persistence. After normalization, that consumer span
records the spec digest, platform resource ID, and execution ID when known.
Internal logs and spans retain the
actual platform/database error while public RPC errors remain sanitized.
Long-lived platform Watch, PostgreSQL LISTEN, and observation SSE sessions emit
lifecycle logs and metrics but never create unbounded spans. Finite repository
reads and delivery work retain ordinary tracing.

Each lifecycle mutation has one finite `runtime.lifecycle.*` span plus an
operation count and duration metric labeled only by operation kind, result,
and stable error class. Observation Watch publishes connection, active-session,
and termination metrics; Agent IDs, revisions, operation IDs, and execution IDs
remain trace/log attributes rather than metric labels.

Recommended metrics use low-cardinality labels only:

- platform operation latency by operation/platform/result;
- Runtime observations by kind/platform;
- status verification by result;
- Watch reconnects and reconciliation gaps;
- journal append and delivery failures;
- deletion convergence duration.

Runtime status bodies contain no secrets. RuntimeSpec logging must redact any
future secret-bearing extension by default.

## Invariants

1. Runtime Controller alone allocates physical generation; callers never see or
   choose it.
2. Runtime Controller owns Runtime Environment lifecycle execution but never
   decides when Agent Controller should issue a lifecycle command.
3. Runtime Controller never dispatches MCP Tool calls.
4. Runtime Controller never calls Runtime Egress.
5. One private Runtime key plus one digest is immutable and idempotent; one
   logical Environment mutation produces a new opaque revision.
6. One Agent has at most one distinct non-terminal mutation across Controller
   replicas. If an exact retry overlaps after lock-session failure, a private
   attempt CAS rejects stale terminal writes and deterministic platform
   resources are re-inspected before convergence.
7. Platform labels are sufficient to reconstruct resource association.
   Runtime Controller adopts or deletes only resources carrying its expected
   ownership labels.
8. Runtime Ready requires platform Healthy plus matching Runtime status.
9. A new Runtime PID 1 execution is observable even when Runtime revision and
   endpoint remain unchanged.
10. List/Inspect plus a service-wide gap restores correctness after Watch loss,
    including the empty-inventory case.
11. No adapter type leaks into the domain or RPC contract.
12. No service reads Runtime Controller's private tables.
13. One Controller replica consumes platform events; every replica can serve
    control RPC and journal Watch clients.
14. A Runtime-scoped observation is accepted only when its observed digest
    matches the immutable generation claim.

## Extension Rules

- Add a deployment platform by implementing the platform port; do not add a new
  service hop.
- Add an observation kind only when its platform evidence and recovery behavior
  are defined.
- Add no Run, Agent configuration, or retention policy here. Agent Controller
  owns lifecycle intent; Runtime Controller owns lifecycle execution.
- Add no Tool method here. Agent ACP Service calls Antnest Runtime MCP directly
  with the endpoint and expected execution identity frozen by Run admission.
- Change Runtime status or execution fencing only through a lockstep update to
  contracts, Runtime, Controller, tests, and Stage 1 documentation.
