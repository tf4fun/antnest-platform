# Stage 2 Agent And ACP Architecture

> Status: reviewed target design, pending implementation<br>
> Updated: 2026-08-31<br>
> Compatibility: greenfield service rewrite; no prototype wire or database
> compatibility is retained<br>
> Protocol baseline: stable ACP v1, side-by-side ACP v2 Draft, and MCP
> `2026-07-28`

Stage 2 turns the Stage 1 Runtime and Egress foundation into the smallest useful
Agent platform: create an Agent, build its isolated Runtime, expose the Agent
through standard ACP, and execute one serialized Run at a time.

This document is authoritative for Agent rebuild, Run admission, ACP Session
ownership, and MCP source composition. It supersedes candidate/active Runtime
rollout, transparent Runtime switching, environment epochs, generation-based
execution fencing, and stable Runtime MCP proxy designs in older documents. It
retains one process identity check solely to reject a stale MCP request after a
Runtime process restart. It does not change the implemented Runtime/Egress
packet and policy contracts.

## 1. Decision Summary

1. An Agent is a durable logical entity. A Runtime is disposable physical
   compute owned by one Agent.
2. Agent configuration changes use an explicit, full rebuild. The Agent stops
   accepting new Runs until the old Runtime is removed, the new Runtime is
   ready, and one new execution revision is atomically published.
3. There is no candidate Runtime, active/candidate switch, transparent MCP
   proxy, or zero-downtime Runtime rollout in Stage 2.
4. Agent ACP Service is a replaceable compute service with its own durable
   PostgreSQL state for ACP Sessions, messages, context, Runs, and audit facts.
5. Every Run acquires one immutable execution snapshot. A planned Agent rebuild
   cannot move that Run to another configuration, Runtime instance, or Runtime
   process lifetime.
6. Runtime MCP and client-provided MCP are separate sources. Runtime MCP is a
   platform-owned Agent binding; client MCP is standard ACP Session input.
7. Antnest Runtime implements stateless MCP `2026-07-28` Streamable HTTP.
   Replacing its endpoint therefore changes an Agent execution binding, not an
   MCP protocol Session.
8. ACP Session identity survives an Agent rebuild. On the next Run in a Session
   that previously executed under an older revision, the Agent receives one
   internal context fact describing the change. A Session with no previous Run
   starts from current state and needs no change notice.
9. Unexpected Runtime restarts are observable infrastructure facts. Stage 2
   does not automatically replay work, rebuild the Agent, or pretend temporary
   process state survived.

## 2. Goals And Non-Goals

### 2.1 Goals

- Keep Agent lifecycle, Runtime deployment, ACP execution, and MCP transport in
  separate, understandable ownership boundaries.
- Preserve standard ACP and MCP request and success payloads. Stable
  implementation-defined JSON-RPC errors may describe temporary Agent state.
- Serialize Runs for one Agent so filesystem, process, Memory, and Personal
  Skill changes cannot race.
- Make a configuration update either fully published or visibly failed.
- Let service instances restart or scale without storing authoritative state in
  process memory.
- Record enough immutable facts to explain which configuration and Runtime
  executed every Run.
- Keep the first implementation small enough to test end to end in Docker.

### 2.2 Non-goals

- Zero-downtime Runtime updates.
- Preserving `/tmp`, background processes, ports, PIDs, or in-memory handles
  across Runtime replacement or failure.
- Automatically replaying an ambiguous Tool side effect.
- Hot-swapping an arbitrary third-party ACP Agent implementation.
- A generic event bus, workflow engine, service mesh, or distributed
  transaction coordinator.
- Runtime Controller proxying MCP traffic.
- Client control over platform Runtime MCP.
- Rebuilding Runtime for an Egress policy update.
- Active-active Agent ACP Run workers. Stage 2 enforces one Run-executor owner
  per service database with a dedicated PostgreSQL advisory-lock connection;
  per-Run claims are deferred.

## 3. Core Domain Model

### 3.1 Logical Agent

`agent_id` is the stable business identity. Rebuild does not change:

- organization and owner-user binding;
- owner and authorization binding;
- transport-level Agent access-subject mapping;
- ACP Sessions and conversation history;
- persistent workspace and Personal Skills;
- historical Runs, Tool attempts, and Agent events;
- Egress Tunnel address and policy assignment.

Agent Controller also owns reusable Template heads and immutable Template
revisions. Creating or rebuilding an Agent materializes one complete
AgentSpecRevision from an exact Template revision and ModelProfile revision;
later Template changes never mutate an existing Agent implicitly. The Agent
projection separates desired state (`enabled`, `disabled`, `deleted`) from
stable availability (`provisioning`, `available`, `unavailable`, `disabled`,
`deleting`, `deleted`). Process phases live only in LifecycleOperation.

### 3.2 AgentSpecRevision

An immutable description of intended Agent behavior:

```text
AgentSpecRevision
  agent_id
  revision
  model_profile_ref
  system_prompt_policy
  context_policy_version
  runtime_spec_input
  credential_refs
  canonical_digest
  created_at
```

It stores credential references, never secret values. Model profiles, prompt
policies, and every other referenced behavior are immutable, versioned, or
content-addressed. `canonical_digest` covers the complete transitive non-secret
configuration. Skill Registry is absent in Stage 2, so Skill input is rejected
and the effective Skill list is always empty. A revision is not executable
until lifecycle publication creates a matching ExecutionRevision.

Network policy is absent. Egress policy has an independent lifecycle and does
not rebuild Runtime.

### 3.3 Runtime Environment binding

