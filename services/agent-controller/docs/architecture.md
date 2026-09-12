# Agent Controller Architecture

## Mission And Boundary

Agent Controller is the sole writer of Agent business state. It validates one
complete intended configuration, coordinates idempotent child operations, and
publishes a new executable revision only after Runtime and network readiness
are proven.

It depends on language-neutral HTTP contracts. It does not import another
service implementation or inspect another service database.

The document describes the completed target boundary. Implementation proceeds
as vertical business slices. At present ModelProfile/Template Catalog, current
Agent projection queries, Run admission, and the Agent create, explicit rebuild,
disable, enable, and delete Sagas are runnable. Lifecycle Runtime barriers
atomically release unresolved Run occupancy and append the corresponding Agent
event. HTTP commands return after a Temporal admission Activity commits durable
intent. Temporal is the sole executor, retry scheduler and recovery engine.
Business phases and CAS remain in PostgreSQL; worker leases do not. Authoritative
event replay and best-effort SSE watch are runnable.

[Workspace state](workspace-state.md) is a separate current-state observation
of lifecycle and Run admission, scoped by organization and principal. It reuses
the existing query Port and notification connection. Normal Run transitions do
not enter the audit journal; a committed admission change wakes snapshot readers
without carrying Session IDs or credentials in the notification. Waiting clients
hold no business-pool connection. Consumers must treat transport failure as
uncertain state and re-establish a scoped snapshot before enabling actions.

A small Runtime-observation consumer is intentionally not a general event bus.
It polls Runtime Controller's authoritative ordered journal with a persisted
cursor. Initial startup and expired-cursor recovery reconcile current Runtime
execution identities and confirmed missing compute first. A `restarted`,
`runtime_missing`, or `runtime_deleted` observation for the Agent's current
opaque Runtime revision atomically clears the executable binding and transitions
an available Agent without an active lifecycle operation to `unavailable`.
Restart emits `agent_runtime_restarted`; missing/deleted compute emits
`agent_runtime_missing`, preserving the precise observation kind in `reason`.
The same transaction commits the event and consumer cursor. Run admission uses
the existing Agent row lock, so new Runs after that commit cannot use the stale
binding. Previously admitted Runs retain their execution snapshots and terminal
report obligations; observation does not manufacture a result or release a fence.

Initial/expired-cursor reconciliation treats a `ready` Runtime with `absent`
health as missing. Unknown/unhealthy status or a failed RPC is not proof of
container deletion. Old Runtime revisions, disabled Agents and active lifecycle
operations are not overwritten. No observation automatically rebuilds compute or
restores availability; recovery remains an explicit lifecycle operation.

Runtime-loss recovery reuses **Rebuild**, not a separate repair executor. An
enabled but unavailable Agent with a retained Runtime revision/spec pointer and
last-successful execution may supply an immutable `RecoverySource`. This source
is distinct from `ExecutableSpec`/`ExecutableExecution` and never becomes a Run
binding. Its Agent, spec and Runtime identities must agree. Initial creation
failures without a published execution, disabled/deleted Agents, and incomplete
lineage are not recoverable through this path.

Rebuild admission compares the current aggregate and source identity under the
Agent row lock, then attaches the normal drain/fence/update/open/publish operation.
The Agent remains unavailable with an empty executable binding until publication.
An early failure retains the historical source for another explicit request but
does not reopen its network attachment. Existing Run drain and unknown-effect
release barriers remain authoritative; a missing observation is not such a
barrier. No schema or new public mutation method is required for recovery.
Quarantined lifecycle invariants are excluded from fresh recovery admission.
A definitive `not_started` update, or a permanent rejection followed by the
unchanged ready logical Runtime head, may terminate the recovery attempt while
retaining unavailable history. This does not prove a Tool effect settled and
never releases its fence. Unknown update effects stay on the original operation.

The separate [Identity offboarding consumer](identity-offboarding.md) receives
commit-ordered revocations through Identity RPC. It stores receipt progress and
per-owner scope watermarks, fences fresh Run admission, and schedules the same
Disable saga used by manual requests. It does not introduce another lifecycle
executor. Identity restoration never automatically enables Agents.

