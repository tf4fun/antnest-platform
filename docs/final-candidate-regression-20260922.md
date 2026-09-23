# Final candidate regression

Date: 2026-09-22. Status: regression complete; business and scoped topology pass,
strict Trace admission remains failed. This is a new serial regression of
`898a2be429a79f3d7f3dc4fb11931344be7022ce`, with a formatting-only import change
in `tests/e2e/lifecycle-closeout/loss-flow.mjs`, the ACP Docker/Stage 2 fixture
corrections and shared cleanup corrections below recorded in the private
candidate manifest. Production service behavior has not changed in this batch.

## Scope and evidence rules

The run covers service format/static checks, Go race tests, Node unit/component
tests, the pinned official ACP SDK audit, isolated PostgreSQL contracts, fresh
Linux Rust build gates, and the current Stage 1/2/3, Identity/access, ACP,
lifecycle and Workspace integration entries. ACP's production-image SDK probe
is recorded separately from the platform profiles.

This inventory contains ordinary flows and explicit fault profiles. In particular,
the historical `e2e-acp-restart` name runs eight ACP SIGKILL interruptions; it is
classified as a crash diagnostic, not graceful-restart stability evidence.
Persistence acknowledgement loss and RPC response loss likewise retain their
own fault scope. Their expected error/export limitations do not redefine the
normal-restart acceptance contract.

Commands run serially. Each Docker profile must restore the pre-run container,
volume and network inventory before the next starts. The twelve retained
development containers are recorded separately with their immutable image IDs,
start times, restart counts, mounts and networks. Candidate image IDs must stay
fixed across integration profiles.

Business assertions, Trace topology and strict Trace diagnostics retain separate
results and original exit codes. Previously inspected nonlogical timing findings
remain deferred; new structural errors or unexplained warnings are not waived.
F07 remains deferred. Intentional SIGKILL reconstruction diagnostics retain their
[separate acceptance](runtime-crash-integration-revalidation.md) and are not added
to the normal restart suite. Agent Session automatic continuation and
host/database failure recovery remain outside the selected scope.

Private evidence is under `artifacts/verification/final-regression-20260922/`. It includes the
source manifest and exact patch, commands, original logs, image manifests and
per-profile resource comparisons. Available per-profile business, deployment,
browser and raw Trace artifacts remain in each runner's private directory. Some
older Tool profiles and Stage 3 Session checks retain validator summaries rather
than raw responses; their topology gates pass, but independent raw-response
reinspection is limited to artifacts actually saved. Stage 2 now saves all of
its fetched raw responses as described below.

## Findings retained during this run

- Initial format admission found an import layout in `loss-flow.mjs`; Prettier's
  mechanical correction passed the full format gate without behavior changes.
- The initial SDK audit invocation omitted its required disposable `_audit`
  database and executed no tests. The corrected isolated invocation passed all
  nine audit cases and removed its database container.
- The first Agent UI component run passed 125 cases and failed two usage-panel
  lookups at the default one-second asynchronous wait. Both focused cases, all
  41 cases in their original file order, and a complete 127-case component rerun
  subsequently passed without source or test changes. The original failures are
  retained; their intermittent full-suite timing has not been reproduced or
  presented as a production behavior repair.
- ACP's production-image SDK probe initially timed out waiting for startup. A
  diagnostic repeat reached the close-observer assertion and failed there; a
  further unchanged diagnostic repeat passed. Inspection found no delivery
  barrier between the caller's close response and final close-time metadata on
  the observer's separate connection. The fixture now verifies both peers'
  metadata against persisted title/time before taking its negative-effect
  offsets. It retains the original prohibition on subsequent closed-Session
  updates. PostgreSQL readiness now checks the TCP listener and intended database.
  Two consecutive corrected production-image runs passed all four scenarios and
  cleaned their resources. The original failures remain recorded.
