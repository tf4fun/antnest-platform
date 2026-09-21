# Agent Controller graceful Workflow span repair

Date: 2026-09-21. Working-tree candidate based on `6827ddd`, preserving the
preceding uncommitted acceptance migrations. This is the separate Controller
repair requested after the [Foundation migration](lifecycle-foundation-revalidation.md).

The candidate closes the missing-parent defect: **nine lifecycle operations and
all 16 Foundation trace topologies pass, with zero missing parent edges**.
Strict Trace remains failed on ten traces. The candidate has not replaced the
retained development image or deployment, and these changes are not committed.

## Service-owned contract and change

The [Workflow span lifetime contract](../services/agent-controller/docs/workflow-span-lifecycle.md)
was defined before implementation. The production change is confined to Agent
Controller's Temporal adapter and shutdown composition. Official Temporal SDK
versions, propagation, scheduling, retry and business behavior are unchanged.

The SDK `SpanStarter` hook tracks actual recording `RunWorkflow:*` spans.
Normal SDK End removes a span from the set and records
`antnest.temporal.workflow.span_end=workflow_return`, retaining any error status.
After worker Stop and client Close, remaining original spans end once with
`worker_shutdown`, before the existing provider shuts down. The tag describes
local span lifetime, not completion of the durable workflow. Original IDs,
parents, names and SDK timestamps remain unchanged.

Completed spans are removed immediately, nonrecording and non-Workflow spans
are not retained, and concurrent End/shutdown is idempotent. A regression test
also reproduced and closed the window in which an in-flight End could disappear
from the tracker before reaching its span processor. Shutdown now waits for
that End before allowing provider shutdown.

No synthetic parent, raw-trace rewriting, exporter interval change, clock
correction, new persistence model or SIGKILL guarantee is introduced.

## Service gates

All verification ran serially.

- Test-first unit and official SDK propagation contracts pass, including original
  parent identity, normal/error completion, disabled tracing, concurrent End and
  shutdown, and waiting for a blocked span processor.
- Full Controller service regression with `go test -race -p=1` passes; lint
  reports zero issues.
- The real Temporal component starts a held drain, gracefully stops and closes
  its first worker/client, and proves the original parent reaches an in-memory
  OTel exporter before the replacement worker starts. The replacement completes
  the same Workflow/Run. Both original Workflow spans and every parent reference
  are present, with two drain attempts and no duplicate span IDs.
- Final isolated Temporal, PostgreSQL repository and service E2E/component
  regression with the race detector passes **295 tests/subtests**, with no
  skipped integration cases in that run.

The independently built image is `antnest/agent-controller:workflow-span-20260921`,
ID `sha256:22565533975260e6e26db3a693509a8ea7bbc3a8ffdc33a7f2f90a5593050b67`.
The retained `antnest/agent-controller:local` tag was not replaced.

## Consumer and Docker integration

After the service gates, the Foundation consumer gained an explicit graceful
restart contract. It requires both actual Workflow spans, matching Workflow/Run
identity and the same admission parent. Temporal's retried drain must retain the
original durable scheduling parent; later Activities must descend from the
replacement Workflow span. Only the exact canceled settlement exchange and
failed first drain are recognized, and their errors still fail strict Trace.

The canceled attempt reads the lifecycle journal in a committed transaction and
persists the publication acknowledgement. It has not completed its business
phase, so it must not be required to write a phase-completion transaction. The
successful retry still requires its committed phase write and matched ACP
publication/settlement acknowledgement. Negative fixtures reject missing or
rewritten parents, wrong identities/revisions, dropped errors, uncommitted
reads, missing acknowledgement SQL, unexpected mutations and extra retries.

A second deployed attempt exposed an independent acceptance race: Create had
completed before the first Runtime-ready event was appended, so a normal
observation was misattributed to exact-request replay. Normal Create, Enable
and Rebuild now wait for actual readiness before taking the replay baseline.
The deliberate failed-start fixture explicitly selects its failure path. The
full event/resource comparison is retained; events are not filtered or dropped.

Final fixture regression: **877 passed, zero failed, five skipped**. The skipped
cases are the separately gated PostgreSQL commit-receipt-loss profile, not the
Controller integration cases above. Formatting, syntax and documentation links
are checked separately.

Final Docker project: `antnest-lifecycle-4aabc141`, using the immutable candidate
ID through `ANTNEST_E2E_CONTROLLER_IMAGE`. It verifies all 12 services and eight
application image IDs, then passes:

| Evidence | Result |
| --- | --- |
| Lifecycle operations | Nine completed across Create, Rebuild, Disable, Enable and Delete |
| Command replay | Nine terminal replays, one held-Rebuild replay and nine post-restart replays |
| Real execution | Held Bash survives observed exit-zero Controller restart, then completes; post-Rebuild read verifies exact retained effects |
| ACP continuation | Two completed Runs, four model requests, two busy rejections and exact same-Session history replay |
| State and resources | Template revision isolation, two policy CAS changes, workspace retention/deletion and required-MCP startup failure cleanup |
| Durable events | 18 main-Agent events with global-cursor pagination/watch resume; six failed-start Agent events retained |
| Trace topology | Nine lifecycle and seven Session traces pass; zero missing parent edges |
| Rebuild trace | Two original Workflow spans, seven Activity attempts including the interrupted drain and its retry, preserved SQL/RPC ownership |
| Docker absence probes | Eight expected 404 probes, zero Docker probe ERROR spans |

The runner prints `business_and_topology_passed` with `strict_exit: 2`.
**This is not full strict Trace acceptance:** eight traces retain timing warnings,
three error spans describe the canceled first drain/settlement, and four domain
rejection error spans describe the two busy prompts. Ten traces fail the strict
gate in total. No error or warning was converted into success.

The first candidate deployment, `antnest-lifecycle-94a3fcb2`, already exported
both parents but revealed the outdated interrupted-drain SQL assertion. Its raw
trace passed the corrected oracle without modification. The next deployment,
`antnest-lifecycle-dde04575`, exposed the initial readiness/replay race. Their
original failure artifacts remain; only the final full run supplies acceptance.

## Cleanup and remaining scope

All three Foundation projects and the isolated component projects
`antnest-workflow-tests-44188`, `antnest-workflow-tests-44327` and
`antnest-workflow-tests-44543` have no owned containers, networks or volumes.
The first component setup attempt exited before test execution; subsequent
runs initialized the one-shot namespace separately and passed.
Retained IDs, images, health and running states match the 12-container baseline:
one running and eleven stopped. No retained service was started or replaced.

Private service/component logs, image identity and cleanup comparisons are in
`.cache/controller-workflow-span-20260921/`; raw deployment evidence is under
`.cache/lifecycle-foundation/<project>/`. Old failed reports remain historical.

Retained Controller deployment/synchronization is still pending. Network packet
flow, shutdown, health, restore, loss, interrupted-update, older Workspace and
retained/extended Stage 3 consumers remain separate migration batches. No old
shared asset was retired here.