The separate [network policy application service](network-policy.md) scopes
management requests through a read-only Agent lookup, then uses Runtime Egress
RPC to read an exact policy revision or submit one assignment CAS. Egress remains
the sole policy authority. This path adds no Controller policy table, AgentSpec
field, generation, lifecycle operation, or second event journal. Desired policy
and lifecycle attachment are independent observations, not a packet-health probe.

## Aggregate Model

### Provider Connection And ModelProfile

A Provider connection belongs to one organization and owns its endpoint and
independently versioned encrypted credential. It can contain multiple ModelProfiles.
A model revision stores model name, context/output limits, multimodal capabilities,
optional temperature/pricing and display name; it does not store credential versions
or copy the endpoint. See [Provider management](provider-management.md).

Run admission combines the current model revision with its authorized Provider
connection. Templates retain stable model identity; credentials are resolved
independently against the current connection version, never from a build snapshot. Credential plaintext is absent from
management responses, specs and events. Development RPC content capture can include
submitted secrets in Jaeger; see [observability](observability.md).

### AgentTemplate

A Template head belongs to one organization and points to one immutable
TemplateRevision. A revision contains:

- one stable ModelProfile identity;
- system prompt and maximum model requests;
- caller-selected Runtime image reference, resource limits, and optional managed stdio
  MCP startup configuration. See [Managed MCP](managed-mcp.md) for bounds and
  configuration privacy.

Catalog preserves the submitted `runtime.image_ref`, including mutable tags such
as `latest`, explicit versions, and immutable image IDs/digests. It validates
reference syntax but does not resolve tags, query Docker, or depend on Runtime
Controller availability. Missing images do not prevent saving a Template.
There is no separately derived image source. Revision immutability preserves
the submitted configuration, not the bytes later addressed by a mutable tag.

Create, revise, read, and replay return the same submitted reference. Agent
create/rebuild passes that reference to Runtime Controller; image availability
and container creation are build-time concerns. A new build can use a newer
image behind the same tag without publishing another Template revision. This
does not update a running container or guarantee identical image bytes across
builds. Use an explicit digest when that is required. The current Docker
deployment uses locally installed images; registry pull policy is not added by
this change. No image database or cross-service persistence is introduced.

Templates do not contain users, active Runtime endpoints, Egress policy, or
Skill package bytes. Stage 2 has no Skill Registry dependency, so every derived
Agent configuration has an empty Skill set.

Updating a Template creates a revision. It does not silently mutate existing
Agents. Applying that revision to an Agent is an explicit rebuild operation.
ModelProfile and Template heads use optimistic revision comparison inside the
repository transaction. The application never asks PostgreSQL to infer or
reshape business intent; it submits one complete immutable next revision and
the expected current revision.

### Agent

`agent_id` is stable and never reused. The aggregate stores opaque
`organization_id` and `owner_user_id` values from Identity Service without a
cross-service foreign key.

The current projection contains:

```text
Agent
  agent_id
  organization_id
  owner_user_id
  name
  desired_state     enabled | disabled | deleted
  lifecycle_state   provisioning | available | unavailable |
                    disabled | deleting | deleted
  access_revision
  agent_spec_revision?
  executable_execution_revision?
  last_successful_execution_revision?
  active_operation_request_id?
  failure?
  aggregate_sequence
  owner_authorization_sequence
  identity_revocation_sequence
```

The desired state is business intent. The lifecycle state contains only stable
availability facts. Drain, rebuild, disable, and enable progress exists only in
the active LifecycleOperation, so there is one source of truth for process
state. A failed replacement clears `executable_execution_revision` once the old
Runtime is absent while retaining `last_successful_execution_revision` for
audit.