- Stage 2's first run passed all nine business scenarios but its execution oracle
  still expected lowercase database operations, predating the current native
  PostgreSQL driver contract. Six execution checks failed before connection
  inspection, which also left the connection-count assertion unsatisfied. Tests
  first reproduced rejection of current uppercase driver spans and acceptance of
  obsolete lowercase metadata. The corrected oracle requires a matching
  `INSERT`/`UPDATE` CLIENT title/operation and native query metadata under the Run;
  reads, wrappers, absent query metadata and obsolete operation names fail. The
  helper suite passes 55 cases. Stage 2 now saves raw Trace responses privately
  before inspection, including intermediate exports.

  The fresh Stage 2 rerun passes nine business scenarios, 48 audit inspections,
  six execution inspections, two lifecycle inspections and four Gateway
  connection inspections, with zero structural failures. Its 43 strict warning
  checks still fail on the recorded clock-skew category, so the original exit 1
  remains. Its existing ACP SIGKILL scenario is a separate interruption diagnostic
  with `trace_complete=false`, not normal-restart or complete crash-export evidence.

- The Stage 3 base profile passed business and topology checks, but the outer
  resource inventory caught two new anonymous volumes missed by label-only
  cleanup checks. The shell removed owned containers without their anonymous
  volumes before Compose teardown. Docker events directly identify one as the
  test Jaeger's volume; both were created at fixture startup, were empty and had
  no remaining container references. Only these two volumes were removed.
  Red/green tests now model anonymous-volume retention, and both the Stage 3 shell
  and the shared lifecycle/browser cleaner remove anonymous volumes together with
  each verified owned container. Conflicting/foreign ownership remains protected.
  Thirty-three entry/cleanup checks and ten shared-cleanup checks pass. A complete
  Stage 3 rerun again passes business/topology and restores the entire pre-run
  container, volume and network inventory. Strict clock diagnostics retain exit 2.
- Some Jaeger warning strings report a missing parent even after that parent has
  arrived in the final response. The raw-response audit checks the warned IDs and
  actual `CHILD_OF` references separately. Completed Identity/access, ACP Session,
  closeout, Managed MCP and RPC-loss responses contain all such parents, with no
  missing parent references. These stale diagnostic strings remain strict
  failures; they are not evidence of a continuing structural gap. The private
  `trace-diagnostic-audit.json` records each affected trace and raw artifact.
- The ACP interruption profile passes eight recovery windows and records 50
  scoped Trace inspections. Six intentionally killed in-flight traces retain
  30 distinct missing-parent references in total, all explicitly classified
  `intentional_sigkill`. These are actual incomplete exports, distinct from the
  stale Jaeger warnings above. Recovery preserves history and records failed or
  unresolved Runs without automatic replay; ordinary post-recovery flows pass.
  This does not satisfy full crash-Trace completeness or add a normal-restart
  regression failure.
- Structured-plan's first run passed twelve functional scenarios but failed its
  cross-Agent denial assertion before completing acceptance. It reused the
  identity helper's cross-organization message expectation. A new test reproduces
  that mismatch; the helper now requires an explicit `Agent` selector for this
  caller, while its default organization boundary stays unchanged. Both paths
  still require the exact generic message, `-32020`/`session_access_denied`,
  `retryable=false` and no extra error-data fields. Twenty-nine focused checks
  pass after the change. The corrected Docker rerun passes all twelve scenarios,
  twelve execution and 26 replay/denial Trace inspections, including two foreign
  users and four cross-Agent rejections; its full resource inventory is restored.
  Strict clock diagnostics retain exit 2. The original Docker failure is retained.
  The same call-site audit found this mismatch in slash-command, multimodal and
  session-cost isolation fixtures, each reproduced by its first Docker attempt.
  All three now explicitly select the Agent boundary; the Identity cross-
  organization caller keeps the default. Their corrected results are recorded
  separately below. No production authorization behavior changed.
- The next command-profile attempt passed all three transport groups but failed
  while waiting for fixture Agent deletion, before Trace admission. The outer
  aggregate error did not retain its inner cause, and teardown had already removed
  the original service logs. An unchanged diagnostic repeat then passed Agent
  deletion and all 40 request Trace inspections. The original intermittent
  deletion failure remains unexplained; no production repair or timeout increase
  is claimed.

  That repeat's temporary read-only collector raced container removal and
  interrupted final Docker teardown. Its own failure is recorded separately from
  the completed business checks. The coordinator verified ownership, removed
  only that disposable project's remaining resources, and restored exactly twelve
  containers, 271 volumes and fourteen networks, with retained container fields
  and image IDs unchanged. The collector now tolerates vanished objects; the
  final confirmation uses the ordinary runner without that collector. That
  confirmation passes the three transport groups, all 40 request Trace
  inspections, Agent deletion and full resource cleanup; strict timing retains
  exit 2. The earlier deletion failure remains a recorded intermittency.

