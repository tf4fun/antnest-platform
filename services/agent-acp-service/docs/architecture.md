# Agent ACP Service Architecture

This document describes the service's domain model, prompt acceptance, Tool
loop, persistence, recovery, protocol capability matrix and module layout.
Skill-related behavior (Runtime Skill commands, automatic learning, dynamic
Skill sources and discovery tools) is specified in the
[Skill commands](../../../contracts/agent-acp/skill-commands.md) and
[Skill discovery tools](../../../contracts/agent-acp/skill-discovery-tools.md)
contracts and the [Skill learning design](../../../docs/skill-learning-design.md).

Production composition uses [local execution configuration](execution-configuration.md)
published by Controller. Execution publications and persisted Run snapshots
with nonempty legacy `skill_instructions` are rejected. Runtime remains the
source for Skill summaries and on-demand content.

Each published public configuration is deeply frozen and has a private Agent
index. Admission reuses those immutable references through Run snapshot
resolution, without cloning or scanning the organization's Agent list.
Commits for the same Agent remain ordered; a configuration publication waits
for earlier Agent commits and blocks later commits until publication finishes.
The [connection admission contract](../../../contracts/agent-acp/connection-admission.md)
defines the shared HTTP/WebSocket quotas. These quotas remain process-local;
the global database worker lock and single-instance restriction remain with
registered owner mode.

Run admission also reserves one durable slot per `(organization_id, agent_id)`.
The intent transaction reads that scope from its locked Session, and PostgreSQL
enforces uniqueness across all `admitting` and `running` Runs. A composite
foreign key keeps the Run scope tied to the Session. Bridge idempotency and
append-version checks retain priority, followed by `session_busy`; only the
named Agent unique-index conflict becomes `agent_busy`. Failed admission leaves
no intent, message or append advancement. Cancellation requests and worker exit
retain the reservation until a terminal state commits. Terminal `unresolved`
still requires the independent Runtime barrier checks before new effects.
See the [durable admission contract](../../../contracts/agent-acp/run-admission.md).
This persistence invariant alone does not provide leases, stale-owner fencing or
multi-replica recovery; the exclusive worker lock remains in place.

The [Agent ownership contract](../../../contracts/agent-acp/agent-ownership.md)
has a separate storage foundation: `agent_leases` persists one process
incarnation, monotonically increasing decimal epoch and database expiry per
organization/Agent. Acquisition, renewal and release check database time after
locking that row. Released rows retain their epoch. `PostgresKernel.agentTransaction`
requires an existing matching live lease, holds a shared row lock through commit,
and uses PostgreSQL 17's transaction timeout for a bounded database-only callback.
A missed locking lookup cannot be authorized by a later inserted row, and a
COMMIT response reporting ROLLBACK cannot return a successful business result.

When owner settings are enabled and registration completes, production
`AgentGenerations` prepares a fixed authority and component graph per Agent.
Application, settlement, state, commands and source-read routing use that graph;
Session, Run, Permission, Temporary Skill and Learning writers capture its owned
authority. Background dispatch uses a fixed scope. With owner settings disabled,
composition keeps the original legacy path.

The lifecycle component rejects dispatch after loss and joins original work
before release. It single-flights acquisition per scope and retains a retirement
barrier through acquire/renew/initialization, Run completion and release. Unknown
release results keep that scope closed. Monotonic local deadlines count from
request dispatch; expiry and request budgets are rechecked synchronously even
when timer callbacks are delayed. Normal drain keeps renewing until original
work finishes. Local task diagnostics retain only the latest 16 failures; callers
still receive their original operation failures. Production uses a 30-second
lease, 10-second renewal interval and 10-second operation budget, without
configuration settings for these values. Legacy compatibility writer authority
still comes from the held global worker lock; work cancellation uses the entry
signal, and Learning retains and joins original model work.

`AgentApplicationRouter` implements the existing application port against those
prepared graphs. It copies request data before authorization, routes by the trusted
organization/Agent binding and retains each accepted Run's original completion.
Before invocation, missing ownership returns retryable `agent_unavailable`; after
invocation, ownership loss preserves the non-retryable recovery classification and
closes only that Agent. `PromptCoordinator` has a scope-bound loss notification
separate from the global persistence-failure callback; it does not await its own
generation's close. Startup inventory isolates protected owned work and permits
only approved scoped legacy recovery. `loadOwnedAuthority` rechecks sealed
configuration under the fixed fence before use.

The ACK checks every accepting Agent outside configuration publication. Failure
does not withdraw healthy applied configuration, but an organization-wide ACK
does not guarantee that Controller independently marks a healthy new Agent ready.
Predecessor Learning claim/global review-slot recovery, independent Runtime
isolation, cross-owner ACKs and peers, and two-replica integration
remain pending. The global worker lock and
single-instance restriction stay in place.

## Optional Incarnation Bootstrap

The optional owner configuration adds a startup gate before database access or
ordinary listeners. A process first creates a fresh CSPRNG UUIDv4 incarnation
and a 32-byte hexadecimal registration nonce, then opens a separate private
owner listener. Only the verified Runtime Controller workload may call
`POST /internal/acp-owner/incarnation/probe` there. The workspace, control and
health listeners do not serve this route. A probe matches the original local
pending member/incarnation/nonce and echoes Runtime Controller's challenge;
success does not consume that intent. Identity, PostgreSQL, ordinary readiness
and Controller publication are not probe dependencies.

```text
validated optional owner configuration
  -> fresh local incarnation and pending registration nonce
  -> independent Runtime Controller-only probe listener
  -> Runtime Controller registration and validated matching receipt
  -> PostgreSQL migration and readiness check
  -> existing global worker lock
  -> protected-owned inventory and approved scoped legacy recovery
  -> fixed Agent generations and sealed configuration restoration
  -> ordinary control/workspace listeners
```

`OwnerIncarnation` retains one immutable registration tuple for the process.
Unknown outcomes retry that exact tuple and nonce, without recreating the
incarnation or replaying execution. Registration makes at most three attempts,
with 250ms and 500ms delays and a ten-second maximum per attempt. All attempts
share the configured total budget, default 30 seconds and maximum 120 seconds.
HTTP 4xx responses other than 408 and 429 end registration without retry. The
original request, response read and cancellation cleanup actually settle before
another attempt starts; cleanup failure is not permission to retry.