Agent Controller stores one opaque Runtime Environment binding containing
`agent_id`, `runtime_revision`, lifecycle state, discovered MCP endpoint, and
execution identity. It never stores or selects Docker/Kubernetes resources,
physical generation, deployment digest, or workspace identity.

Runtime Controller privately maps that logical environment to at most one
compute resource and one persistent workspace. Stage 2 never prepares a second
Runtime concurrently.

The deployment platform may restart PID 1 inside the same physical resource.
Runtime generates a fresh `runtime_execution_id` on every PID 1 start and
returns it from `/status`. This is an infrastructure identity, not a
configuration generation or credential.

### 3.4 ExecutionRevision

An immutable record of one successfully published executable Agent:

```text
ExecutionRevision
  agent_id
  revision
  agent_spec_revision
  runtime_revision
  runtime_execution_id
  runtime_mcp_endpoint
  change_summary
  published_at
```

The Runtime MCP endpoint and execution ID are computed deployment output. They
are not editable Agent configuration and never appear in ACP requests.

### 3.5 ACP Session

An ACP Session is one conversation context owned by Agent ACP Service. It binds
to one Logical Agent, not one physical Runtime resource.

Its durable state includes:

- `session_id`, `agent_id`, and authenticated principal binding;
- message order and replay identifiers;
- context summary and compression checkpoints;
- client MCP configuration or encrypted credential references;
- nullable identity of the ExecutionRevision used by its latest admitted Run;
- Session configuration defined by ACP.

The process serving a Session is replaceable. The Session itself is stateful
and lives in Agent ACP Service storage.

### 3.6 RunExecutionSnapshot

Every accepted Run freezes this immutable snapshot:

```text
RunExecutionSnapshot
  run_id
  admission_id
  agent_id
  session_id
  agent_spec_revision
  execution_revision
  runtime_revision
  runtime_execution_id
  runtime_mcp_endpoint
  client_mcp_revision
  agent_execution_spec_digest
  credential_version
```

The snapshot contains a complete immutable non-secret Agent execution spec,
not mutable references. Credentials are resolved once per Run into process
memory; only their non-secret version is recorded. The snapshot is retained
with the Run for audit and incident analysis.

## 4. Agent Lifecycle And Rebuild

### 4.1 State machine

```text
PROVISIONING -> AVAILABLE | UNAVAILABLE | DELETING
AVAILABLE    -> DISABLED | UNAVAILABLE | DELETING
DISABLED     -> AVAILABLE | UNAVAILABLE | DELETING
UNAVAILABLE  -> AVAILABLE | DELETING
DELETING     -> DELETED
```

Only `AVAILABLE` with no active lifecycle operation accepts a new Run.
AcquireRun and lifecycle-operation creation lock the same Agent row in one
transaction. A partial unique constraint permits at most one admission that
still occupies the Agent and one non-terminal lifecycle operation per Agent.

Drain, rebuild, disable, and enable are operation phases, not duplicate Agent
states. An active operation closes admission. The projection keeps nullable
`executable_execution_revision` separate from
`last_successful_execution_revision`; after the old Runtime deletion barrier,
the former is cleared while the latter remains audit history.

### 4.2 Initial creation

1. Agent Controller validates the complete Agent configuration.
2. It persists Logical Agent, immutable AgentSpecRevision, and a durable
   create operation in `PROVISIONING`.
3. It obtains or reuses the Agent network attachment from Runtime Egress.
4. It asks Runtime Controller to initialize the Agent's Runtime Environment
   with the complete Runtime configuration.
5. Runtime Controller returns only after platform health and Runtime `/status`
   agree that the instance is ready. The result includes its MCP endpoint and
   `runtime_execution_id`.
6. Agent Controller atomically publishes ExecutionRevision and state
   `AVAILABLE`.
7. Any failed stage records the exact failing stage and leaves the Agent in
   `UNAVAILABLE`. `AVAILABLE` proves readiness passed at publication time; a later
   Runtime failure is still possible and appears as a normal infrastructure
   failure.

### 4.3 Explicit rebuild

1. Validate and persist the target AgentSpecRevision and one durable rebuild
   operation. The operation stores its expected source Agent and Runtime
   revisions, target digest, child request IDs, and current phase
   before any RPC.
2. Lock the Agent row and atomically attach the rebuild operation; from this
   point `AcquireRun` rejects new Runs with a retryable rebuilding result while
   the stable Agent availability remains unchanged until an external barrier.
3. Wait until any active Run executor is quiescent. A normally settled admission
   closes before rebuild continues. An `unresolved` admission may continue to
   the deletion barrier only after its executor can issue no more model or MCP
   requests; Runtime absence then settles that admission without claiming that
   the Tool succeeded or failed. Runtime is never changed while a Run executor
   is still active.
4. Advance the operation from drain to its network barrier.
5. Read and persist the Agent's current immutable policy assignment, then fence
	the Agent network. Runtime Egress durably assigns deny-all while fencing.
	Call `ResetAgentFlows(agent_id)` and require acknowledgement so the stable
	Tunnel address cannot retain the old Runtime UDP peer.
6. Call Runtime Controller `UpdateRuntime` with the current opaque revision and
   complete target configuration. Runtime Controller deletes current compute,
   allocates a private generation, retains workspace, and creates replacement
   compute under one idempotent lifecycle operation.
7. Wait for Runtime Controller to return a ready endpoint and execution ID.
8. Restore the captured policy assignment with Egress resource-version CAS,
	then call `EnsureAgentNetwork` to reconcile and reopen the Agent path.
9. Atomically publish the target AgentSpecRevision, new ExecutionRevision,
   Runtime binding, change summary, and state `AVAILABLE`.
10. Append the corresponding Agent domain event in the same local transaction.