- Offline restore first passed seven-database/two-volume/three-key recovery,
  exact history replay, restored Tool execution and ten Trace inspections, but
  its intermediate `compose rm -f` detached one anonymous volume before final
  cleanup. The global inventory guard stopped the queue. A test first reproduced
  anonymous-volume retention while preserving named and foreign volumes; the
  intermediate removal now also uses `-v`. Twelve restore checks pass. The one
  new, unreferenced volume was verified empty before removal; all 271 baseline
  volumes and twelve development containers remain unchanged. The corrected
  complete restore rerun passes business, all ten Trace inspections and the full
  resource-inventory comparison; strict clock diagnostics retain exit 2.

## Service and database gates

| Gate                              | Result                                                                                                                  |
| --------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| Shared script tests               | Final rerun: 1,224 passed; five opt-in PostgreSQL cases skipped and covered by the dedicated persistence gate           |
| Format                            | Passed after the import-only correction                                                                                 |
| Go race, five services            | 1,954 passing test/subtest records, 57 passing packages, 254 test skips and three packages without tests; zero failures |
| Go lint and Node lint/type checks | Passed                                                                                                                  |
| Stage 2 helper tests              | Original 51 passed; corrected driver-contract suite passes 55                                                           |
| ACP unit/component                | 961 passed                                                                                                              |
| Official ACP SDK audit            | Nine passed with its dedicated disposable database                                                                      |
| Console                           | 113 unit and 280 component cases passed                                                                                 |
| Agent UI                          | 69 unit cases passed; complete component rerun passed all 127 cases, with original intermittent failures retained above |
| PostgreSQL                        | All five owning-service gates passed; ACP 245 cases; Egress three library plus seven repository cases                   |
| Persistence opt-in                | All 20 cases passed, including the five initially gated cases                                                           |
| Runtime image-reference contracts | Both installed-image and moved-tag checks passed                                                                        |
| Linux Runtime                     | Fresh format/Clippy, 143 unit/contract/component cases, one CLI case and one MCP fixture case passed                    |
| Linux Egress                      | Fresh format/Clippy and 110 test cases passed; ten database-only cases are covered by the separate PostgreSQL gate      |

## Candidate image and development equivalence

All ten image builds completed from the candidate source. A build-only argument
invalidated the Rust validation RUN cache, so its recorded tests actually ran.
No production Dockerfile was changed. Runtime's image ID stayed identical.
The other nine rebuilt image IDs differed only in Compose project/service/version
labels: their filesystem layers, non-label runtime configuration and platform
were identical to the retained images.

The original local tags were restored after this comparison. Integration uses
the exact ten immutable image IDs already deployed, recorded in
`images-candidate.json`; `images-rebuilt.json` and `image-comparison.json` retain
the fresh-build provenance. No service redeployment is needed for these equivalent
artifacts. Final comparison confirms the original twelve container IDs, images,
start times, restart counts, mounts and networks are unchanged: twelve running,
eleven with healthy healthchecks and Jaeger without a configured healthcheck.
The global inventory remains twelve containers, 271 volumes and fourteen
networks. No owned verification process remains.

## Integration matrix

All 32 entries below complete their business and applicable scoped topology
checks. Each final entry restores the complete resource inventory. Counts are
inspections, not necessarily unique Trace IDs. Fault rows retain their narrower
contract; intentional crash export is not complete normal-restart evidence.

The exit column is the original command result: three entries exit 0, Stage 2
and the direct C4 runner exit 1, and the other 27 Make entries exit 2. Nonzero
strict results remain failed; this is not an all-green strict acceptance claim.