`owner_user_id` is immutable ownership, not a copied user profile. Before first
creation, Agent Controller resolves the opaque `(organization_id,
owner_user_id)` pair through Identity Service and requires an active
organization membership. The atomic owner-authorization RPC includes the latest
applicable revocation sequence. Create and explicit Enable freeze it under the
local receipt/admission boundary; a newer consumed revocation rejects a stale
decision with a conflict. Persisting the create intent freezes that decision;
exact replay of a running, failed, or completed operation does not revalidate
and change its historical meaning. Agent access resolution repeats the same
non-secret check, so a disabled user or membership is rejected on the next ACP
business request. New Run admission performs the authoritative check again
before the local admission transaction. A request already admitted before a
concurrent Identity change keeps its immutable authorization snapshot. Agent
Controller never joins or writes Identity Service storage.
Owner-filtered reads are served from the local Agent projection.

Controller migration 4 adds two private tables: `identity_revocation_cursor`
(single receipt checkpoint) and `owner_revocations` (latest global or scoped
revocation). Agent watermarks and the Disable operation's revocation cause stay
on their owning records. Only idle Agents immediately change desired state on
receipt; an already-active lifecycle keeps its original transition contract,
while the independent owner fence prevents new admission. Receipt is audited as
`agent_owner_revoked`, not as proof that Runtime has stopped.

Current-state queries order by immutable `(created_at, agent_id)` and use an
opaque keyset cursor. They do not hold database snapshots across HTTP requests.
`aggregate_sequence` identifies the last domain event reflected in each row;
ordered change consumption belongs to the event journal rather than list
pagination.

The persistence projection may retain a Runtime revision while an Agent is
disabled so a later Enable can describe its source state. The control API's
`runtime` object has narrower semantics: it is emitted only when revision,
execution identity, and MCP endpoint form one complete currently executable
binding. A retained revision alone is lifecycle evidence, not a partial wire
binding.

### AgentSpecRevision

An AgentSpecRevision is a complete immutable non-secret snapshot derived
from a specific Template revision and ModelProfile revision. It freezes the
system prompt, model request policy, context-policy version, model metadata,
Runtime image/resources/managed MCP configuration and canonical digest. Model
metadata here records build lineage only; new Run admission resolves the current
revision of the retained stable model identity. Credentials are not build inputs. Managed MCP arguments and environment are not copied into
Run admission or operational events.
`skill_instructions` is always empty in Stage 2.

### ExecutionRevision

An ExecutionRevision is published only after Runtime Controller reports a
healthy Runtime. It binds one AgentSpecRevision to an opaque Runtime revision,
MCP endpoint, and Runtime execution identity. Agent Controller never stores
physical generation, container, Pod, volume, or workspace identifiers.

### LifecycleOperation

A lifecycle command checks organization ownership before source-state or busy
validation. A foreign Agent returns `agent_not_found` regardless of its state;
rejection creates no operation/event and invokes no deployment dependency.
Authorized commands then persist one idempotent operation. A request ID
may be retried only with the same canonical fingerprint. The operation stores
its source preconditions, target revision, child request IDs, phase, result,
and failure class before or after each external effect as applicable.

All five kinds use [Temporal workflows](lifecycle-workflows.md). The SDK records
intent before the admission transaction and returns the admission result through
a Workflow Update. Activities reload frozen business snapshots and execute one
phase each. PostgreSQL retains the business projection, not a work queue.

Activity retries reuse stable child request IDs. Operation phase CAS, Agent
aggregate/source guards and downstream idempotency remain authoritative under
at-least-once execution. Definitive invariant failure is atomically quarantined,
releasing lifecycle occupancy while retaining diagnostics and audit events.
Unknown external effects remain retryable; quarantine is not compensation.

The official SDK interceptor carries the initiating request context. Workflow
and Activity spans include RPC/transaction/SQL descendants without a business
traceparent column or manually instrumented phase handler.

Operation kinds and successful paths are:

```text
create  validate -> network_ensured_closed -> runtime_initialized
        -> network_opened -> published
rebuild drain -> network_closed -> runtime_updated
        -> network_opened -> published
disable drain -> network_closed -> runtime_disabled -> published
enable  network_ensured_closed -> runtime_enabled -> network_opened -> published
delete  drain -> network_closed -> runtime_deleted
        -> network_released -> published
```

