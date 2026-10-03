# Agent Controller Architecture

This document describes Agent Controller's service boundary, aggregate model,
lifecycle sagas, persistence ownership, observability and extension rules.

## Mission And Boundary

Agent Controller is the sole writer of Agent business state. It validates one
complete intended configuration, coordinates idempotent child operations, and
completes resource creation separately from executable availability. Lifecycle
operations commit configured Runtime ownership after platform creation; the
independent observation worker publishes execution only after healthy inspection.
See [Runtime availability](runtime-availability.md) for the two-stage contract.

It depends on language-neutral HTTP contracts. It does not import another
service implementation or inspect another service database.

Controller owns the ModelProfile/Template Catalog, management projections and
the five Agent lifecycle workflows. It publishes execution configuration to ACP
and requests lifecycle settlement from ACP; it exposes no execution RPCs.
Temporal owns management work scheduling; PostgreSQL retains phases and CAS,
not worker leases. Execution state and audit belong to ACP.

The [workspace metadata reader](workspace-state.md) does not read execution
state. Controller has no Run application or persistence code, so it is never a
second execution authority.

A small Runtime-observation consumer is intentionally not a general event bus.
It polls Runtime Controller's authoritative ordered journal with a persisted
cursor. Initial startup and expired-cursor recovery reconcile current Runtime
execution identities and confirmed missing compute first. A `restarted`,
`runtime_missing`, or `runtime_deleted` observation for the Agent's current
opaque Runtime revision atomically clears the executable binding. The Agent
remains `created/enabled`; observed Runtime condition changes independently.
Restart emits `agent_runtime_restarted`; missing/deleted compute emits
`agent_runtime_missing`, preserving the precise observation kind in `reason`.
The same transaction commits the event, consumer cursor and changed execution
configuration revision. The publisher closes the binding at ACP; remote application
is not atomic with the Controller transaction. ACP decides request admission and
retains execution facts. Observation never manufactures an execution result.

Initial/expired-cursor reconciliation treats a `provisioned` Runtime with `absent`
health as missing. Unknown/unhealthy status or a failed RPC is not proof of
container deletion. Old Runtime revisions, disabled Agents and active lifecycle
operations are not overwritten. Observation never rebuilds compute. It publishes first readiness only for a
configured never-bound target; an invalidated execution still needs
explicit lifecycle recovery.

Runtime-loss recovery reuses **Rebuild**, not a separate repair executor.
Lifecycle source is the current configured Spec and opaque Runtime revision,
with optional matching execution history. Never-ready resources do not need a
successful execution to be rebuilt, disabled, enabled or deleted. A last
successful execution from a previous Spec remains history, never the current
configuration. Quarantined invariants and revoked owners cannot start rebuild.

Admission compares the aggregate and source under the Agent row lock and
attaches the normal drain/fence/update/open/publish operation. A conclusive
pre-replacement failure preserves the source configuration. It restores the
attachment for available or still-provisioning sources, but does not reopen
historically invalidated unavailable sources. Unknown effects stay on the
original operation; observation never resolves an uncertain Tool result.

The separate [Identity offboarding consumer](identity-offboarding.md) receives
commit-ordered revocations through Identity RPC. It stores receipt progress and
per-owner scope watermarks, closes published execution permission, and schedules the same
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
A current model record stores model name, context/output limits, multimodal capabilities,
optional temperature/pricing and display name; it does not store credential versions
or copy the endpoint. See [Provider management](provider-management.md).

Controller publishes current Model parameters and independently versioned Provider
credentials to ACP. ACP selects execution configuration locally. Templates retain
stable model identity; credentials are never resolved from a build snapshot. Credential plaintext is absent from
browser-facing responses, specs and events. Provider writes, credential access
and execution publication use metadata-only telemetry even when RPC content
capture is enabled; see [observability](observability.md). Console resolves
credentials only through the scoped internal access endpoint for discovery.

### AgentTemplate

A Template head belongs to one organization and points to one immutable
TemplateRevision. A revision contains:

- one default stable ModelProfile identity and optional ordered fallback identities;
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
Skill package bytes. The catalog accepts exact Skill versions and stores
Registry-resolved immutable metadata in each Template revision. Historical
revisions and command replays read the stored metadata without selecting a new
version. AgentSpec copies those records alongside the model configuration. For
nonempty sets, lifecycle admission waits for Runtime Controller preparation
before creation, Drain, or network Ensure, and supplies the prepared reference
to the Runtime operation. This prevents a successful Agent creation that
silently lacks its configured Skills. Agents with an empty Skill set keep the
same lifecycle without a preparation phase.

A separate PostgreSQL preparation intent freezes the target and source
revisions without changing Agent admission. Lifecycle admission retries
preparation while it is queued and changes the Agent only after Runtime
Controller reports the prepared collection ready. Deterministically rejected
preparations are abandoned so a new operation can proceed. An invalidated
preparation before admission is released and restarted as a new durable
attempt. Terminal operations release the prepared reference.

Updating a Template creates a revision. It does not silently mutate existing
Agents. Applying that revision to an Agent is an explicit rebuild operation.
Model updates use an expected current version and replace the current record;
there is no independent model-history table or API. Template updates use
optimistic revision comparison and persist one complete immutable next revision.
Both operations preserve explicit business intent inside the repository transaction.

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
  lifecycle_state   not_created | created | deleted
  activation_state  enabled | disabled (only when created)
  runtime_state     waiting | available | unhealthy | exited | absent | unknown
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
and change its historical meaning. Identity receipt fences the local Agent and
advances its organization's configuration revision. ACP applies the resulting
principal grant and availability locally; it does not call Controller/Identity
per request. Revocation propagation is asynchronous, not an instantaneous
distributed authorization check. Controller never joins or writes Identity storage.
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
`aggregate_sequence` is the Agent concurrency revision. Domain transitions and
Runtime-observation fences advance it; it is not an event count. Ordered change
consumption belongs to the event journal rather than list pagination.

The persistence projection may retain a Runtime revision while an Agent is
disabled so a later Enable can describe its source state. The control API's
`runtime` object has narrower semantics: it is emitted only when revision,
execution identity, and MCP endpoint form one complete currently executable
binding. A retained revision alone is lifecycle evidence, not a partial wire
binding.

### AgentSpecRevision

An AgentSpecRevision is a complete immutable non-secret snapshot derived
from a specific Template revision and the selected current model configuration. It freezes the
system prompt, model request policy, context-policy version, model metadata,
Runtime image/resources/managed MCP configuration and canonical digest. Model
metadata here records build lineage only; ACP selects current synchronized Model
parameters by logical identity. Provider credentials are not build inputs.
Managed MCP arguments and environment are not copied into the ACP Agent
configuration payload or operational events.
The current projection always emits `skill_instructions: []`. The
[Skill Registry design](../../../docs/skill-registry-minimal-design.md) keeps it
permanently empty and retires the full-text channel. The execution snapshot
schema constrains the field to `maxItems: 0`, ACP rejects nonempty input, and
Console does not project `skillInstructions` bodies. Registry integration must
not populate this field.

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

Only one non-terminal management operation may own an Agent. Request, organization
and phase/Agent-ownership CAS protect its state. ACP owns local execution
occupancy; Controller does not reserve or release Runs.

### Current Execution Publication

An organization snapshot carries current model choices, current credentials,
Agent defaults, access scope and execution permission. It is not a Run snapshot.
The publisher performs HTTP outside transactions and records the applied revision.
During lifecycle changes it first confirms closed configuration, then requests
Agent-level settlement. ACP alone determines whether execution has settled.
See [Execution publication](execution-publication.md).

### AgentEvent

