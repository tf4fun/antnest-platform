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

Gateway supplies the trusted identity tuple after authentication. ACP does not
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

## Module Map

```text
src/domain/               pure state and value rules
src/application/          Session commands, prompt admission, Tool loop
src/ports/                execution configuration, repository, model, MCP, telemetry
src/adapters/postgres/    private migrations and repository
src/adapters/model/       OpenAI-compatible model adapter
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

- `admitting` Run: fail it with `service_restarted_before_execution`, or
  preserve an already requested cancellation. Do not call Controller or execute
  its prompt.
- `running` Run after service restart: do not replay model or Tool work. An
  in-progress Tool is closed with unknown effect and makes the Run unresolved;
  calls retained in the assistant response but not yet dispatched are closed
  as not executed. A Run with no unknown Tool effect terminates failed and
  quiescent. Results are persisted locally without Controller notification.
- `completed/cancelled/failed/unresolved`: excluded from startup cleanup and
  left unchanged, even when a legacy admission receipt is absent.
- A failed local acceptance transaction, durable Run-event write or terminal
  transaction requests process replacement when persistence is uncertain.
  It is not flattened into a normal Run failure: startup must close retained
  but undispatched or ambiguous Tool calls without leaving partial context.
  Startup records interruption, never retries the prompt.
- A failure handed to startup recovery does not emit a speculative ACP
  `idle/_failed` projection. The failing v2 connection is closed; reconnect/replay
  exposes the recovered terminal result after service replacement.
- Connection loss: does not delete Session state. In-flight work may continue;
  updates are durable and can be replayed after resume. Resume/load attaches the
  new connection to subsequent durable output even if execution began on another
  connection. V2 also projects the latest durable Run as `running` or `idle`,
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
is detected by a same-session heartbeat, stops readiness, aborts startup
recovery and local execution, and immediately fail-stops the process for
platform replacement. Worker-ownership loss does not enter graceful shutdown:
the stale worker must not persist a terminal result after
another worker can acquire the lock. The lock-loss handler is installed before
recovery can make a storage call; startup recovery races that failure signal
through an ownership-loss channel that is independent from ordinary service
failures. The same channel preempts startup, recovery, and graceful cleanup;
an earlier database or component error cannot hide lock loss behind a slower
cleanup path. Every external or durable effect is wrapped by one ownership
fence that checks before the call and after either success or failure, and can
interrupt a pending wait. Context loading and checkpoint persistence use the
same fence. A completed effect may be recovered idempotently after replacement,
but the stale worker cannot begin the next transition. Active-active execution requires a durable
per-Run claim design and is not implied by stateless HTTP adapters.

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

The same fail-stop rule applies when local Run persistence can no longer prove
its terminal state. The service never removes an in-memory executor and keeps
serving as though execution had safely finished.

Shutdown first clears readiness, then terminates ACP transports and cancels
active execution. Server, supervisor, worker-lock, and PostgreSQL cleanup are
all attempted even when one cleanup operation fails; an incomplete shutdown
exits non-zero for platform replacement.

## Connection Identity

Gateway supplies a trusted organization/principal/Agent tuple in internal
headers (`X-Antnest-Organization-ID`, `X-Antnest-Principal-ID`,
`X-Antnest-Agent-ID`). It authenticates external users and must strip spoofed
identity headers. ACP authorizes resource methods against the locally applied
current organization snapshot; there is no opaque subject or outbound identity
lookup. It advertises no ACP `authMethods` because authentication completed at
the transport boundary.

## Runtime Rebuild Integration

Controller owns Runtime lifecycle and publishes only its confirmed current
binding through execution configuration. ACP fixes the Runtime identity in each
accepted Run; it never changes a running Tool loop's endpoint. Configuration
application is distinct from Runtime readiness or Agent settlement.
`POST /rpc/agent-acp/settle-agent` checks the closed lifecycle operation, waits
outside configuration publication and reports local quiescence plus durable
stopping evidence. New prompts cannot reuse a protected Runtime revision.

Skill-maintenance barriers are tied to the Runtime execution that produced the
unknown effect. A confirmed replacement with a different execution ID can
accept foreground Runs while the old ledger entry remains unresolved; a
configuration update retaining the same Runtime cannot clear its barrier.

## Workspace Bridge Extension

The [workspace Bridge extension](../../../contracts/agent-acp/workspace-bridge.md)
adds durable prompt intent IDs with Session append compare-and-swap, targeted Run
cancellation, scoped execution/intent observation, and sequenced replay/live
delivery marks. A client opts in through `antnest.dev/bridge` in initialize
`_meta`; standard ACP clients do not negotiate the extension and keep their
existing wire behavior. The internal `GET /rpc/agent-acp/workspace/...` routes
require trusted organization, principal and Agent headers and repeat
authorization before reading; they are not browser endpoints. ACP remains the
execution and history authority when the Agent UI Node Bridge reconnects.

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
11. Losing the worker-lock session aborts recovery and every local executor
    before a replacement worker may take ownership.
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

### Trusted Identity Header Values

The execution tuple uses opaque IDs, not an ACP-owned naming convention.
The HTTP adapter accepts one header-safe value per Organization/Principal/Agent,
up to 200 characters, preserving punctuation such as `+` and `@` exactly.
Missing/duplicate, comma-joined, control-character and padded values are rejected
before protocol/state handling. Protocol connection identity and local resource
authorization remain separate; a well-formed tuple grants no Agent access.

The same adapter check applies to management audit identity headers. Audit role
checks and organization scoping remain in the application service. Configuration,
audit and settlement JSON schemas preserve opaque identifiers without importing
HTTP concerns into the domain. The Runtime MCP adapter rejects a binding whose
execution ID cannot be represented unchanged in its outbound header before any
connection or Tool dispatch. PostgreSQL representation errors fail configuration
application without publishing or acknowledging the failed revision.
