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
event. A background recovery worker claims stale running operations through
PostgreSQL leases and resumes the same persisted state machines. Authoritative
event replay and best-effort SSE watch are runnable.

## Aggregate Model

### ModelProfile

A ModelProfile head belongs to one organization and points to one immutable
revision. A revision freezes the OpenAI-compatible endpoint, model name,
context/output limits, image support, optional temperature, and one opaque
credential reference. Credential values are encrypted at rest and never enter
Agent specs, events, logs, traces, or Run snapshots.

### AgentTemplate

A Template head belongs to one organization and points to one immutable
TemplateRevision. A revision contains:

- one ModelProfile revision;
- system prompt and maximum model requests;
- immutable Runtime image reference and resource limits.

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
organization membership. Persisting the create intent freezes that decision;
exact replay of a running, failed, or completed operation does not revalidate
and change its historical meaning. Agent access resolution repeats the same
non-secret check, so a disabled user or membership is rejected on the next ACP
business request. New Run admission performs the authoritative check again
before the local admission transaction. A request already admitted before a
concurrent Identity change keeps its immutable authorization snapshot. Agent
Controller never joins or writes Identity Service storage.
Owner-filtered reads are served from the local Agent projection.

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
Runtime image/resources, credential reference/version, and canonical digest.
`skill_instructions` is always empty in Stage 2.

### ExecutionRevision

An ExecutionRevision is published only after Runtime Controller reports a
healthy Runtime. It binds one AgentSpecRevision to an opaque Runtime revision,
MCP endpoint, and Runtime execution identity. Agent Controller never stores
physical generation, container, Pod, volume, or workspace identifiers.

### LifecycleOperation

Every lifecycle command first persists one idempotent operation. A request ID
may be retried only with the same canonical fingerprint. The operation stores
its source preconditions, target revision, child request IDs, phase, result,
and failure class before or after each external effect as applicable.

Recovery ownership is execution metadata, not Agent state. A worker claims one
stale running operation with `FOR UPDATE SKIP LOCKED`, a bounded lease, and a
monotonic attempt fencing token. It reloads the operation by its stored request
fingerprint and resumes the existing phase machine. It never reconstructs the
original command body and never allocates a replacement child request ID.
Operation phase CAS, Agent aggregate CAS, and downstream child-request
idempotency remain authoritative if an expired worker overlaps a newer worker
or an explicit client replay.

Initial request and recovery attempts are separate traces. Each recovery
attempt stores its own W3C trace parent before making an external call and
starts a new root span linked to the initial request and previous recovery
attempt. Recovery ownership, lease expiry, and retry scheduling are not emitted
as domain events or copied into the Agent projection.

Operation kinds and successful paths are:

```text
create  validate -> network_ensured -> runtime_initialized -> published
rebuild drain -> network_fenced -> flows_reset -> runtime_updated
        -> network_reopened -> published
disable drain -> network_fenced -> runtime_disabled -> published
enable  network_verified -> runtime_enabled -> network_restored -> published
delete  drain -> network_fenced -> flows_reset -> runtime_deleted
        -> network_released -> published
```

Only one non-terminal lifecycle operation and one Run admission that still
occupies the Agent may exist per Agent. The same Agent row lock serializes Run
admission and lifecycle-operation creation.

### RunAdmission

Run admission is Agent-wide, not Session-wide. An accepted admission freezes
one complete execution snapshot and a deadline. Provider secret resolution is
allowed only for the credential reference and version captured by that active
admission. A terminal report is immutable and idempotent.

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

1. Persist an encrypted Provider credential and immutable ModelProfile revision.
2. Validate a Template against an enabled ModelProfile revision.
3. Persist the Template head and immutable revision atomically.
4. The immutable revisions and idempotency ledger provide the current Catalog
   history. A queryable management-audit stream is added with the event slice;
   no secret may enter it.

### Create Agent

1. Resolve and require one active Identity Service organization/user binding.
2. Resolve and freeze the requested Template revision.
3. Persist Agent, AgentSpecRevision, owner access binding, create operation,
   projection state `provisioning`, and `agent_create_requested` atomically.
4. Ensure the Egress network attachment.
5. Construct Runtime Controller configuration from the frozen Runtime inputs
   plus returned network attachment.
6. Initialize Runtime with the durable child request ID and wait for a completed,
   healthy result whose effect is confirmed complete.
7. Re-read the Egress attachment and require the same active tunnel, resolver,
   packet contract, and endpoint used to initialize Runtime. This closes the
   readiness race without publishing a Runtime configured for stale network
   facts.