A validated receipt consumes the pending intent. Startup cancellation,
including SIGTERM or total-budget expiry, permanently closes it while joining
the original registration and probe resources. A late receipt cannot reopen the
intent or start database work and ordinary listeners. Request, response and
error payload capture remains disabled for this private wire; nonces and
configured probe addresses are not log content. The
[handoff contract](../../../contracts/agent-acp/owner-handoff.md) defines the
registration boundary, and [operations](operations.md#optional-acp-incarnation-bootstrap)
documents its configuration.

`RuntimeControllerIncarnations.inspect` consumes the registered process's
complete inspection response over the same authenticated fixed origin. It
snapshots the expected registration/member/incarnation before sending one
body-free GET, then validates the closed response shape. Running and stopped
responses must match all three identities. An explicit unknown response only
binds its registration identifier and diagnostic reason; transport errors,
HTTP errors and malformed data never create unknown or stopped facts. A stopped
result retains and freezes both its outer binding and nested receipt. UTC
timestamps are calendar-validated diagnostics and never authorize recovery by
age. The ten-second attempt includes the original response read, cancellation
and cleanup joins, shared with the registration adapter.

`PostgresOwnerRecovery.recoverRun` is the dedicated storage consumer of a complete
stopped inspection. It locks organization, current lease, Session, Run and child
records, validates the predecessor binding, and atomically saves immutable proof
and recovery association with interrupted Tool events, permission cancellation,
terminal facts and Runtime protection. The original owner and snapshot remain
unchanged. An unaccepted intent is rejected without accepting its Prompt; any
execution child on that intent rejects recovery. Retries retain the first audit
and cannot append events or recreate retired barriers. Temporary scope bindings
must still match the original Run, and pending scopes remain protected.

Owned generation preparation calls `listPredecessors` under the current scope
fence, revalidates any complete persisted stop proof against the original Run
binding, and otherwise makes one authenticated inspection outside SQL. Each
`recoverRun` transaction rechecks the fence and target. A proof first accepted
for another Agent is the same permanent process-stop fact; Controller availability
is not a new condition for using it. Scoped legacy recovery does not consume
these receipts. ACP stop proof neither proves remote Runtime effects stopped
nor authorizes replay. Predecessor Learning claims and independent Runtime
isolation remain separate pending consumers.

The dedicated `recoverLearning` storage operation now preserves the original
claim and generation while atomically recording its stop-proof association,
changing only reserved model costs to unknown, and cancelling the review with
`worker_lost`. Its organization/lease/review-admission/task lock order keeps the
global review slot occupied until commit. Unknown charges retain their original
amounts and accounting days. Ordinary writers cannot acquire the old claim.
Uncertain installs receive separate protection for their own persisted Runtime
binding, independent of the source Run. Barrier readers and cleanup consult that
protection; only a valid new-Runtime publication retires it, without settling or
replaying the original request. Startup inventory validates the complete proof
before releasing model-only protection. Generation preparation discovers claimed
running/paused Learning tasks after Run recovery, reuses permanent stop proof,
and invokes this operation before its final startup inventory check. Discovery
uses the claim owner, never the historical source Run owner. This does not enable
multi-replica recovery or establish actual Runtime isolation.

Generation initialization has its own monotonic 10-second admission deadline.
Expiry closes that Agent's ready/dispatch path and permits other Agents to prepare.
The original initializer, inspection body and cancellation remain registered;
retirement and shutdown join them before lease release and shared cleanup. A
late success cannot reopen the generation even if timer delivery is delayed.
Normal drain closes readiness but retains renewal while joining original work.

Bootstrap is optional. Its validated identity now binds production Agent leases,
fenced writers and scoped background work. Without owner settings, startup
retains the legacy path. The global worker lock, single-instance restriction and
independent ownership-loss fail-stop channel remain; connected generations and
scoped recovery do not complete independent Runtime isolation, cross-owner ACKs
and peers, or two-replica integration.

## Mission

Turn one authenticated ACP connection into durable Session work while keeping
Agent lifecycle, Runtime deployment, and identity outside this service.

## Technology Decision

The service uses TypeScript and both official SDK entry points:
`@agentclientprotocol/sdk` for stable ACP v1 and
`@agentclientprotocol/sdk/experimental/v2` for draft ACP v2. Protocol adapters
share one application port and never branch inside Session or Run business
logic. Generating or hand-maintaining either wire model would make protocol
drift an Antnest responsibility. TypeScript is confined to this service
boundary and does not leak into internal RPC schemas.

Each endpoint feeds the matching official SDK surface: the stable package root
for v1 and the batch-capable experimental `WireStream` for v2. ACP success
shapes are not extended outside their standard schema; optional Antnest
extensions such as `antnest.dev/bridge` and `antnest.dev/skill-commands` use
SDK-supported `_meta`.

Both endpoints accept WebSocket. `/v1/acp` also accepts the official SDK's
Streamable HTTP transport; its [contract](http-transport.md) defines transport
ownership and cleanup. `/v1/acp` carries individual stable v1 JSON-RPC messages;
`/v2/acp` carries the v2 `WireStream` over WebSocket, including batches.
The unversioned `/acp` is absent. Version-specific transport code maps wire
requests and updates only; authorization, persistence, Run admission, model
execution, and Tool execution remain shared application behavior.

## Tool Presentation Boundary

The MCP adapter accepts bounded file observations only from successful platform
builtin read/write/edit calls. The domain records an optional path and complete
before/after beside the terminal Tool event; presentation is separate from model
content, raw output and result summaries. PostgreSQL persists these facts in the
existing event payload using adapter-private JSON text, with no extra table or
filesystem reads. Version-specific transports map the same facts to v1 diff
content or v2 changes/optional git patch. Replay does not re-execute tools or the
model. Trust, size bounds and deployment evidence are specified in
[Tool presentation](tool-presentation.md).

## Domain Model

### ConnectionBinding

```text
ConnectionBinding
  connection_id
  organization_id
  principal_id
  agent_id
```

ACP verifies Agent UI workload and Identity-signed CCT before deriving the
identity tuple. Raw identity headers never authenticate the caller. ACP does not
query Controller to establish a connection. Each resource method authorizes
against the current local organization configuration. Access revision is a fact
of the published grant and the accepted Run, not a frozen connection credential.
Revocation cancels affected execution, detaches approval connections and closes
output subscriptions before configuration acknowledgement. New-Run admission
can close while existing access remains valid.

### Session

```text
Session
  session_id
  organization_id
  principal_id
  agent_id
  cwd = /workspace
  state = active | closed | deleted
  title?
  forked_from_session_id?
  client_mcp_revision
  last_execution_revision?
  last_message_sequence
```

A Session survives connections and Agent rebuilds. Every operation checks the
current ConnectionBinding against the stored organization, principal and Agent. Resume may
install only an empty client MCP revision. Nonempty `mcpServers` is rejected
before writing state or replaying messages. Prompt admission also checks the
stored revision after Session ownership, before acquiring a Run slot. A retained
client revision must be cleared by load/resume with `[]`, not silently reused.
The first accepted text prompt supplies a bounded default title.
Session lifecycle and configuration adapters capture the same immutable authority
as the Run repositories through `createOwnedAgentRepositories` or the explicit
legacy factory. Their transaction locks the lease before the Session, rechecks
its durable scope, then validates original ownership on affected Runs before
writing state, cancellation timestamps or configuration events. A successor
cannot cancel its predecessor's Run through Session close/delete. Configuration
revision and its replay event commit atomically. Even missing/deleted delete
retries pass the authority boundary before local Supervisor cancellation; input
identity is captured before asynchronous authorization. Registered owner mode
uses the fixed generation's owned bundle; disabled owner mode keeps the
worker-lock-backed legacy bundle. Scoped legacy compatibility writes retain
that worker-lock authority.
Temporary Skill writers use that same bundle authority. Reservation locks the
actual Session and original Run before inserting a scope; cleanup preflight
checks its complete stored Runtime binding before calling Runtime. The RPC runs
outside the transaction. Its eventual receipt rechecks original ownership and
atomically marks only load-skill attempts stopped, releases the temporary scope
and retires a barrier only if all protected resources have cleared. A lost owner
cannot save that receipt, even after successful remote cleanup. Terminal Runs
and deleted Sessions remain cleanable by their original current owner. Candidate
reads do not authorize cleanup. Generation shutdown joins original work;
predecessor Runtime cleanup and Learning claim recovery remain pending.
Fork creates a new Session with a point-in-time copy of durable context,
records the immutable immediate source Session, but never copies Runs or
admissions and rejects a source Session with active work.

### Run

```text
Run
  run_id
  request_id
  session_id
  state = admitting | running | completed | cancelled | failed | unresolved
  deadline_at
  execution_snapshot?
  terminal facts?
```

ACP's RunSupervisor owns one slot per organization/Agent across Sessions.
The slot spans acceptance, execution and terminal persistence. Cancellation
aborts the same lifetime but cannot release the slot before execution finishes.
A durable cancellation latch covers Session close/delete and active work.

### RunExecutionSnapshot

Session overrides belong to ACP; available organization models, Agent defaults
and credentials are published by Controller. See
[Session configuration](session-configuration.md). The current local directory
resolves an accepted Run into one immutable non-secret snapshot containing its
logical Provider/model, model parameters, authorization and Runtime identity.
It does not contain a Controller admission ticket or fixed credential reference.

Run intent creation captures Session overrides under the Session lock.
The local deadline is fixed at acceptance from `ANTNEST_ACP_RUN_TIMEOUT`.
Startup never replays intent. ProviderClients owns volatile authentication and
injects its current value into each outgoing request; rotation is invisible to
the model loop. Provider disable revokes existing holders and aborts active requests;
credential rotation alone does not cancel a Run. Re-enabling creates a fresh client.

### Message And ToolAttempt

ACP-visible user, agent, and thought messages use stable opaque `messageId`
values and a monotonic Session sequence. Internal environment-change facts are
stored with `visible=false`. ToolAttempt stores status, source identity,
request digest, bounded result summary, and Tool effect state; it does not
store model credentials or raw secret headers.

## Prompt Acceptance

```text
session/prompt
  -> verify Session ownership
  -> reserve organization/Agent execution slot
  -> enter short organization configuration/access boundary
  -> persist Run intent with captured Session overrides
  -> resolve non-secret snapshot and local deadline
  -> transaction:
       persist snapshot
       append environment-change fact when needed
       append accepted user message
       advance Session execution baseline
       state=running
  -> leave configuration boundary
  -> owned executor starts independently of protocol delivery
  -> v1 observes completion; v2 acknowledges then observes durable updates
```

Acceptance returns the pre-submission output cursor, so fast execution cannot
outrun its first observer. A failed/disconnected subscriber does not strand
accepted work. Local output invalidation is a hint backed by the transcript.

Session close/delete and cancellation serialize with Run-intent creation.
If cancellation races a committed acceptance, the owned executor receives its
aborted lifetime and performs terminal cleanup without beginning model/Tool work.
Configuration publication waits only for short local commits, never the model,
Runtime, user approval or complete Run.

## Tool Loop

Provider reasoning stays attached to assistant messages across Tool turns and
stored context reconstruction; see [Model reasoning history](model-reasoning-history.md).

1. Read fresh Runtime information and list platform Runtime MCP
   Tools once for the admitted Run. Managed stdio tools are Runtime-owned.
2. Retain Runtime names and add the ACP-owned `update_plan` tool; reject collisions.
   Client MCP injection remains disabled. Budget Tool schemas together
   with transient Runtime guidance/Skill summaries, the system prompt,
   compression checkpoint, durable messages and labelled Run-start plan snapshot.
   See [Runtime context](runtime-context.md) and [Structured plans](structured-plan.md).
3. Use the logical Provider handle acquired before Runtime setup. The model
   transport, not the Run or Tool loop, receives current volatile authentication.
   It applies the shared destination policy to each request, checks all DNS
   answers and pins the socket with the original TLS/Host identity. Its bounded
   dispatcher lives through streaming body consumption and is destroyed in
   `finally`; it has no service credentials, redirects or environment proxy.
   Foreground, permission-judge and learning calls use this same adapter.
4. Check the complete model-input budget before each model request.
5. Call the model and persist/emit text or thought output. Mixed text and Tool
   calls are retained as one assistant response. Before persistence, derive each
   Tool ID from `(runId, model request index, provider call ID)`. This single ID
   is used by assistant history, Tool results and ACP updates; provider IDs may
   repeat in later requests without colliding in the Session.
   A non-streaming Provider response is read with a 4 MiB body ceiling before
   JSON parsing; the streaming path retains its 4 Mi-character aggregate
   ceiling. Oversized responses fail as `model_invalid_response` before their
   text or Tool calls enter durable Session output.
6. Validate the complete Tool-call batch, including unique call IDs, known
   names, and JSON Schema arguments, before the first Tool effect. If any call
   is invalid, execute none of them and return explicit Tool errors to the
   model for one normal repair turn.
7. Persist the assistant response before dispatch. The local plan tool atomically
   appends its full plan and Tool result under the Run/Session locks, with no
   remote attempt or effect; a committed cancellation rejects that update.
   For each validated remote Tool call,
   persist its in-progress state, invoke the source client once, bound
   retained/model-visible output to 64 KiB with a digest marker, append its
   terminal result, and continue. If cancellation or an unknown Tool outcome
   ends the Run early, close every remaining call as not executed. Recovery
   applies the same rule to calls retained in the assistant response but not
   yet dispatched when the process stopped.
8. Stop on model completion, refusal, output limit, cancellation, context budget, or
   `max_model_requests`. Recheck cancellation after final output persistence,
   before choosing a completed outcome.
9. Persist the exact stop reason and terminal Run facts locally. Release the
   Agent slot after completion; no Controller finish receipt is involved.
   A refusal atomically excludes that Run's messages from future model context
   and invalidates summaries that contain them. Transcript/audit content remains
   intact; forks inherit exclusion flags. Migration 0008 also repairs historical
   refusals and inherited fork messages without excluding the fork's own turns.

Tool calls are not replayed automatically after timeout or process crash.
Runtime MCP calls may leave `tool_effect_state=unknown` after an unconfirmed
transport outcome. Historical Run records can still carry `client_mcp` source
facts; retaining them is not permission to execute new client tools or to
settle those effects through Runtime replacement.

The MCP invocation boundary is the call to the official SDK's `callTool`
method. URL validation, connection, and initialization failures before that
boundary have `tool_effect_state=none`. A received successful Tool response is
`settled`. A received error may declare `none`, `settled`, or `unknown` through
its structured content. An ordinary MCP error with no declaration is a returned
outcome (`settled`), not a transport uncertainty; pass it back to the model.
An explicit `unknown` declaration always remains unknown, even with a malformed
source declaration. A rejected `callTool` promise is also `unknown`, because the adapter
cannot prove whether the server executed the request. Once a Tool is unknown,
the Run becomes `unresolved` before another model request can be issued.
For `cancelled_tool_outcome_unknown`, ACP v1 confirms `stopReason: cancelled`
while retaining these unknown-effect facts and Runtime stopping protection.
Other unresolved outcomes remain errors; draft v2 keeps `_unresolved`.

Session close drains final output and detaches all of that Session's output and
permission subscriptions across connections; delete also detaches them. Pending
output attachments cannot resurrect a detached subscription. Other Sessions on
the transport remain usable, and load/resume may establish a new subscription.

### Session metadata delivery

Session title and last-activity time come from the same PostgreSQL snapshot as
the output cursor and transcript. Every authorized connection observing that
Session receives the current values through standard `session_info_update`,
including initial new/load/resume/fork setup and later persisted changes.
An absent title is sent as `null` to clear a client's previous value. Timestamps
match `session/list`; opening a connection does not itself change activity time.
Metadata is current state, not transcript history or model context. A subscription
suppresses unchanged values and retains that comparison when Prompt observation
replaces its output reader. Fresh connections receive the current state again.
Session authorization, access revocation and close/delete subscription cleanup
also govern metadata delivery; listing a Session alone does not subscribe to it.

## Platform-Owned MCP

### Platform Runtime MCP

- Mandatory and supplied only by the immutable Run snapshot.
- Uses a trusted internal dialer.
- Every call carries `X-Antnest-Expected-Execution-ID`.
- A mismatched execution ID fails before Tool dispatch.
- Reads `antnest://runtime/info` through the same official SDK/fenced endpoint.
- Exposes Runtime-aggregated stdio child tools; never launches children locally.

### Client Input Boundary

ACP keeps the standard `mcpServers` field, but only `[]` is accepted.
HTTP, stdio, SSE and MCP-over-ACP all fail with `client_mcp_not_allowed`.
The application validates before Session writes or replay. The execution
catalog rejects any retained nonempty client revision before tool discovery,
and rejects client-source calls before dispatch. There is no client dialer in
the production composition and no client MCP capability advertisement.

Historical encrypted MCP revisions remain referenced by Session and Run
snapshots. Empty revisions continue to use the existing persistence contract,
which is why `ANTNEST_ACP_CLIENT_MCP_KEY` is still required. The official
MCP client still serves the mandatory Runtime endpoint. Low-level client-network
adapter tests are retained, but that adapter is not wired as a client tool source.

## Persistence

Agent ACP Service owns one PostgreSQL database/schema and migrations for:

```text
acp_sessions
client_mcp_revisions
session_messages
context_checkpoints
runs
tool_attempts
tool_permissions
execution_configurations
owner_stop_receipts
run_owner_recoveries
learning_owner_recoveries
learning_runtime_protections
```

There are no cross-service foreign keys, views, triggers, or SQL queries.
External identifiers are opaque text values. One transaction may update only
this service's records.

Permission decisions precede Tool attempts. A separate approval ledger binds
the exact Run/tool-call/arguments; only a committed allow decision permits Tool
dispatch. Always merges a Session-only rule under Session-then-Run locks, while
the active Run retains its admitted model/mode and uses only its own learned
rules. Fork excludes these rules. Connection registration and user interaction
are ACP application/transport concerns, never Runtime or Controller tables.
See [Tool permissions](tool-permissions.md) for cancellation and restart boundaries.

Permission repositories share the captured Agent authority with Session and Run
writers. They lock the lease, Session and original Run before checking deadlines
or duplicate decisions, and commit an always rule atomically with its decision.
The original cancellation signals and copied request/decision payload survive
lock or approval waits. Global startup cancellation remains legacy-only: it
rejects a selected owned Run and updates only its locked set of pending requests.
Registered owner mode captures the generation in production and cancels abandoned
legacy permissions only within approved scopes. Predecessor Run recovery uses the
dedicated stopped-proof transaction. Independent Runtime isolation,
cross-owner ACKs and peers, and two-replica integration remain pending.

## Module Map

```text
src/domain/               pure state and value rules
src/application/          Session commands, prompt admission, Tool loop
src/ports/                execution configuration, repository, model, MCP, telemetry
src/adapters/postgres/    private migrations and repository
src/adapters/model/       OpenAI-compatible model adapter, destination policy and pinned transport
src/adapters/mcp/         platform Runtime MCP client and network helpers
src/adapters/*.ts         Controller policy, Registry, Skill source and Runtime
                          Skill maintenance/temporary-Skill HTTP clients
src/transport/acp/        scoped official HTTP transport, WebSocket stream and versioned SDK adapters
src/telemetry/            logs, traces, low-cardinality metrics
src/main.ts               composition only
```

Dependencies point inward. Domain/application code never imports PostgreSQL,
HTTP, WebSocket, an SDK transport, or another service implementation.

Observation is installed around HTTP, ACP SDK dispatch and existing adapter
interfaces. `ToolPermissions` returns decisions without a telemetry dependency;
its existing `acp.permission.wait` operation is owned by the permission
decorator, including persistence. Recovery still contains legacy telemetry
counters and is a documented remaining coupling. See [observability](observability.md).

Controller publishes the
[execution configuration contract](../../../contracts/agent-acp/execution-api.md)
to this service. ACP validates and persists the non-secret current projection;
there is no outbound access/admission/credential/finish client. Normal usage
never queries Controller's tables or endpoints.

## Recovery

The control listener exposes `POST /rpc/agent-acp/get-runtime-barrier` only to
the verified Controller workload, without a user caller context. Serving begins
after startup recovery and configuration restoration; readiness also requires
current worker ownership and database availability. The query checks readiness
before its single scoped PostgreSQL read. A successful read distinguishes an
absent organization or Agent (`not_found`) from a conflicting Runtime revision;
failed or unavailable reads never produce a clear `barrier: null` result.

The response projects only the requested organization/Agent, matching Runtime
revision and the durable barrier ID, reason and original Runtime execution ID.
It never copies Run/Tool identifiers, content, endpoints or authority. Reading
does not mutate protection or dispatch work. Repeated reads, publication of the
same binding and ACP restart retain the stored cycle identity. A null receipt
does not prove readiness, idleness or permission to dispatch. Controller owns
the organization policy and recovery Rebuild: `auto` admits the original recovery
without user action, `notify` records a durable notification, and `manual` waits
for an explicit administrator action. Neither of the latter modes automatically
rebuilds. Agent UI projects the safe reason and directs authorized administrators
to Console; ordinary owners must contact an administrator. Replacing the original
Runtime clears only its barrier and never replays the unresolved Tool or Prompt.
See the [recovery E2E profiles](../../../tests/e2e/acp-restart/README.md) for the
separate automatic, manual API and real browser acceptance paths.

Run-event repositories confirm an already committed request before checking
whether the Run or Tool is still running. Confirmation checks the original
Run, event identity, timestamp, visibility, payload and applicable Tool facts;
it does not append another event, charge usage again or reverse later cleanup.
Plan updates require both original receipts. A changed request or an incomplete
receipt is rejected. This persistence contract does not authorize replaying a
model request, Tool dispatch or accepted prompt.

- Selected legacy `admitting` Run: fail it with
  `service_restarted_before_execution`, or preserve an already requested
  cancellation. Do not call Controller or execute its prompt.
- Selected legacy `running` Run after service restart: do not replay model or
  Tool work. An in-progress Tool is closed with unknown effect and makes the Run unresolved;
  calls retained in the assistant response but not yet dispatched are closed
  as not executed. A Run with no unknown Tool effect terminates failed and
  quiescent. Results are persisted locally without Controller notification.
- `completed/cancelled/failed/unresolved`: excluded from startup cleanup and
  left unchanged, even when a legacy admission receipt is absent. Outstanding
  owned effects still protect their Agent through startup inventory.
- Durable Run-event and terminal writes retry at most three times with one
  fixed request identity, payload and timestamp. They never retry a model,
  Tool dispatch or prompt. If acknowledgement remains uncertain, the executor
  retains its Agent slot and original Runtime authority while reconciling only
  that Run. Other Agents remain available; this path never scans live Runs.
- Event failure reaches reconciliation only after model output, Tool progress,
  MCP connection close and temporary Skill cleanup have joined. A point read
  returns an existing terminal outcome unchanged. Otherwise recovery closes
  retained but undispatched calls and preserves unknown dispatched effects,
  then records `persistence_interrupted` as failed or unresolved. Failed
  temporary cleanup retains an unknown Runtime effect and authority pin.
  Read failures or a missing accepted Run keep that Agent isolated, with
  bounded backoff until persistence recovers or worker ownership ends.
- A terminal-write retry preserves the original outcome and finish time;
  reading its committed outcome confirms completion without repeating work.
- An uncertain local acceptance transaction closes the affected generation in
  registered owner mode. Legacy/global failures retain the service-recovery
  path. Startup never retries the prompt; protected owned work still requires
  predecessor stop-proof recovery before reuse.
- An admission failure handed to startup recovery does not emit a speculative ACP
  `idle/_failed` projection. The failing v2 connection is closed; reconnect/replay
  exposes the authoritative durable result when recovery permits it. Legacy
  recovery runs after service replacement; protected owned work is not cleared
  by scoped legacy cleanup.
- Connection loss: does not delete Session state. In-flight work may continue;
  updates are durable and can be replayed after resume. Resume/load attaches the
  new connection to subsequent durable output even if execution began on another
  connection. The v2 initiating connection may close before its first output
  attachment; that does not disable subsequent Session-wide change notifications.
  Initial replay ordering is retained for a live connection, while a closed
  connection only enables durable hints for other authorized subscribers.
  V2 also projects the latest durable Run as `running` or `idle`,
  even when historical replay was not requested; v1 adds no private state update.
- Cancellation: the process-level Run supervisor indexes active work by durable
  organization/Agent identity from acceptance through terminal completion, not by WebSocket
  connection and not only after execution starts. A currently authorized
  reconnect can therefore cancel work started through an older connection.
  The durable cancellation latch prevents a late acceptance commit from
  starting model or Tool work. One AbortSignal reaches model and MCP requests.
  The service emits idle/cancelled only after local executors become quiescent
  or records unresolved if that cannot be proven.

The service permits one active Run worker per service database. Startup acquires a
PostgreSQL session advisory lock on a dedicated connection before recovery and
holds it until shutdown. A second worker fails startup; lock-connection loss
is detected by a same-session heartbeat and immediately closes admission,
clears readiness and cancels startup recovery and local execution. Agent-local
ownership loss still closes only the affected Agent. The global worker lock
remains required, and a stale worker cannot persist a terminal result or start
another effect after losing its authority.

Global ownership loss or the first SIGTERM/SIGINT establishes one absolute
deadline using the configured shutdown timeout. `main` retains the original
startup and one shutdown operation until they actually settle; repeated signals
reuse that operation and do not reset the deadline. Service failure notifications
remain observed during closure, and late errors from original tasks are retained.
Business errors are recorded before telemetry flush. On ownership loss, the
500ms telemetry budget applies only after cleanup and is also bounded by the
remaining overall deadline. Actual deadline expiry forces a non-zero exit;
that path does not establish that original tasks joined successfully. The real PostgreSQL/main regression holds the original startup configuration
read through worker-lock loss and repeated SIGTERM. Releasing the SQL lock
allows cleanup and a non-zero exit; the held-through-deadline branch proves
forced exit and connection removal, not successful SQL completion. See
[`main-worker-loss.postgres.test.ts`](../../../tests/integration/agent-acp-service/e2e/main-worker-loss.postgres.test.ts).
Production background Learning shutdown/isolation remains separate acceptance.

The ownership-loss handler is installed before recovery can make a storage call.
External and durable effects check authority before the call and after either
success or failure, while retaining the original operation and cleanup until
settlement. Cancellation alone never proves a pending runner or SQL operation
has stopped. Context loading and checkpoint persistence use the same fence.
Active-active execution still requires the remaining handoff and two-replica
acceptance, independently of HTTP adapters.

The legacy startup adapters additionally support explicit organization/Agent
selection for abandoned permission cancellation, Run recovery and Learning
recovery. Each selected set retains the original authority checks; owned rows
are rejected before any changes commit. Only omitted scope selects the global
path. Learning recovery serializes scope-specific transactions on the dedicated
worker-lock connection, and every release caller joins the same cleanup promise.
`PostgresAgentStartup` inventories owned Run, permission, Runtime, Temporary and
Learning facts by complete organization/Agent identity. Its fenced recheck reads
again after the organization and lease barriers; it never clears historical
facts. Terminal conditional installs may cover older pending/unknown attempts
only with matching canonical history, receipt and durable result. Reserved or
unknown model calls remain protected. An owned pending task must still be
pristine before first claim; the authority marker cannot bypass that check.
`PostgresExecutionConfiguration.loadOwnedAuthority` uses that same lock order
to authenticate the encrypted configuration on the fenced transaction's own
connection. It captures the fence before waiting and rejects a lease that
expired during the wait; public projection alone is never executable authority.

Registered owner startup now uses this inventory, approved scoped legacy
recovery, fixed Agent components and scoped background dispatch. Owner-disabled
startup keeps the global legacy path. A successful scoped cleanup does not
prove that a previous owned executor has stopped.

Live ACP delivery uses a per-connection ordered output stream, not a second
event journal. A single PostgreSQL statement reads visible messages after a
sequence, the snapshot's maximum sequence, and current Run state. Local event
invalidations trigger reads and are coalesced while delivery is active; there
is no polling timer. Subscribe before catch-up, advance the cursor only after
delivery, and re-read when invalidated during delivery. The existing single
worker per database owns all live invalidations; this is not multi-worker fanout.

Model/Tool execution and terminal persistence never wait for socket delivery.
The scoped Bridge intent observation reads a Run's durable `error_class` with
its terminal receipt. It exposes only that bounded classification, not model
provider messages, so the Node Bridge can show a useful rejection after an
asynchronous Prompt or a browser reload.
Every receipt and embedded recent receipt contains `errorClass`: null outside
failed, cancelled or unknown phases; otherwise null or a 1–128 character
ASCII snake_case code. The vocabulary is open. Invalid stored codes project as
`internal_error`, preserving durable outcome and phase; normalization logs a
bounded classification diagnostic. Known emitted classes and client handling
are listed in the [Bridge contract](../../../contracts/agent-acp/workspace-bridge.md#receipt-failure-classification).

The emitted classifications include:

- Model/provider: `model_unsupported_content`, `model_unavailable`,
  `model_http_error`, `model_invalid_response`, `provider_unavailable`,
  `provider_endpoint_forbidden`, `provider_endpoint_unavailable`.
- Execution/budget: `run_deadline_exceeded`, `run_failed`, `run_setup_failed`,
  `context_budget_exhausted`.
- Tool/recovery: `tool_outcome_unknown`, `cancelled_tool_outcome_unknown`, `persistence_interrupted`,
  `service_restarted_during_run`, `service_restarted_during_tool`,
  `invalid_tool_schema`, `duplicate_tool_call_id`.
- Skill cleanup and normalization: `temporary_skill_cleanup_pending`,
  `internal_error`.

Domain and Tool preflight codes extend this list; well-formed future values
remain readable as generic failures. The normalized observation does not rewrite
the original database classification.
Run setup errors validate their raw `error.code` against the same length and
ASCII pattern before terminal persistence. Missing, non-string or malformed
codes, including OS codes such as `ECONNREFUSED` and SQLSTATE `40001`, persist as
`run_setup_failed`; valid known and future codes remain unchanged. New setup
failures therefore do not repeatedly trigger receipt normalization warnings.
The read-boundary guard remains for legacy or otherwise invalid stored rows.

An online v1 Prompt response separately waits for its preceding notifications;
v2 emits idle only after transcript and local terminal facts are durable. Each
output operation has a 30-second bound. Disconnection, authorization failure,
or stalled delivery closes/detaches the connection; it does not cancel durable
execution. Reconnect/load repairs delivery from the retained transcript.

Model completion accepts an awaited text/thought delta callback as well as the
final typed result. The OpenAI-compatible adapter requests SSE with trailing
usage, decodes it with `eventsource-parser`, and assembles indexed Tool arguments
only for a valid Tool finish reason. JSON completions from compatible endpoints
remain supported without pretending they are incremental. A missing completion
marker, invalid chunk, cancelled reader or oversized response does not trigger
an automatic retry. SSE buffering and aggregate response data are bounded at
4 Mi characters; readers are cancelled/released on every exit path.

`ModelOutput` publishes the first fragment immediately and batches subsequent
fragments for at most 100 ms or 4096 characters (flushing earlier at content-kind
boundaries). Persistence is serial and precedes delivery invalidation. A timed
persistence failure aborts model IO and is rethrown to the existing Run recovery
path. Normal cancellation/failure drains accepted buffered output; loss of worker
authority still forbids further persistence. No per-token audit journal is added.

Each persisted chunk has its own row/sequence, plus an internal `responseId`
shared by the same model response; thoughts use a separate response identity.
Both ACP versions expose stable standard message IDs and chunk notifications
for streamed output, not a new private protocol field. Final text is not sent
twice. Context reconstruction joins those text chunks into one assistant message
and, if applicable, its complete Tool exchange. The combined sequence range keeps
compaction from cutting inside a response. Interrupted output is retained, but
unfinished Tool arguments are never promoted into executable calls.

### Tool Progress

The official MCP client owns progress tokens. The Tool port carries transport-neutral
progress values and messages to a per-call `ToolProgress` accumulator. It publishes
the first preview immediately and coalesces later reports at 100 ms, with at most one
database write in flight. Each Tool has a 32-update/16-KiB-text-per-update preview
budget; truncation is explicit and never cancels the Tool. There is no unbounded
callback promise queue and silent Tools generate no artificial progress.

Progress uses existing `session_messages` and Session sequencing. The repository
requires a running Run and an in-progress attempt but does not change its effect
classification. ACP v1/v2 receive replacement `tool_call_update.content` snapshots
for the same Tool ID. Completion/cancellation/failure drains accepted previews before
the terminal Tool result. Late callbacks cannot reopen the Tool. Persistence failure
aborts MCP IO and follows existing recovery; live publication remains best effort.
Context construction ignores in-progress events and uses only the final Tool result.
Progress payloads are not logs or trace attributes. See [contract and tests](tool-progress.md).

Prompt attachments are validated before Run admission: UTF-8 text blobs are
decoded, supported PDF/audio envelopes remain binary, and malformed/oversized
or unsupported content is rejected rather than injected as Base64 prose.
The native model adapter checks the frozen model's audio/PDF flags, including
on historical input after a Session model change. Typed ModelPort errors retain
their bounded classification in Run finalization, not provider response bodies.
Snapshot recovery retains the same modality flags. See
[multimodal input contract](multimodal-content.md). Image
Tool results remain in durable history. For vision models, the OpenAI adapter
places them in an attributed user image message after the entire Tool batch;
for non-vision models it sends an explicit omission note. Local conversion
errors are not classified as network/provider availability failures.

When local Run persistence can no longer prove its terminal state, registered
owner mode isolates the affected generation; legacy/global failures retain
their service-recovery boundary. The service never removes an in-memory executor
and serves that Agent as though execution had safely finished.

Global ownership loss or the first SIGTERM/SIGINT closes admission immediately
and starts the shared absolute shutdown deadline. The retained shutdown closes
ACP transports and cancels active execution. The optional owner intent closes
permanently and its probe listener joins cleanup. Server, supervisor, worker-lock
and PostgreSQL cleanup are all attempted even when another cleanup operation
fails. Failure notifications and original task errors remain observable through
closure and are recorded before telemetry flush. Repeated signals do not create
another shutdown or extend the deadline; expiry forces a non-zero exit without
claiming successful joins.

In legacy mode, Learning cancellation may finish the review worker before its
original model call settles. The service retains those calls and joins their
transport cleanup after the workers stop, before closing Runtime connections,
releasing the worker lock or ending the database pool. Registered-owner mode
keeps this retention within each Agent generation. An internal transport-close
failure is retained separately from expected cancellation and model business
errors. Shutdown reports it after attempting all shared resource cleanup; a
preceding model failure and known usage are preserved. An Agent's late cleanup
failure does not abort another Agent's generation.

## Connection Identity

Agent UI forwards the unchanged Identity-signed CCT with its own workload
credential. ACP verifies both and derives organization/principal/Agent from
signed claims, then authorizes against the locally applied current snapshot.
Unsigned identity hints and the old opaque subject grant nothing. Identity's
bounded public JWKS comes from its fixed authenticated origin; there is no
per-operation Controller access lookup. ACP advertises no `authMethods` because
authentication completed at the transport boundary. Expired context rejects new
operations without cancelling accepted Runs; #58 owns long-lived renewal.

## Runtime Rebuild Integration

Controller owns Runtime lifecycle and publishes only its confirmed current
binding through execution configuration. ACP fixes the Runtime identity in each
accepted Run; it never changes a running Tool loop's endpoint. Configuration
application is distinct from Runtime readiness or Agent settlement.
`POST /rpc/agent-acp/settle-agent` checks the closed lifecycle operation, waits
outside configuration publication and reports local quiescence plus durable
stopping evidence. New prompts cannot reuse a protected Runtime revision.

Normal live Skill learning does not fence a Runtime. Settlement aborts in-flight learning
without waiting, and an unknown install is resent conditionally on the next
published execution, so lifecycle never reports `runtime_barrier_required`
for learning work. A resend re-checks policy, ownership and the frozen apply
basis but accepts the target Skill already being present, because the
interrupted install may have renamed it; Runtime's conditional install settles
identical bytes as `applied` without a second rename.

A stopped predecessor's claim cannot be resent under its successor. Dedicated
recovery cancels that claim and preserves its uncertain install with separate
protection for the original install binding. A valid replacement publication
retires this protection; cancellation alone does not establish Runtime cleanup.

Learning repositories capture explicit Agent authority through
`createOwnedLearningRepositories`, or the worker-lock signal through the legacy
factory. Every mutation and idempotent receipt verifies the current lease and
the task's original claim, generation and registration/member/incarnation/epoch
before changing model, evidence, candidate, apply, maintenance or change facts.
Claim-bound review and apply reads use the same boundary. The completed source
Run is historical evidence: its owner may differ from the new Learning claim.

Migration 0027 distinguishes legacy and owned pending tasks. Pristine legacy
pending work can be adopted under the current lease; spent budget or existing
claim/effect history forbids adoption. Each owned claim and review attempt keeps
its original execution identity and frozen policy. Pause/resume preserves that
claim and budget. A successor cannot resume a predecessor's claim or write its
late receipts. Global startup recovery locks its selected running tasks, rejects
owned work, and updates only the validated legacy set. Production now connects
fixed generation dispatch and scoped legacy recovery. Legacy compatibility
writes still use global worker-lock authority, while work cancellation uses
the entry signal and Learning retains and joins original model work.
Production component tests hold a real Provider transport close during legacy
and owned shutdown, and expire Agent A's lease while Agent B completes a real
foreground Run. Warm startup also consumes stopped Learning claim recovery before
new foreground work, retaining original costs and history without replay. Actual
Runtime isolation, cross-owner ACKs and peers, and two-replica integration remain pending.
Foreground isolation does not establish another Agent's background claim recovery.

## Workspace Bridge Extension

The [workspace Bridge extension](../../../contracts/agent-acp/workspace-bridge.md)
adds durable prompt intent IDs with Session append compare-and-swap, targeted Run
cancellation, scoped execution/intent observation, and sequenced replay/live
delivery marks. A client opts in through `antnest.dev/bridge` in initialize
`_meta`; standard ACP clients do not negotiate the extension and keep their
existing wire behavior. The internal `GET /rpc/agent-acp/workspace/...` routes
require verified workload and an Agent-scoped signed CCT and repeat
authorization before reading; they are not browser endpoints. ACP remains the
execution and history authority when the Agent UI Node Bridge reconnects.

An authorized, listed Agent with closed admission and the exact snapshot reason
`agent_preparing` rejects new Run/Prompt admission with the
existing retryable catalog error (`-32033`, HTTP 503, retry after 1000 ms).
The Prompt coordinator checks this before allocating an intent or Run. Unknown
Agents and unauthorized principals remain `access_denied`; an absent organization
configuration remains `configuration_not_ready`. Authorization itself still
allows permitted history reads and cancellation while execution is preparing.

The read/watch execution-state projection reports offline/preparing with no
active Session. Existing busy work takes precedence and retains owner/peer
Session privacy; after it settles, the preparing state becomes visible. A new
executable snapshot changes the view to ready, while revocation sanitizes and
terminates the subscription even if access is regranted. Generic unavailability,
Runtime barriers and storage failures retain their existing classifications.
The Controller owns the transactional binding/ACK proof. Cross-service
acceptance checks 100 first Prompts with delayed publication under the
[readiness contract](../../../contracts/agent-controller/readiness.md).

## Resource Identifiers

New Session, Run, message, MCP revision, checkpoint and Tool attempt records
follow the [platform resource ID contract](../../../contracts/resource-identifiers.md).
Random IDs carry their resource kind; fork/recovery IDs use stable namespaced
hashes. Forks retain bulk SQL copying and rewrite message payload references to
the copied IDs. Existing records and externally supplied protocol IDs are opaque
and unchanged. Connection IDs and model Tool-call IDs are not affected.

## ACP Capability Matrix

| Surface               | Implemented                                                                                                                                                                                                                                                                                                                                                                                   | Not implemented                                                                                                                                                           |
| --------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| v1 stable             | `initialize`, `session/new`, `session/load`, `session/list`, `session/resume`, `session/close`, `session/delete`, `session/prompt`, `session/cancel`, `session/set_config_option`, `session/set_mode`, reverse `session/request_permission`, replayable message/thought/Tool/usage/plan updates, command catalog, session-info and config/mode notifications; SDK-experimental `session/fork` | Client filesystem and terminal delegation, authentication, Provider administration, elicitation, NES, document synchronization                                            |
| v1 Antnest extensions | Runtime Skill commands in the command catalog and initialize `_meta["antnest.dev/skill-commands"]`; experimental SDK learning notices for clients that declare `session.notices`; workspace Bridge `_meta["antnest.dev/bridge"]` (including `learningNotices` when negotiated)                                                                                                                | -                                                                                                                                                                         |
| v2 draft              | `initialize`, `session/new`, `session/list`, `session/resume`, `session/close`, `session/delete`, `session/fork`, `session/prompt`, `session/cancel`, `session/set_config_option`, reverse `session/request_permission`, replayable message/thought/Tool/usage/state/session-info/plan updates, built-in command catalog and config notifications                                             | Authentication, Provider administration, message-tunneled MCP, elicitation, NES, document synchronization; Runtime Skill commands and learning notices are not advertised |

The executable coverage matrix is maintained in
[protocol conformance](protocol-conformance.md). Stable ACP v1 requires client
stdio MCP support. Antnest deliberately accepts only `mcpServers: []` on both
ACP versions. Every nonempty list (HTTP, stdio, SSE, MCP-over-ACP) fails
explicitly with `client_mcp_not_allowed`; no client MCP capability is
advertised. Only platform Runtime MCP tools are available. Platform-configured
stdio children are hosted inside Runtime, not on the shared ACP host. See
[Runtime context](runtime-context.md). This restricted profile must not be
described as generic full v1 conformance. Client injection as a whole is
deferred; future administrator opt-in and the client transport are separate
decisions described in [MCP trust and injection boundary](client-mcp-policy.md).

The matrix describes current behavior. Methods are advertised only when their
semantics are implemented. Platform authentication and Provider authority
remain in their owning services; authorized Session options can be exposed
without transferring that authority. Client-owned filesystem/terminal
delegation remains outside the Runtime execution model. The service targets all
applicable stable ACP capabilities, including optional ones; only explicit
architecture incompatibilities and protocol-stability deferrals exclude work.
Unsupported surfaces are not stubbed with false success responses.

## Invariants

1. One Session belongs to one organization, principal and Agent forever.
2. One accepted prompt has one durable Run and one accepted user message.
3. A Run reads one immutable execution snapshot for its entire lifetime.
4. A Provider secret is never durable in this service.
5. A nonempty client MCP list cannot be persisted, discovered or dispatched.
6. No timeout is evidence that a Tool side effect did or did not occur.
7. ACP success payloads contain no Antnest-private fields.
8. No query addresses another service's schema.
9. Session close/delete and Run-intent creation serialize on one Session row.
10. A cancelled admitting Run cannot progress to model or Tool execution.
11. Losing the worker-lock session closes dispatch and signals cancellation to
    recovery and local executors. The original startup and single shutdown are
    retained under one absolute deadline; forced exit at expiry proves no join.
    Learning retains original inference through transport cleanup before shared
    worker-lock and database resources are released.
12. Transactions that need both records lock the Session before the Run; this
    canonical order also applies to cancellation and durable event writes.
13. A Tool-call batch produces no external effect until every call in that
    model response passes preflight validation.
14. Completed Runs retain the model or loop stop reason; unresolved Tool
    effects cannot be mislabeled completed, cancelled, or failed.
15. A retained assistant Tool-call response is followed by one terminal result
    per call before normal termination, or repaired during restart recovery;
    context reconstruction never exposes a partial Tool batch to the next model
    request.

### Verified Caller Identity

The execution tuple uses opaque IDs carried in signed JSON claims, preserving
punctuation and Unicode under the shared CCT grammar. One canonical signed
carrier avoids individual HTTP-field representation restrictions. Duplicate
workload/CCT fields, invalid signatures, scope or expiry are rejected before
protocol/state handling. Local Agent/Session grants and audit administrator role
checks remain separate and mandatory. The Runtime MCP fence header still must
carry its execution ID unchanged before dispatch. PostgreSQL representation
errors fail configuration publication without acknowledging a failed revision.

## Service authentication rollout

The [platform authentication contract](../../../contracts/platform/service-authentication.md)
and this service's [caller catalog](../../../contracts/agent-acp/callers.json) define verified
workload identity and route-specific caller context. The
[ACP authentication contract](../../../contracts/agent-acp/service-authentication.md)
places publication and settlement on a separate Controller listener. Workspace
returns 404 for those paths; state get/watch remain available only to verified
Agent UI plus signed user context. TLS and exact per-receiver credentials are
mandatory before listening. JSON parsing fails before effects on ambiguous media,
duplicate members, malformed UTF-8 or extra documents.

This ACP batch authenticates outgoing Identity, optional Controller policy and
Registry clients. MCP/status, Skill source observation, maintenance and temporary
clients use the RC-issued instance reference privately relayed by Controller
(#30). ACP stages volatile per-instance files before publication, keeps tokens out
of database/Run/audit projections, and retains original accepted authority through
closure until durable settlement or process cleanup. Execution fences and signed
maintenance tickets remain independent checks. See
[execution configuration](execution-configuration.md#runtime-instance-authentication-30-owning-service-admission).
Registry receiver adoption and separate-network deployment wiring remain their
owning batches. Follow the
[rollout ledger](../../../contracts/platform/service-authentication-rollout.json);
final cross-service security E2E runs after all service gates pass.
