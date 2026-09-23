# F04 Deployed Structured Plan Acceptance

Current revalidation: 2026-09-17. All 12 business scenarios and 38 independent
request trace topology/privacy checks passed. Strict Trace failed on recorded
timing warnings; the deployment command remains nonzero. See the
[current report](../../../docs/structured-plan-revalidation.md). The original
2026-09-09 results below retain their historical candidate and scope. This
profile changes acceptance fixtures, not production ACP or Runtime behavior.

## Workflow

Create users, a Provider connection and Model, a Template referencing the stable
Model identity, and an Agent using the returned Template revision through
Gateway/Console BFF. Wait for executable readiness before using ACP.
For each ACP version, use a real Session to create a plan, execute one Runtime
write and update the plan, reject an invalid plan, clear it, and start another
Run that must see the empty plan. Fork before clearing; a Run on that fork must
still see the earlier plan. Full entries, ordering, priorities and statuses must
match exactly. A plan is never inferred from reply text.
The replacement changes order, priority and status, removes a step, and keeps
one step unfinished; Run completion must not silently finish that step.

A deterministic SSE model drives tool calls and checks actual arguments/results
and the Run-start context. A bounded test-only response gate holds the final
model reply until the ACP client has received the plan update. Merely finding a
plan after completion is insufficient. The gate is a fixture, not a product API.
The only remote execution is the explicit Runtime write; `update_plan` stays
local. The fixtures cannot write SQL or access Docker.

New connections load/resume and fork the persisted stream through Gateway.
Compare plan and Tool updates, including IDs and order, against the live stream;
an empty matching subset is not success. Another user receives the exact ACP
`access_denied` error with no private updates; a successful authenticated
WebSocket upgrade alone does not grant Agent access.
All wire updates are validated against the pinned official SDK schemas. No
client MCP injection, external Provider, new browser UI or forced-crash claim.
Check Tool IDs across new Runs in the same Session, not just within one Run.
The mixed scenario requires the remote result before the following plan and its
local result. The model fixture also validates message roles and call-before-
result ordering, not two independently filtered lists. Both protocol versions
have dedicated Tool event shapes: v1 starts with `tool_call`, while v2 identifies
the first `tool_call_update` by its Tool ID.

## Traces And Ownership

Collect twelve execution trace IDs from the actual model HTTP requests and
correlate each to its prompt, Agent, Session and Gateway connection link. Match
the HTTP CLIENT through `model.complete` to its owning `agent.run` and Run ID.
Every Run needs committed PostgreSQL persistence with a real driver write and
fresh Runtime info/catalog before model execution. Management calls inside a
Run are forbidden; removed Controller admission/finish APIs are not expected.
Only the execute phase may have one remote write dispatch and its actual Runtime
Tool SERVER descendant; local-plan-only Runs must have none. Generic transaction
spans prove a persistence path, not the number of plan commits.

Collect twenty successful replay/fork and six denial request traces separately.
Repeated loads of the same Session are disambiguated by their actual connection
link. Each trace must match its method and resource identity. None may execute
a Run, model or Runtime call. Denial diagnostics must stay within the matching
rejected ACP request and domain operation; the wire response must carry its
exact access error, without private updates or additional Session data. Plan
content, user input and synthetic credentials must not appear in traces. IP
forwarding is outside trace scope. Use bounded stable-span collection.
This profile's sensitive-content check covers exported Jaeger traces only;
it does not establish absence from every container stdout log or metrics export.

Run all verification serially. Build current production ACP/Runtime images,
then `make test-plan-fixtures` and `make e2e-structured-plan`. Existing other
service images must match source. The parent profile owns one disposable Compose
project with one PostgreSQL instance and service-owned databases. The Plan-only
Compose override ignores local `.env`, removes the host Temporal port and keeps
dynamic IPs separate from fixed Egress/Jaeger addresses. The parent removes
all its containers, volumes and networks on success or failure, preserving
existing human acceptance instances. Keep only final counts and verdicts here,
not raw events, credentials or trace dumps.

## Historical Evidence — 2026-09-09

Twelve scenarios passed across v1/v2 with 22 validated model requests, six local
plan commits, two invalid-plan rejections and exactly two actual Runtime writes.
Each version verified initial/update/clear before the response gate opened,
precise cross-Run snapshots, an independent pre-clear fork, and unchanged replay.
Two foreign-user upgrades and four cross-Agent Session operations were rejected.

Four execution traces cover all twelve Runs; eight independent replay/denial
traces contain lifecycle operations with no model or Runtime execution. Per-Run
preparation, admission and remote-call counts and ancestor relationships passed;
plan/prompt/credential sentinels were absent from those traces. Repeated stable
span sampling is bounded, not a guarantee against arbitrarily late telemetry.

Two independent read-only reviewers are closed. Regression tests reject cross-
Tool event reordering, cross-Run ID reuse and result-before-call model history.
Deployment caught two fixture mistakes: v2 has no initial `tool_call` event, and
cross-Agent access returns the existing `session_access_denied` contract, not
`session_not_found`. Both are corrected, with v2 shape and the reused strict
identity denial validator covered by tests. The final full deployment rerun
passed; earlier partial runs are not counted as acceptance. All three runs'
disposable resources were cleaned, leaving existing human acceptance stacks
unchanged. No production service implementation changed in this batch.

Final gates: `make test-node` passed 701 tests (ACP 377, Console 220, Agent UI 13,
shared acceptance fixtures 91, including 11 F04 fixtures). `make lint` passed
with Go lint zero issues, both Rust Clippy checks and Node lint/type checks;
`make fmt-check` passed. Runtime image build also passed 126 Linux module tests,
one real UID 1000 CLI integration test, Clippy and release build. ACP production
image build passed. No threshold, test scope or baseline was weakened.

### Combined candidate follow-up, 2026-09-22

The combined regression exposed an overly specific reused denial assertion:
cross-Agent requests expected the cross-organization message. The caller now
explicitly selects the `Agent` boundary. The default organization assertion
remains strict; neither path accepts the other message, foreign history,
additional error data, a different error code or a retryable denial. The
test-first reproduction and 29 focused checks are recorded in the
[combined candidate report](../../../docs/final-candidate-regression-20260922.md).
The fresh Docker rerun is recorded there separately from the original failure.