Only one non-terminal lifecycle operation and one Run admission that still
occupies the Agent may exist per Agent. The same Agent row lock serializes Run
admission and lifecycle-operation creation.

### RunAdmission

Run admission is Agent-wide, not Session-wide. An accepted admission freezes
one complete execution snapshot and a deadline. Provider secret resolution is
allowed only for the Provider connection captured by that active, unexpired
admission and its current access binding. The resolver returns the current
credential version without modifying the execution snapshot. A terminal report is immutable and idempotent.

The first admission response uses the database-materialized timestamps, just
like a request replay. In-memory nanosecond timestamps must not produce a
different response from PostgreSQL's microsecond representation. The adapter
reads the stored values with `INSERT ... RETURNING` inside the transaction.

An unresolved Tool effect records `runtime_mcp`, `client_mcp`, or
`unclassified` provenance and leaves the Agent fail-closed. Timeouts are never
treated as proof that a side effect did or did not happen. When rebuild,
disable, or delete proves the Runtime absent, one transaction may release only
a `runtime_mcp` admission, advance the lifecycle phase and Agent aggregate
sequence, and append `run_admission_released` correlated to both operation and
admission. Runtime absence cannot settle a client or unclassified effect; those
admissions remain blocked. The immutable terminal report is not rewritten. If
no releasable admission exists, the barrier appends no synthetic release event.

### AgentEvent

Events are immutable, monotonically ordered Agent-domain facts appended in the
same local transaction as the aggregate change. Every envelope contains an
event ID, global sequence, per-Agent aggregate sequence, schema version, Agent
ID, event type, optional operation/admission correlation, timestamp, trace ID,
and non-secret data. Global and per-Agent List are authoritative; Watch is a
best-effort wake-up channel resumed by global sequence. Agent Controller is not
a generic event broker.

Global sequence is an exclusive, consumer-owned replay cursor. Consumers store
their last fully applied sequence in their own database, replay with at-least-once
semantics, and deduplicate by event ID. Agent Controller never writes another
service's acknowledgement or offset. PostgreSQL commit notification wakes SSE
watchers, while a post-subscription journal check closes the List/LISTEN race;
the journal remains authoritative if a notification or connection is lost.

## State Transitions

```text
provisioning -> available | unavailable | deleting
available    -> disabled | unavailable | deleting
disabled     -> available | unavailable | deleting
unavailable  -> available | deleting
deleting     -> deleted
```

Only `available` with no active lifecycle operation admits Runs. Rebuild and
delete wait for a settled active Run. Stage 2 has no force mutation and no
candidate Runtime.

## Business Scenarios

### Define Model And Template

1. Persist a Provider connection, one encrypted credential and initial model revisions atomically.
2. Validate a Template against an enabled model identity and its enabled Provider connection.
3. Persist the Template head and immutable revision atomically.
4. The immutable revisions and idempotency ledger provide the current Catalog
   history. A queryable management-audit stream is added with the event slice;
   no secret may enter it.

### Create Agent

1. Resolve and require one active Identity Service organization/user binding.
2. Resolve and freeze the requested Template revision.
3. Persist Agent, AgentSpecRevision, owner access binding, create operation,
   projection state `provisioning`, and `agent_create_requested` atomically.
4. Ensure the Egress network allocation and require its attachment to be closed.
5. Construct Runtime Controller configuration from the frozen Runtime inputs
   plus returned network attachment.
6. Initialize Runtime with the durable child request ID and wait for a completed,
   healthy result whose effect is confirmed complete.
7. Open the attachment with resource-version CAS and require the same active
   tunnel, resolver, packet contract, and endpoint used to initialize Runtime.
   This closes the readiness race without publishing a Runtime configured for
   stale network facts.
8. Atomically publish ExecutionRevision, set `available`, and append `agent_ready`.
9. Any terminal failure sets `unavailable`, records exact phase/class, and
   appends `agent_build_failed`.

