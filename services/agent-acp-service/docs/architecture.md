# Agent ACP Service Architecture

> Status: Stage 2 implementation contract<br>
> Updated: 2026-09-09

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
  agent_access_subject
  principal_id
  agent_id
  access_revision
```

It is immutable for one connection. The opaque Agent-scoped access subject is
resolved before the WebSocket is accepted and re-resolved before ACP Session
management operations. Prompt admission instead relies on Agent Controller
`acquire_run`, which authoritatively validates the same binding and active
Identity membership in one path. Any change to its principal, Agent, access revision, or
prompt capabilities requires Agent Controller to advance `access_revision`;
the old connection then fails closed and must reconnect. The subject is never
supplied by ACP Session parameters and is not a reusable user identity token.

### Session

```text
Session
  session_id
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
current ConnectionBinding against the stored principal and Agent. Resume may
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
  admission_id?
  execution_snapshot?
  terminal facts?
```

`request_id` is generated before Agent Controller admission and is durable.
Only Agent Controller decides cross-Session Agent exclusivity. This service
also forbids a second non-terminal Run in one Session so one conversation
cannot fork its own history. A durable `cancel_requested_at` latch covers the
complete `admitting -> running -> terminal` lifecycle; cancellation is not an
in-memory executor-only operation.

### RunExecutionSnapshot

Session model/mode overrides belong to ACP, while enabled organization models,
Agent defaults and credentials belong to Controller. See
[Session configuration](session-configuration.md). `acp_sessions.configuration`
stores only overrides; `configuration_revision` protects concurrent writes.
The configuration change and a visible ordered Session event commit together;
configuration events never enter LLM context. New/load/resume/fork return fresh
configuration, and fork copies overrides without changing the source Session.

Run intent creation captures `runs.session_configuration` under the Session
lock. Admission recovery uses that captured value, even if a later configuration
write has committed. New Controller admissions must return a validated frozen
configuration; only historical intent replay may omit this newly added field.
No configuration request mutates Runtime or an active Run.

The snapshot is copied from one successful `acquire_run` response and augmented
with the client MCP revision captured in the durable Run intent. It freezes the Runtime MCP
source digest, Agent execution-spec digest, and non-secret Provider credential
version. It is immutable for the complete Tool loop. Credential resolution
must return the admitted version before the first model request. The snapshot
contains Runtime endpoint identity, but never a Provider secret.

### Message And ToolAttempt

ACP-visible user, agent, and thought messages use stable opaque `messageId`
values and a monotonic Session sequence. Internal environment-change facts are
stored with `visible=false`. ToolAttempt stores status, source identity,
request digest, bounded result summary, and Tool effect state; it does not
store model credentials or raw secret headers.

## Prompt Acceptance Transaction

```text
session/prompt
  -> authorize Session against ConnectionBinding
  -> insert durable Run intent(state=admitting, request_id,
       expected_access_revision, client_mcp_revision_id, session_configuration)
  -> Agent Controller acquire_run(same request_id, principal_id,
       expected_access_revision)
  -> transaction:
       store RunExecutionSnapshot
       append environment-change fact when needed
       append accepted user message
       advance Session execution baseline
       state=running
  -> protocol-specific completion:
       v1: run Tool loop, stream persisted updates, return stopReason at terminal state
       v2: return PromptResponse {} before any update, then run Tool loop and emit
           persisted updates through running -> idle state_update
```

If admission fails, the user message is not accepted or persisted. Once either
protocol acknowledges the accepted prompt, the user message is durable. ACP v1
completion is the blocking Prompt response; ACP v2 completion is the later
`idle` `state_update`.

Prompt intent creation, Session close/delete, and cancellation serialize on
the same Session row. Closing or deleting a Session atomically records
cancellation for every non-terminal Run. When cancellation races an uncertain
`acquire_run`, the service settles that request with its original durable
request ID, records any returned admission as cancelled, and closes it without
starting model or Tool work.

## Tool Loop

1. Read fresh Runtime information and list platform Runtime MCP
   Tools once for the admitted Run. Managed stdio tools are Runtime-owned.
2. Retain Runtime names and add the ACP-owned `update_plan` tool; reject collisions.
   Client MCP injection remains disabled. Budget Tool schemas together
   with transient Runtime guidance/Skill summaries, the system prompt,
   compression checkpoint, durable messages and labelled Run-start plan snapshot.
   See [Runtime context](runtime-context.md) and [Structured plans](structured-plan.md).
3. Resolve the Provider credential for the active admission and hold it only in
   process memory.
4. Check the complete model-input budget before each model request.
5. Call the model and persist/emit text or thought output. Mixed text and Tool
   calls are retained as one assistant response. Before persistence, derive each
   Tool ID from `(runId, model request index, provider call ID)`. This single ID
   is used by assistant history, Tool results and ACP updates; provider IDs may
   repeat in later requests without colliding in the Session.
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
9. Persist the exact stop reason and terminal Run facts before calling `finish_run`; retry
   `finish_run` idempotently after uncertain transport failure.

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
snapshots. Empty revisions continue to use the existing persistence contract;
schema consolidation is outside this protocol-verification batch. The official
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
```

