# Lifecycle foundation migration revalidation

Date: 2026-09-21. Candidate: working tree based on `6827ddd`, retaining the
preceding uncommitted normal ACP closeout migration. This batch changes
acceptance assets and documentation only. No production service, exporter,
clock configuration or retained deployment was changed.

The migration and business regression are complete. **Foundation acceptance is
not complete:** the graceful-restart Rebuild trace fails topology verification.
The user explicitly selected a separate Agent Controller repair batch after
reviewing that finding. Historical reports and remaining legacy consumers stay
in place.

The subsequent [Controller repair and integration](controller-workflow-span-revalidation.md)
closes this gap in an isolated candidate with all 16 topologies passing. This
report preserves the original failure; strict warnings/errors remain separate.

## Current replacement

`make e2e-lifecycle` now selects the foundation-specific flow and deployment.
Other Lifecycle and Workspace entry points still use their existing flows.
See the [migration contract](../scripts/lifecycle-closeout/migration-contract.md).

- Current Provider creation, stable Model ID and returned Template revisions
  replace retired Model-revision setup. The failed-start Template also uses its
  own returned revision. The Runtime image remains immutable.
- Twelve isolated services include private Temporal. Four allocated host ports
  remain loopback-only; dynamic network ranges exclude reserved addresses.
  The eight application image IDs and actual Runtime image are verified.
- Actual SDK JSON-RPC IDs and connection links identify each Session request.
  Public execution audits use `executionRevision`; private Runtime transport
  fields are deliberately absent from the Console projection.
- Current `agent_busy` rejection replaces retired `agent_rebuilding` expectations.
  Denials must produce no Session updates, Run intent or model/tool execution.
- Lifecycle collection uses current Temporal, committed SQL, publication,
  settlement and Runtime/Egress ancestry. Every operation is inspected, including
  the interleaved Agent. A failed trace stays failed while later operations are
  still collected; interruption immediately stops collection.

## Verification

Test-first checks reproduced the old setup, request observation, tool-name and
public audit assumptions. Negative fixtures reject stale/missing execution
revisions, foreign Agents, unfinished executors and unknown effects. Further
checks prove that a failed trace cannot become a passing result, subsequent
operations remain visible, and abort cancels request lookup and trace fetch.

Final serial local regression: **928 passed, zero failed; five skipped** across
Lifecycle, Workspace, current command, base Stage 3, observability, Managed MCP,
Identity, persistence and legacy closeout fixtures. The skipped tests are the
separate PostgreSQL commit-receipt-loss integration cases; they were not run or
claimed as passing in this migration.

Final Docker project: `antnest-lifecycle-91faae2c`.

| Evidence | Result |
| --- | --- |
| Lifecycle operations | Nine completed: three Create, three Delete, one Rebuild, one Disable and one Enable |
| Exact command replay | Nine terminal replays, one nonterminal Rebuild replay, nine replays after the idle Controller restart |
| Held execution | One real Bash process stays alive with the same PID, Runtime, workspace and single initial append across Controller stop/start |
| Graceful restart | Same Controller container, observed exit code zero, no OOM/error; held prompt remains pending |
| Completed Runs | Two: held Bash and post-Rebuild read, four model requests, exact physical effects and public execution revisions |
| Competing prompts | Two exact `agent_busy` rejections, before and after restart, with no execution |
| Session recovery | Same Session, exact persisted visible history, unchanged audits/model calls on load, new Template guidance and environment-change notice on the next Run |
| Workspace | Rebuild and Disable/Enable retain bytes; business Delete removes compute and volume |
| Network policy | Two CAS transitions, exact replay and stale-version conflicts; disabled attachment stays closed |
| Lifecycle events | 19 main-Agent events, paginated global cursors and resumed watch; six failed-start Agent events retained after deletion/restart |
| Required MCP startup failure | Provisioning operation completes; observed Runtime has no executable binding, logs match the owned Agent/generation and missing MCP, business Delete removes resources before teardown |
| Trace topology | 15 of 16 passed: eight lifecycle and seven Session traces; the interrupted Rebuild lifecycle trace remains failed |
| Strict Trace | Ten failures; warnings, domain rejection errors and restart errors remain visible |

The runner prints `business_passed_trace_failed` and exits **1**. `make` and the
outer coordinator consequently exit **2**. This is not a successful full gate.

## Agent Controller follow-up

The Rebuild trace has two missing parent edges: `StartActivity:admit_lifecycle`
and `StartActivity:lifecycle.drain` reference the same absent old
`RunWorkflow:LifecycleWorkflow` span. Its Activity spans were exported before
the normal Controller stop. The replacement worker completes the same logical
workflow under a different Workflow span ID. That span cannot substitute for
the missing original parent.

The locally pinned Temporal SDK starts the Workflow span when execution enters
its interceptor and finishes it when that execution returns. This matches the
observed loss of an unfinished Workflow span across the worker restart. Waiting
for already-ended spans to export does not close this unfinished parent. The
bounded collector retried for 40 samples; raw evidence remains unchanged.
No SIGKILL or forced-stop scenario is part of this foundation run.

The same trace retains two drain Activity attempts and three restart error
spans: the canceled Controller settlement HTTP call, the failed first drain
Activity and ACP's interrupted settlement stream. The retry succeeds and all
business state settles. Normal request traces separately retain four domain
rejection error spans. Raw evidence also contains eight expected-absence Docker
404 probes with zero Docker probe ERROR spans; nine raw traces carry warnings.

The next service-owned batch must define and verify Workflow span lifetime
across graceful worker shutdown, then run Controller local/contract/component
and Docker gates. Its integration must also represent the actual resumed
Workflow and retried drain attempts; the current single-attempt lifecycle
oracle must not accept them by dropping errors, inventing parent spans or
relaxing ownership. Keep strict warning/error results distinct from topology.
Retained development deployment is a separate subsequent action.

## Cleanup and retained state

Projects `antnest-lifecycle-2ac09b50`, `antnest-lifecycle-1e9a91ca` and
`antnest-lifecycle-91faae2c` were all removed, including owned dynamic Runtime
containers, networks and volumes. The first run exposed the incorrect public
snapshot assertion; the second reproduced the Workflow-parent gap; the third
collected all remaining operations without waiving that failure.

All 12 retained container IDs/images/running states and final health values
match the pre-batch baseline: one running and eleven stopped. An intermediate
single health comparison was transiently unequal; the immediate diagnostic and
final full comparison matched. No retained service was started or modified.

Private deployment snapshots, raw traces, errors and results are under
`.cache/lifecycle-foundation/<project>/`; serial logs, local test results and
retained-state comparisons are under `.cache/lifecycle-foundation-20260921/`.
They contain private/synthetic fixture material and are not committed.

Network packet flow, shutdown, health, restore, loss, interrupted-update,
older Workspace and retained/extended Stage 3 consumers remain separate
migration batches. No shared historical asset was retired here.