The request thread commits intent and returns `202 Accepted`; it does not
execute lifecycle effects. Temporal dispatches Activities and retains child
request identities across retries/restart. HTTP request
replay returns the existing operation; only workflow Activities advance effects.

### Explicit Rebuild

A rebuild freezes a target Template revision before closing admission. The
internal command is `POST /internal/agents/{agent_id}/rebuild` with one durable
`request_id`, `template_id`, and `template_revision`.

The request transaction locks the Agent, verifies its current executable Spec
and Runtime revisions, appends `agent_rebuild_requested`, and attaches the
operation without changing the stable `available` projection. New Run
admissions are rejected from that point. The drain phase remains pending while
an active admission exists; an admission whose executor is terminal but whose
`runtime_mcp` Tool effect is unknown may cross the Runtime-replacement barrier
and is released only after Runtime replacement proves the old compute absent.
Client MCP and unclassified effects remain blocked. The Runtime-update
barrier and the resulting `run_admission_released` event commit atomically.

Once drained, the Saga reads the current Egress allocation and closes its
Runtime attachment with attachment resource-version CAS. Closing is one
Egress-owned barrier: it blocks packets, drains packet writers, and clears
userspace and conntrack flow state without changing desired policy. Agent
Controller persists the returned closed attachment and calls Runtime Controller
`UpdateRuntime` with the source opaque Runtime revision and complete target
Runtime configuration. Agent Controller never copies Tunnel allocation
ownership into its Agent projection. After Runtime readiness it opens that same
attachment with CAS and requires unchanged Tunnel, resolver, packet contract,
and Egress endpoint before publication.

Desired Egress policy and lifecycle attachment state are independent. Policy
updates made while an attachment is closed remain durable and are applied by
Egress when the attachment opens. Lifecycle operations neither read nor rewrite
policy assignments.

Publication atomically installs the target AgentSpecRevision, one new
ExecutionRevision, the ready Runtime binding, `available`, and
`agent_rebuilt`. No partially published endpoint is usable. A transport or
ambiguous dependency result leaves the durable operation at its current phase
for exact-request replay. A conclusive pre-replacement failure reopens the
attachment and preserves the executable source. After Runtime replacement is confirmed, failure
remains non-terminal and fail-closed until exact replay can publish the observed
Runtime; there is no implicit rollback.
If Runtime Controller returns a stable deleted inspection for the exact source
Runtime revision, the source executable cannot be preserved. The same failure
transaction releases any `runtime_mcp` unresolved admission, records the absence proof,
clears the unusable executable projection, and appends release and
build-failure facts in aggregate order. A plain `runtime_not_found` response
does not prove physical Runtime absence and therefore leaves the operation
running and fail-closed for inspection or replay.

### Disable, Enable, Delete

Disable is a restartable Saga, not a projection-only flag:

1. atomically set desired state `disabled`, attach the operation, append
   `agent_disable_requested`, and reject new Run admission;
2. wait for an active Run to settle; a `blocked_unknown_effect` admission may
   cross the Runtime-disable/absence barrier only when Runtime Controller later proves the
   source Runtime compute absent;
3. close the Runtime attachment with Egress CAS; Egress owns packet gating and
   flow cleanup while preserving the desired policy;
4. call Runtime Controller `DisableRuntime` with the frozen source Runtime
   revision; completed success must prove lifecycle `disabled` and health
   `absent`, returns the retained-workspace Runtime revision, and atomically
   releases any `runtime_mcp` unresolved admission bound to the removed source Runtime;
5. atomically publish desired/lifecycle state `disabled`, retain the current
   AgentSpec and last successful ExecutionRevision, clear the executable
   execution/MCP binding, store the disabled Runtime revision, and append
   `agent_disabled`.

