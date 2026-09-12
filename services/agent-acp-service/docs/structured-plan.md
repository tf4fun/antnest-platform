# Structured Plans (F04)

Status: service implementation and separate Gateway/Jaeger deployment integration
accepted, 2026-09-09.

## Contract

Follow [ACP v1 Agent Plan](https://agentclientprotocol.com/protocol/v1/agent-plan):
each `plan` notification contains the complete ordered `entries` list, replacing
the previous list. Entries carry content, priority (high/medium/low), and status
(pending/in_progress/completed). An empty list explicitly clears the plan.
No Markdown parsing, inferred progress, automatic completion at Run end, or
experimental incremental plan operations are introduced.
v2 maps the same facts to `plan_update` with an items plan and stable session-local
`planId: "current"`; v1 does not require the experimental plan client capability.

The model receives one ACP-owned `update_plan` tool, distinct from Runtime MCP
tools. It submits a validated complete list, at most 16 entries of 512 Unicode
characters each. These are service resource bounds, not protocol limits. The
tool description asks for plans on multi-step tasks and updates as work evolves;
simple replies need not invent a plan. Runtime name collisions fail catalog
assembly rather than hiding or overriding a tool. No Runtime or Controller API
changes, client MCP injection, planner service or new database table is needed.

## Execution And Storage

The application dispatches the ACP-owned tool locally after normal Tool batch
preflight and Run authority checks. One repository transaction appends the
complete plan and successful model Tool result to `session_messages`, advancing
the existing Session sequence. A local plan mutation has no remote side effect
and creates no `tool_attempts` row. Durable events precede best-effort live
publication. Persistence failure follows the existing recovery path, not a fake
Tool success. A rejected or undispatched call does not replace the current plan.
The existing Run row lock orders cancellation against commit. Cancellation
already recorded under that lock rejects the mutation; a later cancellation
does not undo it. A deterministic event ID bound to Run/Tool call rejects duplicate
commits rather than allowing an old invocation to overwrite a newer plan.

The last committed plan remains on cancellation, model failure or process
restart. The standard plan event participates in existing output/replay/fork
logic and identity checks. It does not auto-reset on each Run. Context loading
reads the latest plan independently of checkpoint boundaries, then includes it
as an assistant-authored Run-start snapshot, not system instructions or a claim
that it is still current after subsequent updates. Later successful `update_plan`
calls supersede that baseline, including `[]`. Compaction budgets and retains
the snapshot separately from old history. No completed-state heuristic is applied.

Plans are model-authored working state, not verified task success or new system
instructions. Their contents are not added to logs, span attributes or metrics;
existing Run and PostgreSQL operation spans cover the local persistence path.
The PostgreSQL event codec stores entries and both argument copies (assistant
toolCalls and tool-call arguments) as escaped JSON text inside the existing
payload. Replay, context and interrupted-call recovery decode them. NUL and lone
surrogates remain exact without leaking a database restriction into PlanEntry.

## Acceptance

1. Schema and domain tests: full replacements, empty clear, valid priorities and
   statuses, invalid entries, bounds, and catalog name collisions.
2. Loop tests: local dispatch never calls Runtime, invalid calls are rejected,
   model-visible Tool results match committed plans, cancellation/authority loss
   do not manufacture a plan or remote unknown effect.
3. Real PostgreSQL and ACP v1/v2: initial/update/clear notifications before final
   reply, SDK validation, atomic rollback, load/resume/fork, application restart,
   next-Run context after compaction, and cross-user/Agent isolation.
4. Serial service tests, PostgreSQL profile, build, repository format/lint and
   independent read-only review. Gateway/Jaeger deployment acceptance is a
   separate integration batch; service tests alone do not close that boundary.
   No new browser UI behavior is introduced by F04.

Reference: Goose `agents/platform_extensions/todo.rs` explicitly persists a full
Todo value and supplies it again via `get_moim`. This inspires the workflow, not
the wire format: the inspected Goose ACP implementation does not emit standard
plan events. Its Markdown storage and ignored cancellation token are not copied.

Read-only implementation review identified unsupported JSONB strings and a stale
plan labelled as current system state; both have failing-then-passing regressions.
Real budget-driven compaction is covered separately from a database checkpoint
test. Recovery tests exercise the actual PostgreSQL interrupted-call algorithm
before/after local commit; they do not claim an OS-process kill/restart E2E.

Final service acceptance: 377 unit/component tests across 46 files and 106
PostgreSQL protocol/integration tests across 14 files passed. The F04 PostgreSQL
file contains 11 cases. Production build, root `make fmt-check` and `make lint`
passed without weakening gates. Both read-only reviewers are closed. The
disposable database and role were removed from the reused PostgreSQL instance;
existing acceptance containers and databases were preserved. That service batch
did not call an external Provider or establish browser/deployment acceptance.

## Deployment Acceptance

The [separate deployment profile](../../../scripts/acp-plan/README.md) passed
twelve v1/v2 scenarios through Gateway using real Controller, PostgreSQL and
Runtime services with a deterministic SSE model. It validates six local plan
commits, two rejected invalid plans, two actual Runtime writes, exact snapshots,
early notifications, replay/fork and six access rejections. Four execution traces
cover twelve Runs; eight independent replay/denial traces have no execution.
Private plan/prompt/credential sentinels are absent from these Jaeger traces;
this is not a claim about every stdout log, metrics export or browser rendering.
All batch-owned deployment resources were removed; no new service API or table
was introduced to obtain this evidence.