| Entry                | Passing scope                                             | Exit | Final log                      |
| -------------------- | --------------------------------------------------------- | ---- | ------------------------------ |
| ACP SDK image probe  | Four scenarios; two corrected runs                        | 0    | `acp-sdk-docker-confirmed.log` |
| Stage 1              | Runtime Tool and network boundaries                       | 0    | `stage1.log`                   |
| Stage 2              | Nine scenarios; 60 scoped Trace inspections               | 1    | `stage2-final.log`             |
| Runtime Controller   | Docker lifecycle/image contracts                          | 0    | `runtime-controller-e2e.log`   |
| Stage 3 base         | 34 Trace inspections                                      | 2    | `stage3-final.log`             |
| Identity core        | Ten Trace inspections                                     | 2    | `identity-core.log`            |
| Identity access      | Three Trace inspections                                   | 2    | `identity-access.log`          |
| Agent access         | 53 requests and five offboarding inspections              | 2    | `agent-access.log`             |
| ACP Session          | 26 rejection/execution inspections                        | 2    | `acp-session.log`              |
| ACP closeout         | 90 requests and four offboarding inspections              | 2    | `acp-closeout.log`             |
| Managed MCP v1       | 14 Trace inspections; expected Tool error                 | 2    | `managed-mcp-v1.log`           |
| Managed MCP v2       | 14 Trace inspections; expected Tool error                 | 2    | `managed-mcp-v2.log`           |
| RPC response loss    | 28 scoped inspections; injected response loss             | 2    | `rpc-response-loss.log`        |
| ACP persistence      | Six fault cases; 32 scoped inspections                    | 2    | `acp-persistence.log`          |
| ACP interruption     | Eight SIGKILL windows; 50 scoped inspections              | 2    | `acp-restart.log`              |
| Tool progress        | Twelve execution inspections                              | 2    | `tool-progress.log`            |
| File observations    | 16 executions and 48 replay inspections                   | 2    | `file-observations.log`        |
| Structured plan      | Twelve executions and 26 replay/denial inspections        | 2    | `structured-plan-final.log`    |
| Tool permissions     | 26 execution and four lifecycle inspections               | 2    | `tool-permissions.log`         |
| Slash commands       | Three transports; 40 inspections                          | 2    | `slash-commands-confirmed.log` |
| Multimodal           | Three transports; 48 inspections                          | 2    | `multimodal-final.log`         |
| Session cost         | 52 model requests; one restart; 156 inspections           | 2    | `session-cost-final.log`       |
| Lifecycle foundation | Nine lifecycle and seven Run inspections                  | 2    | `lifecycle.log`                |
| Lifecycle network    | 20 lifecycle/request/policy inspections                   | 2    | `lifecycle-network.log`        |
| Normal shutdown      | Six lifecycle/request/watch inspections                   | 2    | `lifecycle-shutdown.log`       |
| Runtime health       | Two 60-second samples; three inspections                  | 2    | `lifecycle-health.log`         |
| Offline restore      | Seven databases; two volumes; three keys; ten inspections | 2    | `lifecycle-restore-final.log`  |
| Runtime loss         | 20 lifecycle/request inspections                          | 2    | `lifecycle-loss.log`           |
| Interrupted Update   | Normal restart; same child/target; three inspections      | 2    | `lifecycle-interrupted.log`    |
| Workspace protocol   | 18 lifecycle/request/watch inspections                    | 2    | `workspace.log`                |
| Workspace browser    | Five browser groups; 13 inspections                       | 2    | `workspace-browser.log`        |
| C4 browser           | Eleven browser groups; ten scoped inspections             | 1    | `c4-browser.log`               |

All log names resolve under `artifacts/verification/final-regression-20260922/`. The matrix
manifest records durations and results; the associated queue records retain
commands. C4 raw evidence is under
`artifacts/verification/c4-browser-2026-09-21T19-23-36-299Z/`.

## Completion record

The serial combined regression is complete for this candidate plus the recorded
acceptance-only corrections. No production behavior or deployment changed.
Strict timing, expected rejection/cancellation and intentional crash diagnostics
remain failed under the selected scope; F07 and other previously deferred product
work are not reopened. The initial UI lookup timeouts and one Agent deletion
failure remain recorded intermittencies, with subsequent unchanged runs passing;
they are not claimed fixed. Final format, document-link and source-manifest
checks are recorded in the private evidence directory. This report accompanies
the acceptance-only corrections.