8. Atomically publish ExecutionRevision, set `available`, and append `agent_ready`.
9. Any terminal failure sets `unavailable`, records exact phase/class, and
   appends `agent_build_failed`.

The request thread normally drives these three durable create phases. A
transport timeout leaves the durable operation at its last committed phase;
replaying the same request or background recovery continues with the same child
request identity.

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

Once drained, the Saga first persists the authoritative Egress policy assignment,
then fences Egress to durable deny-all, reads and persists the authoritative
active network attachment, resets userspace/kernel flows, and calls Runtime
Controller `UpdateRuntime` with the source opaque Runtime revision and the
complete target Runtime configuration. Agent Controller never copies Tunnel
allocation ownership into its Agent projection. After Runtime readiness it
restores the captured policy assignment using Egress resource-version CAS,
calls `EnsureAgentNetwork`, and requires the same Tunnel, resolver, packet
contract, and Egress endpoint to be active before publication.

The Egress fence is not a third allocation state. Allocation remains `active`,
but fence durably assigns deny-all and clears packet state. The captured policy
is therefore part of the rebuild operation's recovery evidence.

Publication atomically installs the target AgentSpecRevision, one new
ExecutionRevision, the ready Runtime binding, `available`, and
`agent_rebuilt`. No partially published endpoint is usable. A transport or
ambiguous dependency result leaves the durable operation at its current phase
for exact-request replay. A conclusive pre-replacement failure restores the old
policy and executable source. After Runtime replacement is confirmed, failure
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
3. persist the current Egress policy assignment as recovery evidence, then
   fence the Agent to durable deny-all;
4. call Runtime Controller `DisableRuntime` with the frozen source Runtime
   revision; completed success must prove lifecycle `disabled` and health
   `absent`, returns the retained-workspace Runtime revision, and atomically
   releases any `runtime_mcp` unresolved admission bound to the removed source Runtime;
5. atomically publish desired/lifecycle state `disabled`, retain the current
   AgentSpec and last successful ExecutionRevision, clear the executable
   execution/MCP binding, store the disabled Runtime revision, and append
   `agent_disabled`.

A conclusive failure before Runtime disable restores the captured Egress
policy, desired state `enabled`, and the old executable binding. Once Runtime
Controller has received a disable request, restoration additionally requires
an authoritative inspection proving the exact frozen Runtime revision,
execution identity, MCP endpoint, lifecycle `ready`, and health `healthy`.
Mismatch projects the Agent as unavailable and leaves it fenced; ambiguous
effect or inspection remains running and fail-closed for exact-request replay.
A stable deleted inspection for the exact source Runtime revision is not
ambiguous: the failure, absence proof, unresolved-admission release, Agent
projection, and ordered audit facts commit atomically. With no blocked
admission, no synthetic release event or sequence increment is produced. A
plain missing-record response remains ambiguous and cannot cross this barrier.

Enable reuses the disabled Agent's last valid AgentSpec; configuration changes
always use explicit rebuild. It freezes the disabled Runtime revision, last
successful ExecutionRevision, and policy captured by the matching completed
Disable operation. It records the retained network attachment, calls Runtime
Controller with the disabled Runtime revision, persists the proven ready
result, enters a durable `network_restore` phase, restores only the captured
policy, verifies unchanged network coordinates, and publishes a new
ExecutionRevision. Before Runtime startup it verifies the current assignment is
the captured policy or canonical deny-all and reads the retained attachment
without reopening data flow, then reasserts and verifies deny-all before
Runtime startup. A changed unrelated policy is never overwritten; post-ready
restore failure re-fences the Agent. No policy reference is copied into the
Agent projection.

A conclusive Runtime `not_started` result is terminal only when authoritative
inspection still proves the exact disabled Runtime. Otherwise the projection
is not changed and the operation remains running and fenced. Once a ready
Runtime result exists, dependency ambiguity likewise leaves the operation
running and fenced for exact replay.

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

- `provider_credentials`;
- `model_profiles`, `model_profile_revisions`;
- `agent_templates`, `agent_template_revisions`;
- `agents`, `agent_spec_revisions`, `execution_revisions`;
- `agent_access_bindings`;
- `agent_lifecycle_operations`;
- `run_admissions`;
- `agent_events`.

`agents` is the global current-state projection; it is not an event-sourced
reconstruction requirement. Events and immutable revisions provide audit and
recovery evidence without forcing every query to replay history.

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

Every inbound RPC creates or continues a W3C trace. Lifecycle root spans use
the durable request ID, which is also the sole operation identity, and contain
child spans for Egress, Runtime Controller,
and database phases. Outbound clients propagate `traceparent` and `tracestate`.

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
