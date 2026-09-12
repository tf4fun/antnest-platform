# F04 Deployed Structured Plan Acceptance

Status: deployed integration passed, 2026-09-09. This batch validates deployment,
not new ACP or Runtime behavior. F04 service tests passed separately.

## Workflow

Create users, model profile, template and Agent through Gateway/Console BFF.
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
an empty matching subset is not success. Another user is rejected before access.
All wire updates are validated against the pinned official SDK schemas. No
client MCP injection, external Provider, new browser UI or forced-crash claim.
Check Tool IDs across new Runs in the same Session, not just within one Run.
The mixed scenario requires the remote result before the following plan and its
local result. The model fixture also validates message roles and call-before-
result ordering, not two independently filtered lists. Both protocol versions
have dedicated Tool event shapes: v1 starts with `tool_call`, while v2 identifies
the first `tool_call_update` by its Tool ID.

## Traces And Ownership

Collect execution trace IDs from Gateway connections and model requests, and
replay trace IDs independently. Every Run needs Gateway ancestry, Controller
admission/finish, model calls, PostgreSQL transactions and fresh Runtime info/
catalog spans. Match exact model request IDs and admissions, not aggregate
counts alone. Only the execution phase may have one remote dispatch and its
actual Runtime Tool descendant; local-plan-only Runs must have none. Generic
transaction spans prove the persistence path exists, not a count of plan commits.
Replay/fork traces must exist and have no model or Runtime execution. Plan
content, user input and synthetic credentials must not appear in traces. IP
forwarding is outside trace scope. Use bounded stable-span collection.
This profile's sensitive-content check covers exported Jaeger traces only;
it does not establish absence from every container stdout log or metrics export.

Run all verification serially. Build current production ACP/Runtime images,
then `make test-plan-fixtures` and `make e2e-structured-plan`. Existing other
service images must match source. The parent profile owns one disposable Compose
project with one PostgreSQL instance and service-owned databases; it removes
all its containers, volumes and networks on success or failure, preserving
existing human acceptance instances. Keep only final counts and verdicts here,
not raw events, credentials or trace dumps.

## Final Evidence

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
