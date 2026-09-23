# Tool Permissions (F06)

Status: F06 implementation, Gateway/Runtime/Jaeger integration and Agent UI
acceptance complete. Final gates are recorded in protocol-conformance.md.

## Ownership And Ordering

The admitted Run freezes the effective Agent/Session authorization policy. Tool
schema validation precedes authorization; authorization precedes creation of a
Runtime Tool attempt. Denied or cancelled requests never reach Runtime. Approval
does not replace live identity checks, Run admission or Runtime isolation.

`session/request_permission` is an Agent-to-Client request, not a user prompt.
v1 uses `toolCall`; v2 uses `title` and `subject: {type: "tool_call", toolCall}`.
Both return a nested `outcome`, selected from the four offered option IDs:
allow once, allow always, reject once and reject always. Unknown responses and
missing handlers fail closed. No invented client capability flag is required.

## Policy

- Auto allows tools; Chat supplies no tools and rejects unexpected tool calls.
- Approve uses exact source/sourceId/tool-name rules, otherwise asks the user.
- Smart Approve first uses those same explicit rules. A platform-provided tool
  with an explicit read-only hint and no conflicting destructive hint may run.
  A Tool without a hint may use the classifier below; everything else asks.
  Annotations and model judgments are hints, not an isolation boundary.
- Once applies only to this Run's exact tool-call ID and captured arguments.
- Always atomically records the answer and merges an exact Tool rule into the
  current Session configuration. It does not change the Agent or other Sessions.
  This Run also uses its newly learned rules on subsequent calls, without
  importing unrelated concurrent model/mode changes into its frozen snapshot.
  Fork copies model/mode selections but removes Session-only Tool rules. The
  rules are not visible model/mode options, so their atomic merge increments the
  configuration CAS revision without emitting a misleading mode-change event.
- Smart Approve judges a platform Tool without a read-only hint only after rules
  and annotations have been considered. It classifies one exact call as strictly
  read-only, never merely low-risk. Arguments are untrusted data, not instructions.
  Explicit negative/conflicting hints are never overridden. Invalid, truncated,
  mismatched or failed judgments ask the user; positive judgments are not cached.
  The judge uses the Run's model and logical Provider client, no tools or conversation history,
  a bounded output and timeout, and the same Run request budget (reserving one
  normal response). Usage is recorded; judgment text is not published to chat.

## Waits, Reconnects And Recovery

Only an authorized connection attached to the same organization, principal,
Agent and Session can answer. The most recently attached connection receives
the request; replies from superseded connections cannot authorize execution.
Live access is checked again before committing an answer. Resuming on a new
connection can reissue a still-pending request with a fresh JSON-RPC ID.

Disconnect does not cancel the Run: it waits for a matching connection within
the existing ACP-owned execution deadline. There is no polling or deadline renewal.
Session cancellation, shutdown or deadline expiry end the wait. The SDK sends
cooperative cancellation; a short cleanup grace period closes a non-responsive
logical connection so it cannot accumulate abandoned request promises.

The service persists exact pending request and decision facts in its own
`tool_permissions` table. Always writes and decisions share one transaction,
locking Session before Run to match existing lifecycle operations. A terminal
Run cannot accept a new approval. Startup recovery cancels abandoned pending
permissions and retains existing non-replay behavior for interrupted Runs.
Reconnecting a client is not the same as resurrecting a Run after process loss.
Approval validity is checked after acquiring both row locks using PostgreSQL
wall-clock time, not transaction-start `now()`, plus the current cancellation
and worker-authority signals. Closing/deleting a Session releases its approval
connection registration without closing unrelated Sessions.

## Correctness Evidence

1. Domain tests: four responses, malformed/unknown outcomes, policy precedence,
   read-only hints and conflicting annotations, exact scoped rules.
2. Application tests: wait before effects, once/always, denial, cancellation,
   deadline, identity revocation, disconnect/reconnect and stale replies.
3. PostgreSQL tests: pending/decision facts, atomic Session rules, no resurrection
   after Run termination, concurrent Session configuration preservation.
4. Wire tests: v1/v2 official schemas and real bidirectional requests with a
   deterministic model and Runtime stub; no external provider is needed.
5. Judge tests: exact arguments, no conversation history or Tool dispatch,
   strict result shape/identity, timeout/cancellation, shared request budget,
   usage persistence failure and no judgment text in chat.
6. Deployed profile: `make e2e-tool-permissions` exercises 26 v1/v2 scenarios
   through Gateway and a real managed-MCP Runtime. Jaeger correlates 26 Runs,
   52 model calls (including four judgments), 16 waits and 16 Runtime calls.
   Model configuration overrides reach admission; two cross-user upgrades fail.
   Denial/cancellation/Chat produces no Runtime call. The model is deterministic,
   so this proves orchestration, not the accuracy of an external model's judgment.
7. Agent UI: approval inbox cancellation/stale-answer tests and configuration
   notification ordering tests; browser acceptance covers allow once, reject once,
   Chat mode, completion unlocking and a 390px mobile approval layout.

Permission wait/decision telemetry carries Run/Session/tool-call identifiers and
bounded decision/reason attributes. Arguments, credentials and tool output are
not copied into OTLP. The model span distinguishes `permission_judge` from
`response`; this observes the classifier request, not Tool/IP packet traffic.
See the reusable [deployment profile](../../../tests/e2e/acp-permissions/README.md).

Reference: local ACP SDK 1.4.0 schemas; Goose `acp/server.rs`,
`permission/permission_inspector.rs` and `agents/tool_execution.rs`.