There are no cross-service foreign keys, views, triggers, or SQL queries.
External identifiers are opaque text values. One transaction may update only
this service's records.

F06 permission decisions precede Tool attempts. A separate approval ledger binds
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
src/ports/                Agent Controller, repository, model, MCP, telemetry
src/adapters/postgres/    private migrations and repository
src/adapters/controller/  narrow Run admission RPC client
src/adapters/model/       OpenAI-compatible model adapter
src/adapters/mcp/         platform Runtime MCP client and network helpers
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

Agent Controller owns the only cross-service business contract consumed here:
[`../../../contracts/agent-controller/run-api.md`](../../../contracts/agent-controller/run-api.md)
and its revisioned machine-readable catalog
[`../../../contracts/agent-controller/run-contract.json`](../../../contracts/agent-controller/run-contract.json).
This service adapts that contract at its outbound port and must not infer
Controller state from additional endpoints or database reads. Additive optional
responses are compatible; required-field or semantic changes require a
coordinated contract revision.

## Recovery

- `admitting` Run: retry `acquire_run` with the same request ID. A trusted
  Controller rejection terminates the local intent; an unavailable or invalid
  response leaves it recoverable and fails startup.
- `running` Run after service restart: do not replay model or Tool work. An
  in-progress Tool is closed with unknown effect and makes the Run unresolved;
  calls retained in the assistant response but not yet dispatched are closed
  as not executed. A Run with no unknown Tool effect terminates failed and
  quiescent. The exact result is reported idempotently through `finish_run`.
- `completed/cancelled/failed/unresolved`: terminal and immutable except for
  recording successful admission closure.
- An uncertain `acquire_run`, a failed local acceptance transaction after
  admission, a failed durable Run-event write, a failed local terminal
  transaction, or an uncertain `finish_run` is not left stranded behind a
  healthy process. A Run-event write failure is not flattened into an ordinary
  Run failure: the Run remains recoverable so startup can close undispatched or
  ambiguous Tool calls without leaving a partial context batch. The application
  records every fact it can prove, marks the service unavailable, and requests
  process replacement. Startup recovery is then the single owner that retries
  the same durable request IDs. This is deliberately simpler than a second
  in-process workflow scheduler.
- A failure handed to startup recovery does not emit a speculative ACP
  `idle/_failed` projection. The failing v2 connection is closed; reconnect/replay
  exposes the recovered terminal result after service replacement.
- Connection loss: does not delete Session state. In-flight work may continue;
  updates are durable and can be replayed after resume. Resume/load attaches the
  new connection to subsequent durable output even if execution began on another
  connection. V2 also projects the latest durable Run as `running` or `idle`,
  even when historical replay was not requested; v1 adds no private state update.
- Cancellation: the process-level Run supervisor indexes active work by durable
  Session identity from admission through terminal completion, not by WebSocket
  connection and not only after execution starts. A currently authorized
  reconnect can therefore cancel work started through an older connection.
  The durable cancellation latch prevents a late admission response from
  starting model or Tool work. One AbortSignal reaches model and MCP requests.
  The service emits idle/cancelled only after local executors become quiescent
  or records unresolved if that cannot be proven.

Stage 2 permits one active Run worker per service database. Startup acquires a
PostgreSQL session advisory lock on a dedicated connection before recovery and
holds it until shutdown. A second worker fails startup; lock-connection loss
is detected by a same-session heartbeat, stops readiness, aborts startup
recovery and local execution, and immediately fail-stops the process for
platform replacement. Worker-ownership loss does not enter graceful shutdown:
the stale worker must not persist a terminal result or close an admission after
another worker can acquire the lock. The lock-loss handler is installed before
recovery can make an external call; startup recovery races that failure signal
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

Model/Tool execution and admission closure never wait for socket delivery.
An online v1 Prompt response separately waits for its preceding notifications;
v2 emits idle only after transcript and admission closure are durable. Each
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
[F09 input contract and delivery boundaries](multimodal-content.md). Image
Tool results remain in durable history. For vision models, the OpenAI adapter
places them in an attributed user image message after the entire Tool batch;
for non-vision models it sends an explicit omission note. Local conversion
errors are not classified as network/provider availability failures.

The same fail-stop rule applies when local Run persistence can no longer prove
its terminal state. The service never removes an in-memory executor and keeps
serving as though the Agent admission had been closed.

Shutdown first clears readiness, then terminates ACP transports and cancels
active execution. Server, supervisor, worker-lock, and PostgreSQL cleanup are
all attempted even when one cleanup operation fails; an incomplete shutdown
exits non-zero for platform replacement.

## Invariants

1. One Session belongs to one principal and one Agent forever.
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