There is intentionally a period with no Runtime. This removes the candidate,
route-switch, stale-endpoint, and rollback state machines.

Every phase is replayable after Agent Controller restart. Recovery inspects the
recorded Runtime revision and repeats the same idempotent child request. It must
adopt that ready Runtime or delete it conclusively before starting another
lifecycle mutation.

### 4.4 Drain timeout and cancellation

Drain timeout records `run_drain_timeout` and fails the operation only when no
rebuild side effect has started. The Agent stays `AVAILABLE`, the target
configuration remains non-executable, and the operator can cancel the Run
through ACP and retry.

Stage 2 has no force-rebuild shortcut. Standard ACP `session/cancel` stops the
local Run executor and propagates cancellation to the model and both MCP source
classes. For MCP `2026-07-28` HTTP, closing a request's SSE response is the
transport cancellation signal, but cancellation still does not prove that a
side effect was never started.

If the local executor is terminal while any Tool effect remains unknown,
the admission stays unresolved. An explicit rebuild may then delete the old
Runtime conclusively and close that admission before creating its replacement.
No new Run is admitted in the interval.

### 4.5 Build failure and retry

- A conclusive failure before old Runtime deletion restores the captured Egress
  policy and leaves the old executable binding `AVAILABLE`.
- After Runtime replacement is confirmed, an inconclusive dependency or
  readiness result keeps the same operation running and the Agent fail-closed.
  Exact-request replay must adopt and publish that Runtime; it must not fabricate
  a terminal failure with no recovery path.
- Crash recovery resumes the same operation and child identities. A later
  operator retry creates a new operation only after the previous operation is
  terminal and every attempted Runtime is conclusively absent or adopted.
- At most one non-absent Runtime resource may exist for an Agent in Stage 2.
- Retry may reuse the validated target AgentSpecRevision.
- Automatic rollback is deferred. A rollback is an explicit rebuild to a
  previous immutable AgentSpecRevision.

### 4.6 Agent deletion

Deletion is a durable, restartable workflow:

1. lock the Agent row, set desired state `deleted`, change availability to
   `DELETING`, and reject new Run admission;
2. wait for the active admission to finish or follow the same explicit
   cancellation and unresolved-effect rules as rebuild;
3. fence the Agent network and clear Egress flows;
4. call Runtime Controller `DeleteRuntime`, which removes compute and workspace
   as one revision-fenced lifecycle operation;
5. mark the Agent `DELETED` and append the domain event atomically;
6. release the Tunnel address into Egress quarantine.

An ambiguous Runtime or storage deletion keeps the workflow non-terminal. It
never releases the network address or reports successful deletion early.

### 4.7 Agent disable and enable

Disable persists desired state `disabled` and `agent_disable_requested` before
waiting for the Agent-wide Run admission to settle. It captures the current
Egress policy assignment as operation recovery evidence, fences the active
attachment to deny-all, and calls Runtime Controller `DisableRuntime` with the
frozen Runtime revision. Completed success must prove compute absent while the
workspace remains owned by the logical Runtime. Publication retains the
AgentSpec and last successful ExecutionRevision, clears the executable MCP
binding, stores the disabled Runtime revision, and appends `agent_disabled`.

If Runtime Controller reports that disable was not started, Agent Controller
independently inspects the exact frozen Runtime revision, execution identity,
MCP endpoint, lifecycle, and health before restoring the captured policy and
old executable projection. A changed or unhealthy Runtime is never restored:
the Agent becomes unavailable and remains fenced for operator recovery. A
transport timeout, failed inspection, or unknown effect is not evidence of
failure; the operation remains running and fail-closed for exact-request
replay.

Enable is valid only from the published disabled state. The new operation
freezes the current AgentSpec, disabled Runtime revision, and policy captured by
the matching completed Disable operation. It ensures the existing network
attachment, calls `EnableRuntime` with the complete Runtime configuration, then
restores the captured policy and verifies unchanged network coordinates before
publishing a new ExecutionRevision and `agent_enabled`. Agent configuration is
never changed implicitly by Disable or Enable.

## 5. Serialized Run Admission

Run serialization is Agent-wide, not Session-wide. Two ACP Sessions for one
Agent cannot execute concurrently against the shared workspace and Personal
Skills.

### 5.1 AcquireRun

Before calling Agent Controller, Agent ACP Service persists an `admitting` Run
intent with the pending prompt, a generated durable request ID, the expected
access revision, and the Session's current client MCP revision. The pending
prompt is not yet part of accepted conversation history. Recovery always uses
these captured facts rather than later Session or access state.

Agent ACP Service then calls:

```text
AcquireRun(agent_id, principal_id, expected_access_revision, session_id, request_id)
```

In one Agent Controller transaction it:

1. looks up `request_id` before evaluating current Agent state and returns its
   original response when the fingerprint matches;
2. rejects reuse of the same request ID with different input;
3. locks the same Agent row used by lifecycle transitions;
4. verifies state is `AVAILABLE`, no lifecycle operation is active, and no
   admission still occupies the Agent;
5. creates a durable admission;
6. copies the current ExecutionRevision and complete immutable non-secret Agent
   execution spec into the stored response.

The response contains `admission_id`, deadline, Runtime endpoint, expected
Runtime execution ID, and Agent execution spec. It contains no client MCP
configuration and no Provider secret. A partial unique database constraint is
the final guard against concurrent acquisitions.

After receiving the response, Agent ACP Service stores RunExecutionSnapshot and
promotes the pending prompt to accepted history in one local transaction. If it
crashes first, recovery retries AcquireRun with the same request ID and obtains
the same admission and snapshot input.

