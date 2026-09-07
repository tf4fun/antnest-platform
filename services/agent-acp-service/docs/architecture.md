# Agent ACP Service Architecture

> Status: Stage 2 implementation contract<br>
> Updated: 2026-08-31

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

The remote transport is WebSocket. `/v1/acp` carries individual stable v1
JSON-RPC messages; `/v2/acp` carries the v2 `WireStream`, including batches.
The unversioned `/acp` is absent. Version-specific transport code maps wire
requests and updates only; authorization, persistence, Run admission, model
execution, and Tool execution remain shared application behavior.

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
replace the complete client MCP list; omission means an empty list, not “keep
the previous list.” The first accepted text prompt supplies a bounded default
title. Fork creates a new Session with a point-in-time copy of durable context,
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
       expected_access_revision, client_mcp_revision_id)
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

1. Read fresh Runtime information and list mandatory Runtime/optional client MCP
   Tools once for the admitted Run. Managed stdio tools are Runtime-owned.
2. Qualify client Tool names; retain Runtime names. Budget Tool schemas together
   with transient Runtime guidance/Skill summaries, the system prompt,
   compression checkpoint and durable messages. See [Runtime context](runtime-context.md).
3. Resolve the Provider credential for the active admission and hold it only in
   process memory.
4. Check the complete model-input budget before each model request.
5. Call the model and persist/emit text or thought output. Mixed text and Tool
   calls are retained as one assistant response.
6. Validate the complete Tool-call batch, including unique call IDs, known
   names, and JSON Schema arguments, before the first Tool effect. If any call
   is invalid, execute none of them and return explicit Tool errors to the
   model for one normal repair turn.
7. Persist the assistant response before dispatch. For each validated Tool call,
   persist its in-progress state, invoke the source client once, bound
   retained/model-visible output to 64 KiB with a digest marker, append its
   terminal result, and continue. If cancellation or an unknown Tool outcome
   ends the Run early, close every remaining call as not executed. Recovery
   applies the same rule to calls retained in the assistant response but not
   yet dispatched when the process stopped.
8. Stop on model completion, refusal, output limit, cancellation, context budget, or
   `max_model_requests`.
9. Persist the exact stop reason and terminal Run facts before calling `finish_run`; retry
   `finish_run` idempotently after uncertain transport failure.

Tool calls are not replayed automatically after timeout or process crash.
Effect certainty is source-neutral: both Runtime and client MCP calls may leave
`tool_effect_state=unknown` after an unconfirmed transport outcome. The
terminal report also preserves `unknown_effect_source` as `runtime_mcp`,
`client_mcp`, or `unclassified`, so Runtime replacement cannot incorrectly
settle an unrelated client Tool effect.

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

## Two MCP Sources

### Platform Runtime MCP

- Mandatory and supplied only by the immutable Run snapshot.
- Uses a trusted internal dialer.
- Every call carries `X-Antnest-Expected-Execution-ID`.
- A mismatched execution ID fails before Tool dispatch.
- Reads `antnest://runtime/info` through the same official SDK/fenced endpoint.
- Exposes Runtime-aggregated stdio child tools; never launches children locally.

### Client MCP

- Supplied as the complete HTTP MCP list on Session new/resume.
- Uses the official MCP client pinned to protocol `2026-07-28`.
- Only HTTPS is accepted outside tests.
- DNS answers and every redirect are revalidated against blocked networks.
- Headers are encrypted at rest; cross-origin redirects drop credentials.
- Client Tools cannot shadow platform Tools.
- Failure to list one optional client source omits only that source for the
  current Run; Runtime Tools and other client sources remain available.

The platform and untrusted dialers are separate types. A future enterprise MCP
allowlist is an explicit feature, not an exception hidden in the client dialer.

## Persistence

Agent ACP Service owns one PostgreSQL database/schema and migrations for:

```text
acp_sessions
client_mcp_revisions
session_messages
context_checkpoints
runs
tool_attempts
```

There are no cross-service foreign keys, views, triggers, or SQL queries.
External identifiers are opaque text values. One transaction may update only
this service's records.

## Module Map

```text
src/domain/               pure state and value rules
src/application/          Session commands, prompt admission, Tool loop
src/ports/                Agent Controller, repository, model, MCP, telemetry
src/adapters/postgres/    private migrations and repository
src/adapters/controller/  narrow Run admission RPC client
src/adapters/model/       OpenAI-compatible model adapter
src/adapters/mcp/         trusted Runtime and untrusted client MCP clients
src/transport/acp/        shared WebSocket stream plus versioned official SDK adapters
src/telemetry/            logs, traces, low-cardinality metrics
src/main.ts               composition only
```

Dependencies point inward. Domain/application code never imports PostgreSQL,
HTTP, WebSocket, an SDK transport, or another service implementation.

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
  `idle/_failed` projection. The current connection remains at its last durable
  state and reconnect/replay exposes the recovered terminal result.
- Connection loss: does not delete Session state. In-flight work may continue;
  updates are durable and can be replayed after resume. Every resume also
  projects the latest durable Run as `running` or `idle`, even when historical
  replay was not requested.
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

Live ACP notifications are best-effort projections of durable events. A slow
or half-open WebSocket must never delay model execution, Tool completion, Run
terminal persistence, cancellation, or shutdown; reconnect and replay repair
delivery.

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
5. A client MCP source cannot replace or shadow Runtime Tools.
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