A conclusive failure before Runtime disable reopens the attachment, restores
desired state `enabled`, and preserves the old executable binding. Once Runtime
Controller has received a disable request, restoration additionally requires
an authoritative inspection proving the exact frozen Runtime revision,
execution identity, MCP endpoint, lifecycle `ready`, and health `healthy`.
Mismatch projects the Agent as unavailable and leaves its attachment closed; ambiguous
effect or inspection remains running and fail-closed for exact-request replay.
A stable deleted inspection for the exact source Runtime revision is not
ambiguous: the failure, absence proof, unresolved-admission release, Agent
projection, and ordered audit facts commit atomically. With no blocked
admission, no synthetic release event or sequence increment is produced. A
plain missing-record response remains ambiguous and cannot cross this barrier.

Enable reuses the disabled Agent's last valid AgentSpec; configuration changes
always use explicit rebuild. It freezes the disabled Runtime revision and last
successful ExecutionRevision, ensures the retained network allocation remains
active with a closed attachment, and calls Runtime Controller with that closed
attachment. After persisting a proven ready Runtime result it enters the durable
`network_restore` phase, opens the same attachment with CAS, verifies unchanged
network coordinates, and publishes a new ExecutionRevision. Desired policy is
not part of the lifecycle operation: any policy revision assigned while the
Agent was disabled is applied by Egress during open.

A conclusive Runtime `not_started` result is terminal only when authoritative
inspection still proves the exact disabled Runtime. Otherwise the projection
is not changed and the operation remains running with a closed attachment. Once
a ready Runtime result exists, dependency ambiguity likewise leaves the
operation running with a closed attachment for exact replay.

Delete admission remains local and asynchronous. An empty published Runtime
revision means the cleanup target is unresolved, not that deployment resources
are absent. After draining and closing the network attachment, the worker asks
Runtime Controller for its authoritative Environment. A stable ready, disabled,
or failed Environment supplies the exact cleanup revision; only authoritative
not-found or deleted results supply an absence proof. Transitional or unknown
state cannot advance deletion. The source inspection/proof is frozen in the
same transaction as leaving `network_fence`, using existing operation columns.
Subsequent retries use that revision and the original child request ID; they
never rebase deletion onto a newly observed revision. Admission performs no
remote inspection, and no new lifecycle phase or table is introduced.
Ownership inspection is not executable readiness: stable ready/disabled heads
may report degraded live health and still supply a cleanup revision. Publishing
an executable Runtime continues to require a completed, healthy ready result.

Runtime Controller contract revision 7 distinguishes failed Initialize ownership
from absence. Its failed operation may have `effect=completed` after readiness
expires. The HTTP client reconciles operation-bearing startup errors against
the exact request journal so a terminal platform rejection is not retried
forever merely because its HTTP status is 503. An authoritative missing journal
retains the original error; unavailable or invalid journal evidence remains
retryable rather than manufacturing a terminal result. Conflicting request IDs are
never resolved by adopting another operation. Unknown readiness with completed
creation remains nonterminal. Only completed/ready publishes an executable Agent.

Delete removes compute and workspace, releases the Egress attachment into
quarantine, keeps immutable events/revisions for retention, deactivates the
owner binding, and hides the Agent from default active queries. Once deletion
intent is persisted it is not rolled back to an executable Agent; ambiguous
external effects remain on the same operation until reconciled.
The proven Runtime-deletion barrier, or an authoritative pre-existing absence
proof, atomically releases unresolved occupancy and records
`run_admission_released` before network allocation release continues.
The deletion fence contains only the frozen Runtime revision, or an
authoritative proof that no Runtime exists. AgentSpec and Execution revision
identities are deliberately excluded because they cannot strengthen Runtime
deletion and would make failed initial provisioning impossible to clean up.

### Run Admission

Resolve access maps one trusted subject to one owner principal and Agent.
It then revalidates that principal's active organization membership through
Identity Service before returning the binding.
Acquire first returns an exact durable replay when one exists. For a new
admission, it revalidates the same active Identity binding, checks the local
mapping revision, locks the Agent, requires `available`, rejects an existing
admission, and returns the complete immutable snapshot. The snapshot contains
an empty Skill instruction list until Skill Registry is runnable. Finish seals
the terminal report. The ACP service owns all messages and detailed Tool facts.