When another Run is active, the request returns `agent_busy`; Stage 2 does not
build a hidden queue. The caller can present waiting state and retry later.

### 5.2 FinishRun

```text
FinishRun(admission_id, terminal_class, tool_effect_state, stop_reason, error_class)
```

is idempotent. Calling it asserts the local Agent loop is quiescent and cannot
issue another model or MCP request. `terminal_class` is a small coordination
result: completed, cancelled, failed, or unresolved. Once recorded, the report
is immutable.
`tool_effect_state` is `none`, `settled`, or `unknown` and covers both Runtime
and client MCP Tools.

`FinishRun` seals one immutable terminal report. A successful RPC response means
that report is stored, not necessarily that the Agent is available for another
Run. Completed, cancelled, and failed reports release admission. An unknown
Tool effect seals an unresolved report but moves admission occupancy to
`blocked_unknown_effect`; Agent Controller stays fail-closed until an explicit
lifecycle operation proves the bound Runtime absent. That barrier releases the
occupancy without rewriting the report. Agent ACP Service never replays or
later rewrites the ambiguous Tool outcome. Agent Controller does not copy
messages, Turns, Tool results, or detailed Run history from Agent ACP Service.

### 5.3 Crash recovery

Every Run has a configured maximum deadline, and all model and MCP calls use
deadlines no later than that boundary. A lost Agent ACP Service instance leaves
the admission fail-closed.

Expiration alone does not prove a dispatched Tool stopped. Recovery therefore
classifies persisted Tool attempts rather than treating every interrupted Run
the same: an in-progress call has unknown effect and makes the admission
`unresolved`; a call retained in the assistant response but not yet dispatched
is closed as not executed; a Run with no unknown Tool effect terminates failed
and quiescent. The single Stage 2 Agent ACP Run worker recovers its own
`admitting` and executing Runs, retries AcquireRun with the same request ID,
and reports terminal state. Agent Controller never calls back into Agent ACP
Service, so the dependency direction remains acyclic.

If a crash happened during an ambiguous Tool attempt, recovery does not resume
the Tool loop or start another worker. The Run remains unresolved until the
effect is observed terminal or the bound Runtime is removed by an explicit
rebuild. This is fail-closed recovery, not automatic replay.

## 6. ACP Boundary

### 6.1 Standard wire only

Agent ACP Service implements stable ACP v1 at `/v1/acp` and the ACP v2 Draft at
`/v2/acp`, without adding Antnest fields. Both adapters use the official SDK and
the same application core. The unversioned `/acp` is absent, so a client cannot
silently change protocol semantics. In particular, clients never send:

- `agent_id` as a private Session field;
- Runtime endpoint or Runtime instance identity;
- Agent configuration revision;
- platform MCP configuration;
- rebuild or admission state.

Implementation-defined JSON-RPC errors may communicate `agent_busy`,
`agent_rebuilding`, and `agent_build_failed`, but no custom success payload is
required.

### 6.2 Agent selection through transport identity

The trusted transport supplies an opaque Agent-scoped access subject. Antnest's
credential mapping resolves that subject to exactly one authorized Logical
Agent before the connection is accepted and revalidates it before every ACP
business operation.

The mapping is a trusted transport authentication result, not an ACP auth
method or schema extension.
A Session cannot switch Agent after creation. Supporting one user selecting
among several Agents belongs in Edge Gateway or client connection selection,
not in Session parameters.

Every request, including new, list, resume, prompt, cancel, close, and delete,
must resolve to the connection's bound principal, Agent, and access revision.
Agent Controller advances that revision when authorization, mapping, or prompt
capability changes; stale connections fail closed and reconnect. Existing
Session operations also verify the current principal against the Session's
stored principal and `agent_id`. `session/list` returns only Sessions visible to
that principal. Credential remapping never rebinds an existing Session.

### 6.3 Session behavior during rebuild

- Existing Sessions remain durable and resumable.
- `session/new` and `session/resume` may complete while an Agent is rebuilding,
  but `session/prompt` does not start a Run until the Agent is `READY`.
- A Session's previous-execution identity remains null until its first accepted
  Run; Session creation during rebuild therefore cannot invent a stale baseline.
- A prompt rejected before AcquireRun is not persisted as an accepted user
  message.
- Stable v1 blocks `session/prompt` until the Run is terminal and returns its
  `stopReason`. Draft v2 acknowledges `session/prompt` with `{}` before sending
  any Session update, then reports completion with an `idle` `state_update`.
- No ACP Client reconnect is required after a successful rebuild.
- Stable v1 `session/load` restores durable context, applies the supplied full
  MCP list, and replays history before returning. Stable v1 `session/resume`
  restores without historical replay. Draft v2 `session/resume` uses
  `replayFrom=start` for full replay and otherwise resumes without history.
  Resume emits the current durable Run projection when that protocol has a
  state update, so a replacement v2 client repairs its input controls after a
  disconnect.
- A lost prompt response is never replayed merely because the JSON-RPC ID is
  repeated. Run idempotency uses the server's durable Run intent.
- `session/cancel` is authorized like every Session method and propagates one
  cancellation context through model and MCP calls before the Run reports
  executor quiescence.
- Stage 2 accepts only the logical Runtime workspace path `/workspace` as ACP
  `cwd`; it never interprets a remote client's absolute path on the ACP service
  host. Additional workspace roots are not advertised.

## 7. Two MCP Sources

### 7.1 Client MCP

Client MCP comes only from ACP `session/new.mcpServers` and
`session/resume.mcpServers`:

- it is scoped to one ACP Session;
- a resume request supplies the complete intended list;
- changing it does not create AgentSpecRevision or rebuild Runtime;
- Agent ACP Service stores a normalized revision and protects secret headers;
- replacing the list atomically changes the Session's encrypted configuration
  revision; MCP connections are request-scoped and are not retained between
  Tool operations;
- only transports advertised during ACP initialization are accepted.

Remote Antnest ACP initially advertises ACP HTTP MCP support only. It does not
advertise stdio MCP, because accepting a client-selected command would execute
an arbitrary program on the Agent ACP Service host. Stage 2 accepts only MCP
`2026-07-28` stateless HTTP sources; an older session-bearing MCP server is
reported as unsupported rather than partially emulated.

Client MCP uses a dedicated untrusted HTTP dialer, separate from the Runtime MCP
client. It permits only configured HTTPS destinations, resolves and validates
the selected address on every dial, rejects loopback, link-local, metadata,
deployment-platform, control-plane, Runtime, and configured private CIDRs,
revalidates every redirect, and never forwards credentials across origins.
Arbitrary enterprise-internal MCP is unavailable in Stage 2; a future
administrator-managed MCP source requires its own explicit design instead of a
hole in the client dialer.

### 7.2 Platform Runtime MCP

Platform Runtime MCP is mandatory Agent infrastructure:

- its logical source is part of Agent configuration;
- its physical endpoint is part of current ExecutionRevision;
- Agent Controller supplies it through internal RPC output;
- Agent ACP Service injects it into every Run;
- ACP clients cannot add, remove, replace, or inspect its physical endpoint.

Runtime MCP is updated only by publishing a new ExecutionRevision. It is never
modified through ACP `mcpServers`.

### 7.3 Effective MCP set

```text
EffectiveMcpSet(run)
  = PlatformRuntimeMcp(run.execution_revision)
  + ClientMcp(run.session.client_mcp_revision)
```

The internal identity is `(source_id, tool_name)`. Platform Runtime tools keep
their canonical names. Every client Tool receives a deterministic qualified
model-facing name derived from source ID, Tool name, and a digest suffix. This
prevents both initial and later `tools/list_changed` updates from shadowing
`read`, `write`, `edit`, or `bash`; no network-dependent collision preflight is
required during Session creation.

### 7.4 Stateless Runtime MCP

Runtime uses MCP `2026-07-28` Streamable HTTP:

- each JSON-RPC request is one HTTP POST;
- protocol-level MCP Sessions are absent;
- there is no modern `initialize` handshake; every request carries required
  protocol version, client information, and capability metadata;
- `MCP-Protocol-Version`, `Mcp-Method`, and applicable `Mcp-Name` headers match
  the request body;
- a request-scoped SSE response may carry progress before its final response;
- notifications receive `202 Accepted`, while requests return JSON or SSE;
- Runtime validates `Origin` when present and never issues or consumes
  `Mcp-Session-Id`;
- closing a request SSE stream signals cancellation, while effect outcome still
  remains unknown until Runtime execution is known terminal.

Agent ACP Service creates a small MCP client for the endpoint in the Run
snapshot. No persistent MCP connection, session migration, or stable proxy is
needed. Every Runtime MCP request carries the snapshot's
`X-Antnest-Expected-Execution-ID`; Runtime rejects a mismatch before Tool
dispatch. This one check prevents a delayed Run request from reaching a
restarted process or a replacement that reused an endpoint. It is not an
authentication credential or rollout generation.

Protocol statelessness does not preserve application state. Runtime PIDs,
background servers, `/tmp`, open descriptors, and Tool-returned handles may be
lost when Runtime changes.

## 8. Run Construction And Environment Change

### 8.1 Snapshot construction

After AcquireRun, Agent ACP Service combines:

1. the complete immutable non-secret Agent execution spec and platform binding
   returned by Agent Controller;
2. the Session's current client MCP revision;
3. its own durable messages and context checkpoint;
4. one resolved Provider credential held only for this Run.

It persists RunExecutionSnapshot before the first model request. Subsequent
Turns and Tool calls read this snapshot instead of resolving mutable current
state again.

### 8.2 Environment-change context fact

For a Session with a previous Run, if current ExecutionRevision differs from
its last executed revision, Agent ACP Service appends one hidden internal
context fact before the next model call:

```text
The Agent configuration or isolated execution environment was rebuilt after
the previous Run. Persisted workspace and conversation state remain available.
Temporary processes, /tmp data, ports, and in-memory handles may no longer
exist. Re-check transient state before relying on it.
```

The fact carries a machine-readable change summary, but no endpoint, secret, or
platform identifier visible to the model. Appending the fact, advancing the
Session revision, and accepting the Run snapshot happen in one Agent ACP
Service transaction, so service restart cannot silently lose the notice.

A Session with no previous admitted Run stores the first Run's revision without
adding a historical reset notice. Creating or resuming a Session during rebuild
therefore has no contradictory baseline.

Client MCP changes are already visible through the Tool set and do not create
this Runtime-reset fact.

## 9. Service Ownership

### 9.1 Agent Controller

Owns:

- Logical Agent, organization/owner binding, desired state, and current
  availability projection;
- mutable Template/ModelProfile heads and their immutable revisions;
- immutable AgentSpecRevision;
- Runtime rebuild workflow and ExecutionRevision publication;
- current Runtime binding;
- Agent-wide Run admission;
- immutable Provider/Model execution profiles, ACP access mapping, and a
  credential-resolution port;
- Agent domain event journal.

Does not own ACP messages, context, Turns, Tool execution, platform SDKs,
Runtime packet traffic, or client MCP configuration.

### 9.2 Runtime Controller

Owns:

