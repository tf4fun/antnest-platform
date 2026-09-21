# Workspace protocol acceptance migration

Date: 2026-09-21. This batch changes acceptance assets only; it does not change
service implementations, deploy images to the retained development environment,
or retire historical browser assets.

`make e2e-workspace` now uses the current disposable Foundation setup and
installed official ACP SDK. The [migration contract](../scripts/workspace-closeout/protocol-migration-contract.md)
defines current state ownership, execution audits, process evidence and cleanup.
The [automated C4 browser profile](c4-browser-revalidation.md) remains a separate
scope; protocol acceptance does not establish browser recovery or layout.

## Migrated behavior

- Current Provider/Model/Template bootstrap, immutable Runtime image and isolated
  deployment. State snapshot/SSE consume the six-field ACP execution summary,
  configuration hash, active Session and unavailable reason.
- Disconnect a live bash Run, prove that it remains busy, reject a competing
  Session, then cancel it from another SDK connection. The actual process group
  exits and only the initial workspace effect exists. Public audit remains
  unresolved/quiescent/unknown with `cancelled_tool_outcome_unknown` and source
  `runtime_mcp`. Another prompt requires an explicit Runtime barrier.
- Explicit Rebuild replaces the Runtime, retains workspace bytes and leaves the
  unknown Run/events unchanged. It permits new work on the replacement Runtime.
- A second Run completes after its SDK/state observers disconnect. New Session
  load returns exactly one answer with no additional model, Tool or Run.
- A second Rebuild is visible to an open observer, changes configuration hash,
  preserves bytes and supplies environment-change context. The next Run reads
  those bytes and its model spans match the actual new Runtime process/binding.
- Owner deactivation closes the state observer and existing SDK connection with
  policy code 1008; a new upgrade and state read are unauthorized. Source-linked
  automatic Temporal Disable preserves workspace; explicit Delete removes it.

## Original failed runs retained

Private verification logs and retained-environment inventory are under
`.cache/workspace-protocol-migration-20260921/`; raw profile evidence is under
`.cache/lifecycle-workspace/<project>/`. Files include private public-audit
snapshots, model/request metadata, watch observations, deployment and raw traces.

Project `antnest-lifecycle-e3e29bb8` passes the business sequence but fails six of
seventeen initial Trace checks. The failures identify acceptance assumptions:

- Side-effecting Runtime cancellation emits `outcome_unknown`, including the
  actual executor span, rather than the initial oracle's `canceled` expectation.
  Source `execution_actor.rs` explicitly preserves unknown side effects.
- Public Agent summaries redact Runtime process execution ID. The updated probe
  reads `/status` on the actual owned Runtime and binds that ID to model spans.
- The old EventSource probe supplied a synthetic `traceparent` whose parent was
  never recorded. Both watch traces consequently had missing parents. The probe
  now reads `X-Antnest-Trace-Id` from the real Gateway response and sends no
  synthetic parent. Missing-parent checks remain strict.
- Delete after Disable has no published Runtime revision and can still receive
  `runtime_barrier_required` from historical unknown calls. Current Controller
  settlement permits that receipt before fencing/removal for Disable, Rebuild
  and Delete. `not_settled` remains rejected.

Project `antnest-lifecycle-bb7cc172` passes all business assertions and seventeen
of eighteen Trace topologies, including both current watches and automatic
Disable. Its remaining Delete oracle expects a redundant attachment-close PUT.
Current `setKnownNetworkAttachmentState` returns an already-closed validated
attachment after GET. The migrated flow proves public attachment state is closed
before Delete; the explicit Trace branch requires that GET, forbids another PUT,
and still requires committed phases, Runtime deletion, network release and
terminal publication. Both original results and raw traces remain unchanged.

Negative fixtures precede each correction. They retain failures for wrong
request/Run/process identity, malformed or legacy state, unauthorized readiness,
replayed effects, rewritten audit history, missing SQL/parents, unrelated errors,
false cancellation, unobserved stream closure and unsettled lifecycle receipts.

## Final verification

The complete shared script regression passes 1,227 tests out of 1,232, with five
existing PostgreSQL commit-receipt fault cases skipped because their opt-in
database fixture is not configured. No test fails or is cancelled. Workspace
SSE component and current protocol/Trace contract tests are included.

Final Workspace project `antnest-lifecycle-5c5d7aaa` passes all business checks
and all eighteen Trace topologies: four explicit lifecycle commands, eleven
actual SDK requests, two state watches and one source-linked automatic Disable.
There are exactly three Runs (one immutable unknown and two completed), five
model requests and three actual Runtime Tool calls. Both Rebuilds and Delete
also pass exact-request replay checks. Missing parents: zero.

Thirteen strict results remain failed. Fourteen error spans are retained:
five from the deliberately cancelled unknown-effect Run, four from the two
explicit prompt rejections, two from closing the state stream, and three from
revoked Identity access. The Runtime's three unknown-effect errors belong to
the cancelled executor/Tool/operation, not a Runtime Controller probe. Runtime
Controller error spans: zero. Timing warnings remain recorded with clock
adjustment disabled. The runner retains strict exit 2.

Ordinary Foundation project `antnest-lifecycle-1ceaefc5` passes nine lifecycle
operations, two completed Tool Runs, two deliberate prompt denials, normal
Controller restart and all sixteen topologies. It retains twelve strict failures
and seven denial/drain-interruption error spans. Missing parents and Runtime
Controller error spans are zero. Its strict exit remains 2.

The two final projects therefore pass thirty-four topologies, with twenty-five
strict failures retained. No clock, exporter interval or production service was
changed. The initial failed results are not overwritten by this final evidence.

Independent cleanup checks confirm all four projects have zero remaining owned
containers, volumes and networks. The twelve retained development containers
have identical IDs, images, start times, restart counts, mounts and network
membership; all twelve run and the same eleven health checks remain healthy.
No verification child process remains. Format, local-document-link and Git
whitespace checks pass; private evidence directories/files have modes 700/600.
Strict results are not a full deployment pass.

The next asset batch is the older interactive Workspace browser consumer
(`browser-run.mjs`) and its manual/upload/layout evidence. Historical protocol
helpers remain until the outstanding consumers are stable and cleanup is
explicitly undertaken. Automatic reuse of unknown Tool effects, strict timing
maintenance and the historical broad C4 milestone retain their prior boundaries.
