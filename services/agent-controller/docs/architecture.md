# Agent Controller Architecture

## Mission And Boundary

Agent Controller is the sole writer of Agent business state. It validates one
complete intended configuration, coordinates idempotent child operations, and
publishes a new executable revision only after Runtime and network readiness
are proven.

It depends on language-neutral HTTP contracts. It does not import another
service implementation or inspect another service database.

The document describes the completed target boundary. Implementation proceeds
as vertical business slices. At present ModelProfile/Template Catalog and the
Agent create and explicit rebuild Sagas are runnable. The other Agent lifecycle
commands, Run admission, recovery worker, and event
replay remain in progress and must not be inferred from table or contract
presence alone.

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
```

The desired state is business intent. The lifecycle state contains only stable
availability facts. Drain, rebuild, disable, and enable progress exists only in
the active LifecycleOperation, so there is one source of truth for process
state. A failed replacement clears `executable_execution_revision` once the old
Runtime is absent while retaining `last_successful_execution_revision` for
audit.

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

Operation kinds and successful paths are:

```text
create  validate -> network_ensured -> runtime_initialized -> published
rebuild drain -> network_fenced -> flows_reset -> runtime_updated
        -> network_reopened -> published
disable drain -> network_fenced -> runtime_disabled -> published
enable  network_ensured -> runtime_enabled -> published
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

An unresolved Tool effect leaves the Agent fail-closed until an explicit
lifecycle operation removes the bound Runtime. Timeouts are never treated as
proof that a side effect did or did not happen.

### AgentEvent

Events are immutable, monotonically ordered Agent-domain facts appended in the
same local transaction as the aggregate change. Every envelope contains an
event ID, global sequence, per-Agent aggregate sequence, schema version, Agent
ID, event type, optional operation/admission correlation, timestamp, trace ID,
and non-secret data. Global and per-Agent List are authoritative; Watch is a
best-effort wake-up channel resumed by global sequence. Agent Controller is not
a generic event broker.

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

1. Resolve and freeze the requested Template revision.
2. Persist Agent, AgentSpecRevision, owner access binding, create operation,
   projection state `provisioning`, and `agent_create_requested` atomically.
3. Ensure the Egress network attachment.
4. Construct Runtime Controller configuration from the frozen Runtime inputs
   plus returned network attachment.
5. Initialize Runtime with the durable child request ID and wait for a completed,
   healthy result whose effect is confirmed complete.
6. Re-read the Egress attachment and require the same active tunnel, resolver,
   packet contract, and endpoint used to initialize Runtime. This closes the
   readiness race without publishing a Runtime configured for stale network
   facts.
7. Atomically publish ExecutionRevision, set `available`, and append `agent_ready`.
8. Any terminal failure sets `unavailable`, records exact phase/class, and
   appends `agent_build_failed`.

The request thread currently drives these three durable create phases. A transport
timeout leaves the durable operation at its last committed phase; replaying the
same request continues with the same child request identity. Background claim
and recovery are added with the lifecycle-recovery slice.

### Explicit Rebuild

A rebuild freezes a target Template revision before closing admission. The
internal command is `POST /internal/agents/{agent_id}/rebuild` with one durable
`request_id`, `template_id`, and `template_revision`.

The request transaction locks the Agent, verifies its current executable Spec
and Runtime revisions, appends `agent_rebuild_requested`, and attaches the
operation without changing the stable `available` projection. New Run
admissions are rejected from that point. The drain phase remains pending while
an active admission exists; an admission whose executor is terminal but whose
Tool effect is unknown may cross the deletion barrier and is released only
after Runtime replacement proves the old compute absent.

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

### Disable, Enable, Delete

Disable fences traffic and removes compute while retaining workspace through
Runtime Controller. Enable reuses the last valid AgentSpec; configuration
changes always use explicit rebuild. It publishes a new ExecutionRevision.
Delete removes compute and workspace,
releases the Egress attachment, keeps immutable events/revisions for retention,
and hides the Agent from default active queries.

### Run Admission

Resolve access maps one trusted subject to one owner principal and Agent.
Acquire checks mapping revision, locks the Agent, requires `available`, rejects an
existing admission, and returns the complete immutable snapshot. Finish seals
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