- translation of caller-provided RuntimeSpec to Docker or Kubernetes;
- idempotent create, inspect, and delete operations;
- deterministic resource association;
- bounded platform observation and one-shot Runtime readiness verification;
- deployment-platform credentials.

It returns a Runtime MCP endpoint only after the instance is ready. It does not
proxy MCP, choose Agent configuration, serialize Runs, perform rollout, call
Egress, or interpret an observation as an Agent business event.

### 9.3 Agent ACP Service

Owns:

- explicit stable ACP v1 at `/v1/acp`, draft ACP v2 at `/v2/acp`, and one
  access-binding flow;
- ACP Sessions and replayable messages;
- Runs, Turns, context, compression checkpoints, and Tool attempts;
- client MCP lifecycle;
- model invocation and Tool loop;
- RunExecutionSnapshot and environment-change context facts.

It does not create Runtime resources, change Agent configuration, read another
service's database, or cache a Runtime endpoint beyond one Run. Stage 2 runs a
single active Run-executor replica; restart recovery never runs the same
non-terminal Tool loop concurrently in another process.

### 9.4 Antnest Runtime

Owns only isolated MCP Tool execution, filesystem/process containment, status,
and TUN packet transport. It has no Agent lifecycle, ACP Session, Provider,
Model, rollout, or durable control state.

### 9.5 Runtime Egress

Owns Tunnel addresses, network policy, flows, and packet forwarding. Policy
changes are hot control-plane operations and never create an Agent rebuild or
ExecutionRevision.

## 10. Minimal Internal RPC Contracts

The schemas belong under `contracts/` before implementation. Transport choice
must not leak Go or Rust types.

### 10.1 Agent Controller

```text
CreateModelProfile(request_id, organization_id, model, credential)
CreateTemplate(request_id, organization_id, template_spec)
CreateAgent(request_id, organization_id, owner_user_id, template_revision)
RequestAgentRebuild(request_id, agent_id, template_revision)
DisableAgent(request_id, agent_id)
EnableAgent(request_id, agent_id)
GetLifecycleOperation(request_id)
GetAgent(agent_id)
ListAgents(filters)
AcquireRun(request_id, agent_id, principal_id, expected_access_revision, session_id)
FinishRun(admission_id, terminal_class, tool_effect_state, stop_reason, error_class)
ResolveAgentAccess(agent_access_subject)
ResolveCredential(admission_id, credential_ref)
DeleteAgent(request_id, agent_id)
ListAgentEvents(agent_id, after_sequence)
WatchAgentEvents(agent_id, after_sequence)
ListAgentEventsGlobal(after_sequence)
WatchAgentEventsGlobal(after_sequence)
```

The create and rebuild methods return durable operation identity and current
phase. A caller can inspect after timeout using the same `request_id`.
AcquireRun returns the complete immutable non-secret execution input needed by
Agent ACP Service. ResolveCredential is scoped to an active admission and
returns one Run-lifetime secret plus non-secret credential version.

### 10.2 Runtime Controller

```text
InitializeRuntime(request_id, agent_id, configuration)
UpdateRuntime(request_id, agent_id, expected_revision, configuration)
DisableRuntime(request_id, agent_id, expected_revision)
EnableRuntime(request_id, agent_id, expected_revision, configuration)
DeleteRuntime(request_id, agent_id, expected_revision)
InspectRuntime(agent_id)
ListRuntimeObservations(after_sequence)
WatchRuntimeObservations(after_sequence)
```

Create-producing commands succeed only with a ready Runtime status and return
an opaque `runtime_revision`, MCP endpoint, and `runtime_execution_id`.
Mutation requests compare the expected revision; physical generation, digest,
workspace, container, and Pod identity remain private. Disable retains
workspace, Enable creates new compute, and Delete removes both.

### 10.3 Runtime Egress

Stage 2 consumes the Stage 1 control contract without adding Agent lifecycle to
Egress:

```text
GetAgentNetwork(agent_id)
EnsureAgentNetwork(agent_id)
GetAgentPolicyAssignment(agent_id)
AssignAgentPolicy(agent_id, policy_id, revision, expected_resource_version)
ResetAgentFlows(agent_id)
FenceAgentNetwork(agent_id)
ReleaseAgentNetwork(agent_id)
```

Before fencing, rebuild persists the authoritative policy assignment. Runtime
Egress fence keeps the allocation `active` but durably changes its policy to
deny-all and clears packet state. The operation then reads and persists the
authoritative attachment, uses it to assemble the complete Runtime update
configuration, restores the captured policy through assignment CAS, and
requires `EnsureAgentNetwork` to return the same active attachment before
publication.

### 10.4 Agent ACP Service

Its external protocols are stable ACP v1 at `/v1/acp` and ACP v2 Draft at
`/v2/acp`. Agent Controller never calls Agent ACP Service to mutate Runtime or
Agent configuration. A rebuild publishes a new immutable ExecutionRevision;
the next `acquire_run` returns that complete snapshot, and one accepted Run
keeps its original snapshot until terminal. Agent Controller also never calls
Agent ACP Service during admission recovery. Any future trusted read surface
exposes Run facts only and cannot mutate Agent configuration.

## 11. Persistence Boundaries

### 11.1 Agent Controller database

Minimal durable concepts:

```text
agents
model_profiles
model_profile_revisions
provider_credentials
agent_templates
agent_template_revisions
agent_spec_revisions
execution_revisions
agent_access_bindings
agent_lifecycle_operations
run_admissions
agent_events
credential_references
```

### 11.2 Agent ACP Service database

Minimal durable concepts:

```text
acp_sessions
session_messages
context_checkpoints
client_mcp_revisions
runs
tool_attempts
```