## Persistence Ownership

The initial schema owns:

- `provider_connections` (connection metadata and current encrypted credential);
- `model_profiles` (current model parameters, version and configuration stamp);
- `agent_templates`, `agent_template_revisions`;
- `agents`, `agent_spec_revisions`, `execution_revisions`;
- `agent_access_bindings`;
- `agent_lifecycle_operations`;
- `run_admissions`;
- `runtime_observation_cursor`;
- `agent_events`.

`agents` is the global current-state projection; it is not an event-sourced
reconstruction requirement. Events and immutable revisions provide audit and
recovery evidence without forcing every query to replay history.

Agent default authorization lives in `agents.default_authorization` with its
own CAS revision. It is separate from the Runtime/build specification. New Run
admissions freeze organization model selection and effective authorization in
their snapshot. `agent_authorization_updated` records a revision change, not a
rule-body patch. See [Session configuration](session-configuration.md) for the
F05 producer contract and the completed ACP consumer/integration references.

`event_journal_cursor` is a singleton ordering primitive, not a consumer
offset. Every event transaction advances it while holding its row lock and
keeps that lock until commit. This deliberately serializes journal append so a
higher global sequence can never become visible before a lower one. Each
service instance maintains one dedicated PostgreSQL `LISTEN` connection and
fans wake-up hints out in process; SSE clients never reserve business-pool
connections. The journal remains authoritative if notifications are delayed,
duplicated, or missed during listener reconnection.

Event payload `data` is retained audit detail rather than a cross-service patch
format. The stable event contract is its envelope and enumerated type. Consumers
react idempotently by `event_id` and reload the authoritative Agent projection
when they require current state. This keeps producer-internal Saga details from
becoming an accidental distributed data model.

`runtime_observation_cursor` is Agent Controller's own consumer offset. It is
not shared with Runtime Controller and does not grant authority over Runtime
state. Multiple Agent Controller replicas may poll concurrently: cursor row
locking makes observation application idempotent. Runtime list reconciliation
repairs execution-identity drift when the upstream bounded journal no longer
contains the original restart event.

## Module Direction

```text
cmd -> config/composition -> rpc
rpc -> application -> domain + ports
postgres/runtimeclient/egressclient -> ports
telemetry wraps inbound/outbound boundaries
```

Domain and application packages contain no PostgreSQL, HTTP, Docker,
Kubernetes, ACP, or PocketBase types.

## Observability

Every inbound business RPC creates or continues a W3C trace. Successful
readiness probes are deliberately excluded; failed probes remain observable.
Each lifecycle worker attempt restores the durable causal parent within the
originating request's trace, carrying the durable request ID as the sole
operation identity. The first attempt is a child of admission; subsequent
attempts are children of their predecessors, including across scheduling or
process restarts. HTTP spans end normally at admission; worker spans contain
the actual Egress, Runtime Controller and database calls. See the
[asynchronous tracing contract](observability.md#asynchronous-lifecycle-causality).
Outbound clients
propagate `traceparent` and `tracestate`.
Runtime observation synchronization creates consumer spans; packet forwarding
remains outside this tracing model.

Allowed span attributes include Agent ID, organization ID, operation kind,
phase, lifecycle state, configuration/execution/runtime revision, admission
result, and stable error class. Prompts, Provider secrets, request bodies,
Tool payloads, and full filesystem paths are forbidden.

Required metrics are low-cardinality:

- Agent projection count by lifecycle state;
- lifecycle operation duration/result by kind and phase;
- Run admission result and active/unresolved gauges;
- dependency RPC duration/result by service and operation;
- event-journal append/watch disconnect counts.

## Extension Rules

- Skill Registry integration adds immutable Skill references to Template and
  AgentSpec revisions; it never lets Agent Controller read Skill storage.
- A Kubernetes adapter changes Runtime Controller only.
- A KMS adapter replaces local encrypted credential storage behind the
  credential port without changing Run contracts.
- Public management APIs belong behind Edge Gateway and must not make this
  internal RPC surface public by accident.