Events are immutable, monotonically ordered Agent-domain facts appended in the
same local transaction as the aggregate change. Every envelope contains an
event ID, global sequence, per-Agent aggregate sequence, schema version, Agent
ID, event type, optional lifecycle-operation correlation, timestamp, trace ID,
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
not_created -> created -> deleted
not_created -> deleted
created: enabled <-> disabled
created/enabled: waiting | available | unhealthy | exited | absent | unknown
```

Only created/enabled/available with a valid execution binding, desired enabled,
current owner authorization and no conflicting Operation or Run admits new Runs.
Progress and failure belong to the existing Operation, not additional lifecycle
states. See [Agent state](agent-state.md). Rebuild and
delete wait for a settled active Run. There is no force mutation and no
candidate Runtime.

## Business Scenarios

### Define Model And Template

1. Persist a Provider connection, its encrypted credential and explicitly selected initial models atomically.
2. Validate a Template's default and ordered fallback models under the organization lock;
   disabled Providers remain valid references, while model validity follows the catalog contract.
3. Persist the Template head and immutable revision atomically.
4. Template revisions and immutable Agent snapshots retain lineage; current models
   have no separate history API. The command ledger preserves replay receipts,
   and management events never contain credentials.

### Create Agent

1. Resolve and require one active Identity Service organization/user binding.
2. Resolve and freeze the requested Template revision.
3. Persist Agent, AgentSpecRevision, owner access binding, create operation,
   lifecycle `not_created`, and `agent_create_requested` atomically.
4. Ensure the Egress network allocation and require its attachment to be closed.
5. Construct Runtime Controller configuration from the frozen Runtime inputs
   plus returned network attachment.
6. Initialize Runtime with the durable child request ID. A completed
   `provisioned/unknown` result confirms resource creation, not readiness.
7. Open the attachment with resource-version CAS and require the same active
   tunnel, resolver, packet contract, and endpoint used to initialize Runtime.
   This closes the network-configuration race without publishing a Runtime configured for
   stale network facts.
8. Atomically commit the configured Spec and Runtime revision, complete the
   operation, clear the active slot, and append `agent_created`. Keep lifecycle
   state `created`, activation `enabled`, Runtime condition `unknown`, and all executable-binding fields empty.
9. Independently inspect pending Runtimes. Healthy matching observations append
   an immutable ExecutionRevision, set Runtime condition `available`, and append `agent_ready`.
   Publication checks current aggregate/configuration, owner authorization and
   absence of another lifecycle operation. Lost or early events cannot strand
   readiness because the worker also reconciles pending intent.
10. Initial creation failure retains `not_created`, records exact phase/class,
   and appends `agent_build_failed`. Later failures never erase established creation.

The request thread commits intent and returns `202 Accepted`; it does not
execute lifecycle effects. Temporal dispatches Activities and retains child
request identities across retries/restart. HTTP request
replay returns the existing operation; only workflow Activities advance effects.

### Explicit Rebuild

A rebuild freezes a target Template revision before closing admission. The
internal command is `POST /internal/agents/{agent_id}/rebuild` with one durable
`request_id`, `template_id`, and `template_revision`.

The request transaction locks the Agent, verifies its current configured Spec
and Runtime revisions, appends `agent_rebuild_requested`, and attaches the
operation without inventing another Runtime condition. The current execution
projection closes new Runs; drain confirms that ACP applied this configuration
and requests Agent-level settlement. Only ACP interprets execution or Tool
state. Controller conditionally persists the settlement outcome and advances
the management operation, without reading or changing any Run record.
See [execution publication](execution-publication.md#lifecycle-settlement).

Once drained, the Saga reads the current Egress allocation and closes its
Runtime attachment with attachment resource-version CAS. Closing is one
Egress-owned barrier: it blocks packets, drains packet writers, and clears
userspace and conntrack flow state without changing desired policy. Agent
Controller persists the returned closed attachment and calls Runtime Controller
`UpdateRuntime` with the source opaque Runtime revision and complete target
Runtime configuration. Agent Controller never copies Tunnel allocation
ownership into its Agent projection. After confirmed platform replacement it opens that same
attachment with CAS and requires unchanged Tunnel, resolver, packet contract,
and Egress endpoint before publication.

Desired Egress policy and lifecycle attachment state are independent. Policy
updates made while an attachment is closed remain durable and are applied by
Egress when the attachment opens. Lifecycle operations neither read nor rewrite
policy assignments.

Publication atomically installs the target AgentSpecRevision and Runtime
revision, clears the executable binding, retains `created/enabled` with Runtime `unknown`, completes the
operation, and appends `agent_rebuilt`. Healthy observation later publishes
execution independently. No partially published endpoint is usable. A transport or
ambiguous dependency result leaves the durable operation at its current phase
for exact-request replay. A conclusive pre-replacement failure preserves the
configured source; its attachment may reopen only if the owner remains allowed
and ACP did not require a Runtime barrier. After Runtime replacement is confirmed, failure
remains non-terminal and fail-closed until exact replay can publish the observed
Runtime; there is no implicit rollback.
If Runtime Controller returns a stable deleted inspection for the exact source
Runtime revision, the source executable cannot be preserved. The same failure
transaction records the absence proof, clears the unusable executable projection
and appends a build-failure fact. It does not alter ACP execution evidence. A plain `runtime_not_found` response
does not prove physical Runtime absence and therefore leaves the operation
running and fail-closed for inspection or replay.

### Disable, Enable, Delete

Disable is a restartable Saga, not a projection-only flag:

1. atomically set desired state `disabled`, attach the operation, append
   `agent_disable_requested`, and publish execution closed;
2. confirm the closed configuration and request ACP settlement, using wait for
   ordinary disable and cancel for identity revocation;
3. close the Runtime attachment with Egress CAS; Egress owns packet gating and
   flow cleanup while preserving the desired policy;
4. call Runtime Controller `DisableRuntime` with the frozen source Runtime
   revision; completed success must prove lifecycle `disabled` and health
   `absent` and return the retained-workspace Runtime revision;
5. atomically publish desired/activation state `disabled`, retain lifecycle `created` and the current
   AgentSpec and last successful ExecutionRevision, clear the executable
   execution/MCP binding, store the disabled Runtime revision, and append
   `agent_disabled`.

A conclusive failure before Runtime disable preserves the configured source.
Restoration must not override identity revocation or ACP's Runtime-barrier
requirement; neither permits reopening the attachment. Once Runtime
Controller has received a disable request, restoration additionally requires
an authoritative inspection proving the exact frozen Runtime revision,
execution identity, MCP endpoint, lifecycle `provisioned`, and health `healthy`.
A source that never had an execution only requires its unchanged configured
Runtime head; it must not be restored to `available`.
Mismatch projects the Agent as unavailable and leaves its attachment closed; ambiguous
effect or inspection remains running and fail-closed for exact-request replay.
A stable deleted inspection for the exact source Runtime revision is not
ambiguous: the failure, absence proof, Agent projection and management audit
fact commit atomically. No execution event or additional aggregate increment
is synthesized. A
plain missing-record response remains ambiguous and cannot cross this barrier.

Enable reuses the disabled Agent's last valid AgentSpec; configuration changes
always use explicit rebuild. It freezes the disabled Runtime revision and
optional last successful execution history, ensures the retained network allocation remains
active with a closed attachment, and calls Runtime Controller with that closed
attachment. After persisting confirmed platform creation it enters the durable
`network_restore` phase, opens the same attachment with CAS, verifies unchanged
network coordinates, and completes in `created/enabled` with Runtime `unknown`, without a new execution.
Independent health observation creates the next actual ExecutionRevision. Desired policy is
not part of the lifecycle operation: any policy revision assigned while the
Agent was disabled is applied by Egress during open.

A conclusive Runtime `not_started` result is terminal only when authoritative
inspection still proves the exact disabled Runtime. Otherwise the projection
is not changed and the operation remains running with a closed attachment. Once
a completed provisioning result exists, dependency ambiguity likewise leaves the
operation running with a closed attachment for exact replay.

Delete admission remains local and asynchronous. An empty published Runtime
revision means the cleanup target is unresolved, not that deployment resources
are absent. After draining and closing the network attachment, the worker asks
Runtime Controller for its authoritative Environment. A stable provisioned, disabled,
or failed Environment supplies the exact cleanup revision; only authoritative
not-found or deleted results supply an absence proof. Transitional or unknown
state cannot advance deletion. The source inspection/proof is frozen in the
same transaction as leaving `network_fence`, using existing operation columns.
Subsequent retries use that revision and the original child request ID; they
never rebase deletion onto a newly observed revision. Admission performs no
remote inspection, and no new lifecycle phase or table is introduced.
Ownership inspection is not executable readiness: stable provisioned/disabled heads
may report degraded live health and still supply a cleanup revision. Publishing
an execution binding requires an independently inspected healthy Runtime.

The Runtime Controller contract completes initialize/update/enable with
`provisioned/unknown`, without execution identity or endpoint. Stored
`runtime_not_ready` failures remain readable for cleanup and exact replay but
are not produced by current creation. Error reconciliation still uses the exact
request journal and never adopts another operation. Runtime readiness does not
add a Temporal activity or keep a lifecycle operation running.

Delete removes compute and workspace, releases the Egress attachment into
quarantine, keeps immutable events/revisions for retention, deactivates the
owner binding, and hides the Agent from default active queries. Once deletion
intent is persisted it is not rolled back to an executable Agent; ambiguous
external effects remain on the same operation until reconciled.
The proven Runtime-deletion barrier, or an authoritative pre-existing absence
proof, permits the management operation to continue to network release. It does
not rewrite execution audit or release a Controller Run record.
The deletion fence contains only the frozen Runtime revision, or an
authoritative proof that no Runtime exists. AgentSpec and Execution revision
identities are deliberately excluded because they cannot strengthen Runtime
deletion and would make failed initial provisioning impossible to clean up.

## Persistence Ownership

Skill Learning policy is a separate Controller-owned aggregate per Agent. A
first owner-scoped read materializes the v1 automatic default; it is not part
of a Template, Agent Spec or Runtime deployment digest. The policy row records
its own sequence and deterministic SHA-256 revision. A mutation locks current
Identity admission and Agent ownership, then atomically stores the new policy
and a request-ID receipt. Exact retries return that receipt; changed payloads
or stale policy revisions conflict. The read/result policy includes a
server-owned activation cut: the lazy default uses the Agent creation timestamp,
an `off` to `automatic` transition refreshes
it, and other mutations preserve it. It participates in the policy revision
but cannot be selected by a mutation caller. Owner-authorized canonical pins
are accepted because they only remove automatic maintenance rights; no existing
path or ownership is inferred. A pin may name a path that does not exist yet.
The reserved `adopted_paths` list must remain empty; explicit adoption is
planned. Policy changes create no Agent Spec or Runtime revision. ACP owns the
background learner, consumes the policy through the scoped internal read, and
rechecks it before committing a learning candidate. See the
[Skill Learning contract](../../../contracts/skill-learning/learning-api.md).

The schema owns:

- `provider_connections` (connection metadata and current encrypted credential);
- `model_profiles` (current model parameters, version and configuration stamp);
- `catalog_requests` (catalog command idempotency receipts);
- `agent_templates`, `agent_template_revisions`;
- `agents`, `agent_spec_revisions`, `execution_revisions`;
- `agent_access_bindings` (one owner binding per Agent, keyed by `agent_id`);
- `agent_lifecycle_operations`;
- `agent_skill_preparation_intents`;
- `execution_configuration_sync`;
- `runtime_observation_cursor`;
- `identity_revocation_cursor`, `owner_revocations`;
- `skill_learning_policies`, `skill_learning_policy_requests`;
- `event_journal_cursor`, `agent_events`.

Resource identifiers follow the
[platform resource ID contract](../../../contracts/resource-identifiers.md),
which separates resource kind from retry purpose. Create and Rebuild both
generate `agentspec_` IDs; execution revisions use `execution_`, and all
lifecycle, Runtime observation and owner-revocation events use `event_`. Stable
namespaces retain retry deduplication. Existing records, client request keys,
content digests and Runtime incarnation tokens keep their own formats. Identity
and ACP own their respective resource generators.

`agents` is the global current-state projection; it is not an event-sourced
reconstruction requirement. Events and immutable revisions provide audit and
recovery evidence without forcing every query to replay history.

Agent default authorization lives in `agents.default_authorization` with its
own CAS revision. It is separate from the Runtime/build specification and is
published as a default, not merged with Session settings by Controller.
`agent_authorization_updated` records a management revision change. See
[Agent defaults](session-configuration.md) for the current contract.

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
phase, lifecycle state, configuration/execution/runtime revision, lifecycle
result and stable error class. Common RPC instrumentation controls optional
development payload capture; those payloads may contain submitted credentials.
Business code does not add prompts or tool payloads to spans.
See [observability](observability.md) for the authoritative collection policy.

Required metrics are low-cardinality:

- Agent projection count by lifecycle state;
- lifecycle operation duration/result by kind and phase;
- configuration synchronization revision lag and publication failures;
- dependency RPC duration/result by service and operation;
- event-journal append/watch disconnect counts.

## Extension Rules

- Skill Registry integration adds immutable Skill references to Template and
  AgentSpec revisions; it never lets Agent Controller read Skill storage or
  populate `skill_instructions`. Runtime discovery and on-demand reads are the
  only planned body-delivery path.
- The Skill-set preparation phase precedes Initialize and, for rebuild,
  precedes both Drain and Egress Fence. Rebuild preflight retains the source
  execution publication and admission, then checks source revisions before
  entering the lifecycle workflow. Enable validates its retained set before
  NetworkEnsure. A durable operation-owned reference, without TTL, protects the
  target until settlement and overlaps RC's lifecycle reference. External drift
  rejected after Fence must restore the intact, still-authorized source network
  and admission before completing that attempt as failed; never wait fenced
  for another download. RC owns preparation and references. The Controller
  stores the intent before lifecycle admission and exposes its scoped progress
  through `GET /internal/agent-skill-preparations/{request_id}`, which is
  available before the Agent row exists. The endpoint combines the durable
  intent with RC's live receipt while preparing or ready, omits the frozen spec
  and prepared reference, and returns a retryable dependency error if the RC
  read fails. There is no shared-volume Skill migration, protected export,
  migration admission gate or special recovery workflow.
- The separate [learning design](../../../docs/skill-learning-design.md)
  assigns automatic-learning policy, scope/pinning, authorization and budgets to
  Controller. Controller persists the policy, serves the scoped read and
  mutation, accepts owner-authorized pins and rejects nonempty
  `adopted_paths`. ACP owns triggers, managed provenance, candidates,
  policy-bound application records and execution; manual saving is optional.
- A Kubernetes adapter changes Runtime Controller only.
- A KMS adapter replaces local encrypted credential storage behind the
  credential port without changing Run contracts.
- Public management APIs belong behind Edge Gateway and must not make this
  internal RPC surface public by accident.

## Workspace Metadata Boundary

Controller lists Agent IDs and names for the requested organization and principal using active access bindings and the owner revocation watermark.
The list is management metadata, not execution admission: disabled or unavailable Agents remain discoverable while authorized; deleted Agents do not.
List items carry no availability or opaque access subjects, and Controller provides no workspace state get/watch.
Execution state, current Session and cancellation belong to ACP.

## Service authentication rollout

The [platform authentication contract](../../../contracts/platform/service-authentication.md)
and this service's [planned caller catalog](../../../contracts/agent-controller/callers.json) define verified
workload identity and route-specific caller context. Listener enforcement is
pending in [#32](https://github.com/tf4fun/antnest-platform/issues/32) and [#28](https://github.com/tf4fun/antnest-platform/issues/28); this foundation does not change the current HTTP
authorization behavior. Follow the [rollout ledger](../../../contracts/platform/service-authentication-rollout.json)
and run the shared route/media-type checks in the owning-service batch before
the cross-service Docker security acceptance.