The exact table layout follows implementation design; this list defines facts,
not a requirement for one table per noun.

### 11.3 Isolation rules

- Each service owns migrations, role, schema, backup, and retention.
- No cross-service SQL, foreign key, trigger, view, or transaction is allowed.
- Cross-service identifiers are opaque values validated through RPC.
- Shared PostgreSQL infrastructure in Docker does not imply shared data
  ownership.
- Events are appended with the owning aggregate transaction, not by another
  service writing its table.

## 12. Events And Observability

### 12.1 Agent domain events

Agent Controller is the Agent-domain event authority, not a platform-wide
broker. Useful immutable events include:

- `agent_create_requested` and `agent_ready`;
- `agent_rebuild_requested`, `agent_draining`, and `agent_rebuilt`;
- `agent_build_failed`;
- `agent_disable_requested`, `agent_disabled`, and `agent_disable_failed`;
- `run_admission_unresolved`;
- `agent_delete_requested` and `agent_deleted`.

The journal supports ordered List and optional best-effort Watch. Stage 2 does
not require Kafka, generic topics, or consumer groups.

### 12.2 Platform observations

Runtime Controller records normalized Docker/Kubernetes facts. An unexpected
PID or container restart is recorded and can be projected to administrators.
It does not automatically:

- change AgentSpecRevision or ExecutionRevision;
- inject an environment-change message;
- retry an in-flight Tool;
- rebuild the Agent.

An in-flight or later request still carrying the published execution ID is
rejected by the restarted Runtime before Tool dispatch. Stage 2 then requires
an explicit Agent rebuild; it does not silently publish the new process
identity. Future recovery policy may promote selected observations into an
explicit rebuild request.

### 12.3 Tracing

Control RPC and ACP prompt handling propagate W3C trace context. Useful span
attributes include service name, Agent ID, Session ID, Run ID, admission ID,
configuration revision, execution revision, Runtime instance, and result
class. High-cardinality identities are not metric labels.

Required low-cardinality metrics include:

- Agent count by lifecycle state;
- rebuild duration and result by phase;
- Run admission result and wait/rejection class;
- Run duration and terminal class;
- Runtime create/delete/readiness result;
- MCP request duration by source class and Tool name policy;
- unresolved admissions and build failures.

Secrets, prompts, Tool payloads, MCP headers, and full filesystem paths are not
span attributes or default logs.

## 13. Failure Semantics

| Failure                       | Required behavior                                                                        |
| ----------------------------- | ---------------------------------------------------------------------------------------- |
| Invalid target config         | Reject before closing admission                                                          |
| Run active during rebuild     | Keep the operation in `drain`; reject new Runs                                           |
| Drain timeout before mutation | Record failure and return to `READY`; do not infer cancellation                          |
| Old Runtime delete unknown    | Stay unavailable and inspect; do not create a second Runtime                             |
| Egress flow reset unknown     | Stay unavailable; do not create or publish the replacement Runtime                       |
| New Runtime not ready         | Fail the operation; project `UNAVAILABLE` once the old Runtime is absent                 |
| Atomic publication fails      | Remain unavailable; never expose an uncommitted endpoint                                 |
| ACP process crashes           | Session/Run recover from its DB; admission remains fail-closed                           |
| Runtime MCP call times out    | Keep admission unresolved until settled or Runtime is absent; never replay automatically |
| Client MCP unavailable        | Fail that source explicitly without replacing Runtime MCP                                |
| Unexpected Runtime restart    | Record observation; stale execution ID fails closed until explicit rebuild               |
| Egress policy update          | Apply independently; no Agent rebuild                                                    |

## 14. Correctness Invariants

1. `READY` implies exactly one published ExecutionRevision and a Runtime MCP
   endpoint/execution ID pair that passed readiness verification at publication.
2. A non-`READY` Agent cannot acquire a new Run.
3. AcquireRun and lifecycle-operation creation serialize on one Agent row;
   at most one non-terminal Run admission exists per Agent.
4. One Run uses one RunExecutionSnapshot for its complete lifetime.
5. Agent ACP Service never discovers a Runtime endpoint from Docker/Kubernetes.
6. Runtime Controller never chooses which Runtime is active.
7. Client MCP cannot shadow or mutate platform Runtime MCP.
8. An acknowledged rebuild publishes configuration, Runtime binding, execution
   revision, lifecycle state, and event atomically in Agent Controller.
9. Session state and Run history remain valid after Agent rebuild.
10. No timeout is treated as proof that a side effect did or did not occur.
11. No service reads or writes another service's database.
12. Egress policy changes do not change Agent execution revision.
13. At most one non-absent Runtime resource exists for an Agent.
14. Runtime rejects an MCP request whose expected execution ID differs before
    Tool dispatch.
15. A replacement Runtime is not created until the old Runtime is absent and
    Egress has acknowledged flow reset.
16. Cancellation covers Run admission and execution; a late admission response
    for a cancelled Run is closed without starting model or Tool work.
17. Session close/delete and prompt intent creation serialize on the Session
    row, and one Session has at most one non-terminal Run.
18. Losing Agent ACP Service worker ownership aborts startup recovery and local
    execution before another worker may execute recovered work. The stale
    process fail-stops without terminal persistence or admission closure.
19. Agent ACP Service transactions that need both a Session and Run lock the
    Session first and the Run second.

## 15. Delivery Plan

### Stage 2A: Runtime contract and Runtime Controller

1. Remove reverse Work dispatch, MCP proxying, rollout, Egress calls, and Agent
   business state from the prototype.
2. Update the Runtime contract and Rust Runtime together to expose one
   `runtime_execution_id` per PID 1 lifetime and reject a mismatched expected
   execution header before MCP dispatch.
3. Define language-neutral RuntimeSpec, create/inspect/delete, status, endpoint,
   and observation contracts.
4. Implement the Docker adapter and private operation/observation persistence.
5. Prove idempotent creation, readiness, deletion, restart reconstruction,
   stale-request rejection, and private database ownership.

### Stage 2B: Agent Controller

1. Define AgentSpecRevision, ExecutionRevision, lifecycle state, rebuild
   operation, and Run admission contracts.
2. Implement create and explicit rebuild over Runtime Controller and Runtime
   Egress.
3. Implement atomic publication, failure-stage reporting, retry, deletion, and
   Agent domain events.
4. Implement durable child-operation phases and the Egress flow-reset barrier.
5. Prove one-Agent Run serialization, rebuild exclusion, crash recovery, and
   one-non-absent-Runtime invariant.

### Stage 2C: Agent ACP Service

1. Implement transport-level Agent-scoped subject mapping and request
   revalidation plus stable ACP v1 and draft ACP v2 Session persistence,
   resume/load, prompt, cancellation, content, Tool updates, and replay
   behavior.
2. Implement safe HTTP-only client MCP plus a separate mandatory platform
   Runtime MCP client.
3. Persist RunExecutionSnapshot before model execution.
4. Implement context construction, Tool loop, environment-change fact, and
   Run admission completion.
5. Prove service restart recovery without storing authoritative Session state
   in process memory or starting two Run workers.

### Stage 2D: Integrated acceptance

1. Create one Agent through internal RPC.
2. Verify Runtime creation and ACP conversation with Runtime Tool use.
3. Open two Sessions and prove only one Agent Run executes at a time.
4. Rebuild model, Skill, or Runtime configuration and prove new prompts are
   rejected while rebuilding.
5. Resume the old Session and prove the next Run uses the new snapshot and
   receives one hidden environment-change fact.
6. Add and replace client HTTP MCP through ACP without rebuilding the Agent;
   prove the safe dialer cannot reach Runtime or control-plane addresses.
7. Restart Runtime PID 1 and prove stale Run MCP calls fail before Tool dispatch.
8. Break Runtime creation and prove the Agent remains visibly `UNAVAILABLE`.
9. Update Egress policy and prove no Runtime or Agent revision changes.

## 16. Acceptance Evidence

Before Stage 2 is called complete, verification must include:

- pure state-machine tests for every valid and invalid lifecycle transition;
- transaction tests for AcquireRun, FinishRun, and atomic publication;
- race tests for AcquireRun versus rebuild and two concurrent Sessions;
- workflow restart tests after every external rebuild and deletion phase;
- contract tests generated from language-neutral RPC schemas;
- component tests with private PostgreSQL schemas and no cross-service SQL;
- Docker E2E for create, chat, Runtime Tool, rebuild, retry, cancel, and delete;
- ACP conformance tests for Session lifecycle, replay, cancellation, content,
  and client MCP capabilities, plus transport identity mapping and request
  revalidation tests;
- MCP `2026-07-28` tests for headers, POST behavior, SSE response, cancellation,
  and absence of protocol-level Session coupling;
- SSRF tests covering DNS rebinding, redirects, private ranges, metadata
  addresses, and cross-origin credential stripping;
- restart tests for Agent Controller and Agent ACP Service;
- trace continuity assertions across ACP, Agent Controller, Runtime Controller,
  and Runtime MCP;
- architecture checks preventing service implementation imports and shared DB
  access.

## 17. Deferred Decisions

- Automatic rollback to a prior AgentSpecRevision.
- Third-party ACP Agent hot replacement.
- More than one simultaneously executable Runtime per Agent.
- Persistent background process restoration.
- Generic event streaming infrastructure.
- Automatic rebuild after unexpected Runtime restart.
- Active-active Agent ACP Run workers and worker takeover fencing.
- Public OpenAPI and Edge Gateway behavior.
- Kubernetes implementation and zero-downtime deployment policy.

These require observed product need. They must not leak placeholder fields or
branches into Stage 2 contracts.

## 18. Rejected Alternatives

### Stable Runtime MCP proxy

Rejected because it creates a permanent data-path dependency, hides physical
failure, and still cannot preserve Runtime process state.

### Candidate/active Runtime rollout

Rejected because zero-downtime Runtime updates are not a Stage 2 requirement.
Explicit downtime removes dual-resource, route-switch, drain, rollback, and
stale-generation cases.

### Runtime Controller as Tool gateway

Rejected because deployment adaptation and Tool execution are unrelated
responsibilities. Agent ACP Service calls Runtime MCP directly.

### Platform MCP through ACP `mcpServers`

Rejected because the client could then mutate a platform-owned execution
capability and physical endpoint. ACP `mcpServers` remains client-owned input.

### Runtime endpoint embedded in permanent Session state

Rejected because Sessions outlive Runtime. Endpoint selection is one Run's
execution snapshot.

## 19. Protocol References

- ACP v2 authentication model, retained as a future negotiation reference;
  Stage 2 terminates authentication at the trusted transport boundary and does
  not advertise ACP `authMethods`:
  <https://agentclientprotocol.com/protocol/v2/authentication>
- ACP v2 Session setup and `mcpServers`:
  <https://agentclientprotocol.com/protocol/v2/session-setup>
- MCP `2026-07-28` stateless Streamable HTTP:
  <https://github.com/modelcontextprotocol/modelcontextprotocol/blob/main/docs/specification/2026-07-28/basic/transports/streamable-http.mdx>
