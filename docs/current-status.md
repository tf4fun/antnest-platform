# Current Implementation And Acceptance

The 2026-09-25 Agent UI candidate and its remaining Stage 3 final admission
checks are tracked in the [pre-acceptance checkpoint](stage3-final-preacceptance-20260925.md).

Updated: 2026-09-24. Agent UI now runs as one Node full-stack development
service: Gateway-authenticated HTML, business HTTP/SSE, a server-owned ACP
Bridge and request-scoped React SSR. Service, contract, Chromium and isolated
six-service Docker regressions pass, including an 80-Run fixed load, Bridge and
Gateway restart, identity expiry/revocation and pending permission recovery.
The current [Agent UI refactor plan](../services/agent-ui/docs/fullstack-bridge-refactor.md)
records its evidence and remaining full screen-reader/keyboard review and
capacity work beyond fixed loads; this work does not reopen the existing Stage 3
current-service closeout.

**All project test sources and lasting assets have left
`.cache`; migration and final integration audit are complete.** The earlier directory
migration alone did not prove equivalence. Individual source review, dedicated
checks, archives and deletion records now cover every migration entry. See the
[cache inventory](cache-test-inventory.md) for evidence and historical boundaries.
The [Stage 3 current-service closeout](stage-3-current-services-closeout.md)
accepts the implemented single-node scope with individually reviewed clock
warnings. Original strict Trace failures and the five deferred C4 browser items
remain recorded; planned new services belong to Stage 4.
The [ACP asynchronous timing review](acp-async-timing-review-20260923.md) traces
the sampled browser warnings to four short Gateway-to-ACP boundaries rather
than their warning-bearing descendants. Completion-barrier tests find no early
Run completion or ownership release; forwarding metadata and ambiguous Span
boundaries remain observability follow-up. Gateway forwarding now has a `forward`
phase and `PRODUCER` kind; an isolated Stage 2 Docker run confirmed the four
sampled Gateway spans directly parent ACP receives. Coalesced output-refresh
correlation and the clock warnings remain, and strict Trace verification still
returns nonzero.
The [cache exit checkpoint](cache-source-exit.md) records 0 remaining development scripts,
verified wrapper/manifest/dependency/diagnostic removals and actual isolated
regressions. All ten diagnostic sources have now left cache: six passed 87
checks and historical replay, followed by four with 27 Python/twelve cleanup
contracts and actual isolated SDK, Commands, progress-interruption and Identity
regressions. Strict failures remain recorded; retained resources/images did not
change and no owned test processes remain. All 29 cleanup/environment originals
have also been verified and removed: thirty cleanup contracts, 57 total Python
checks, 29 historical report replays and all 29 real Docker CLI profiles passed.
A real residue correctly failed, the disposable probe was removed, and retained
containers/resources/images stayed unchanged. The replay uses reconstructed
Docker responses; the actual Docker run uses synthetic logs/Traces. Neither
claims a new business deployment acceptance.
Three development originals have subsequently left cache: Runtime/Temporal final
checks and Controller idle restart. Eighteen new contracts and all 75 Python
checks passed, both historical summaries/18 raw Traces replayed, and isolated
Docker checks passed including an old-publication rejection and normal restart.
Two probe containers were removed and retained state stayed unchanged. Temporal's
historical replay lacks a saved latest-restart inspection; fresh cutoff behavior
is proven only by the disposable gate. Controller final checks have also left
cache after preserving original assertions, adding identity/workspace contracts,
passing all 84 Python checks and validating saved report compatibility. Its
disposable Docker/PostgreSQL gate passes two positive and eleven expected-failure
cases, with retained resources unchanged; these synthetic cases are not a new
browser business acceptance. Nine read-only MJS originals have now also left
cache: five Agent-state, three chat-Trace reviews and one rejection-Trace entry.
All 64 combined contracts pass, including 22 actual CLI/local-HTTP cases.
Thirteen saved Agent reports, thirteen chat Traces and one rejection Trace replay
identically, excluding new check timestamps and retaining four strict failures.
No retained service was queried or changed. Both Runtime/Temporal SDK replay
originals have also left cache after 82 combined and seven runner checks. An
isolated PostgreSQL/pinned-SDK gate passes two synthetic success cases, seven
negative cases and both original PGDMP replays. Each historical report matches
with 71 messages and 69 notifications; Runtime strict remains failed, Temporal
remains passed. Local HTTP/WS/Jaeger adapters do not prove a new deployment.
The database fixture was removed and retained resources/images stayed unchanged.
Controller recovery has also left cache after 79 related checks and ten isolated
Docker cases, including original workspace bytes and exact report/Trace replay.
The 284-span historical Trace retains its strict failure. A real tmpfs-shadowing
gap and fixture anonymous-volume leak were corrected; final owned resources were
removed and retained resources/images stayed unchanged. Three ordinary lifecycle
originals have now also left cache: Controller 20260917/20260921 and Temporal
20260921. `lifecycle-contracts-final` passes 118 checks; `lifecycle-docker-final`
passes nine cases, comprising four successes (including three exact historical
report replays) and five expected failures. All fifteen historical lifecycle
strict failures remain recorded. The Docker gate uses owned shell Runtime
containers/volumes and local Gateway/Jaeger fixtures; it does not establish a new
real-service business acceptance. The twelve retained containers, 271 volumes,
fourteen networks and images stayed unchanged. The Runtime-loss lifecycle
original has also been verified, archived and removed. Its
`runtime-loss-contracts-final` gate passes 159 related checks, and
`runtime-loss-docker` passes seven actual Docker cases: two successes including
one exact historical report replay, plus five expected failures. The TERM/exit-7
case rejects before rebuild without SIGKILL. The normal path preserves exit zero,
exited observation, removal, absent observation and rebuild from generation two
to three, with five absences and six checks. Five historical lifecycle strict
failures remain recorded. Shared snapshot preflight binds identity and
publication cutoff and derives scope from Compose without a new caller field.
This gate also uses owned shell Runtime containers/volumes and local
Gateway/Jaeger fixtures, not a new real-service business acceptance. Result and
isolation checks pass; twelve retained containers, 271 volumes, fourteen networks
and images stayed unchanged. The development map now has twenty-five completed
originals, zero pending originals and zero pending formal targets. The overall
ledger records 4,057 transfers and 8,114 rows. No Python deployment originals
remain in cache.

Metadata browser migration is complete and its cache original has been removed.
The driver keeps its two-page metadata/list/reload/history and audio-rejection
assertions, with complete early configuration checks and three exclusive private
outputs. `metadata-related-final` passes 239 related checks;
`metadata-reviewed-contracts` passes 44 focused checks after fixture storage
review. `metadata-browser-final` passes nine real UI/Chromium/local-ACP cases,
including exact historical report compatibility and normal SIGTERM report
preservation. This is not original browser-frame replay or a deployed Provider
acceptance. The fixture uses a fresh durable output root and built UI without
HMR. Retained resources and images stayed unchanged; owned processes were reaped.

The shared storage guard now rejects dangling aliases, and Identity collectors,
three access clients and all ten Foundation profiles validate evidence before
external effects. The 335-check `storage-identity-foundation-final` gate passes,
including blocked-effect CLI cases and valid-path controls. Snapshot updates
remain supported for ordinary private files. This is entry/collector validation,
not a new business deployment. Go crash storage now passes six tests and nineteen
subtests, including early TMPDIR traversal rejection and guarded fixture paths.
The four original Runtime crash boundaries also pass with dedicated PostgreSQL
and Docker resources; generation, effect counts, workspace and terminal replay
assertions remain. Retained resources and all image tags are unchanged. Evidence
is in `crash-storage-reviewed-contracts` and `crash-storage-reviewed-docker`.
No cached deployment originals remain.

Runtime deployment migration subsequently passed `runtime-deployment-python-final`
(95 support tests and 18 stateful four-mode entry tests) and all five cases in
`runtime-deployment-docker-final`. Its cache source is hash-archived and removed.
The driver binds effective Compose/full IDs, protects baseline and backup files,
propagates workspace errors and recovers known containers after failed mutation
or normal interruption while retaining failure. The Docker gate uses owned shell
services and PostgreSQL; global `after` correctly rejects the stopped retained
containers, while the component model proves its full positive path. All retained
resources and image references remained unchanged. At that checkpoint two Controller
and one Temporal deployment source remained in cache; no retained-service deployment was performed.

Controller 20260921 deployment migration is now verified and its cache original
has been removed. The Python gate passes 95 support and 30 integration tests;
12 focused Controller entry tests pass after snapshot-oracle extraction. Six
actual Docker cases cover all four modes, three database archives, bound Runtime
recovery, row-preservation failures, candidate rollback and recovery after old
Controller removal before creation. Cleanup preserves all retained resources and
image tags. Exact historical safe-snapshot/report fields remain compatible;
the pre-recovery `after` snapshot is an expected failure, and the stopped full
inspect is not promoted into a healthy baseline. The historical strict failure
stays recorded. Evidence is in `controller-deployment-docker-first` and
`controller-deployment-history`. The corresponding Runtime missing-container
recovery window is now verified in the follow-up below.

Controller 20260917 is now verified, archived and removed. The final complete gate
passes 96 support and 38 integration tests; nine actual Docker cases prove both
service orders, exact final business assertions and target-only failure recovery.
Six Docker cases and historical compatibility also pass again for the extracted
shared 20260921 driver. Saved 0917 snapshots/report fields match, retaining the
browser Trace failure and five lifecycle strict failures. One earlier observer
process-group PermissionError remains recorded; no descendants remained, and
all sixteen observer checks plus the full gate passed afterward. Retained
resources and image references are unchanged. At that checkpoint only Temporal
remained in cache. No retained service deployment was performed.

Temporal deployment is now verified, archived and removed. All 96 support and
50 integration tests pass, followed by eight actual Docker cases and historical
baseline/deployment/archive compatibility. The original five modes, four backups
and dependency order remain; recovery pins old images and old probes where the
new readiness script is unavailable. Whole-workspace bytes and find/hash failures
are checked. Global after still rejects stopped retained containers; the complete
component model proves its positive. Historical earlier restart failure and saved
resume/restart results are preserved without a fabricated latest inspect. The
owned candidate image and all fixture resources are removed. Cache originals
are now zero. Runtime recovery subsequently passed 22 focused flow tests,
96 support/54 integration tests and six real Docker cases (`runtime-missing-python`,
`runtime-missing-docker`). Confirmed absence, unchanged Compose and all other
baseline IDs/names authorize only the old image recreation; unknown replacements
and failed queries reject. Original deployment failure is retained. Final storage
and shared regression audit pass: `make test-node` records 3,364 passed with five
existing PostgreSQL opt-in skips, the cache scan passes, and all retained
containers/volumes/networks and 44 image references match. No test processes remain.

The [repository test-layout migration](test-layout-migration.md) established the
main layout: service unit tests remain within services, integration and deployed
tests live under root `tests/integration/` and `tests/e2e/`, and shared runners
live under `tests/support/`. Shared cache-only tooling has formal entries;
individual source migrations are recorded in the completed maps.
Source-preservation, default test/lint entries, service/database/Linux gates and
representative Docker business checks pass. Stage 2 and C4 strict timing failures
remain recorded. The Runtime Python cleanup regression passes after fixing an
anonymous-volume leak; the final twelve stopped containers, 271 volumes, fourteen
networks and pinned images match the baseline, with no owned test processes left.
This batch changes test infrastructure and fixtures; it does not deploy services.

The [timeout/failure follow-up](timeout-failure-followup-20260922.md)
fixes UI fixture initialization synchronization and preserves detailed, bounded
Agent cleanup failures. It passes 1,242 shared checks, 69 UI unit and 128 component
checks, and three targeted Docker business/cleanup profiles with 244 Trace
topology checks. Strict timing diagnostics still fail. The original intermittent
failures' precise causes remain unproven; this is not a production repair claim.
All retained resources and images match this batch's baseline, in which the
twelve development containers were already stopped. No deployment occurred.

The latest full [combined candidate regression](final-candidate-regression-20260922.md)
covers `898a2be` plus acceptance-only corrections: service/database/build gates,
32 integration entries, and the final retained-environment comparison. Business
and applicable scoped Trace topology checks pass; strict timing and expected
fault/cancellation diagnostics remain failed. The initial UI lookup timeouts and
one fixture Agent deletion failure did not recur in subsequent unchanged runs
and remain recorded intermittencies. No production implementation or deployment
changed; the original twelve development containers and ten image IDs are unchanged.

The earlier index tracks platform baseline `4169443`, Runtime
response-close fix `f8e9acf`, and the later Agent UI C4 repair described below.
Those earlier results are recorded evidence from their respective batches, not a fresh
full-suite run against one combined candidate. Historical
reports retain their original candidate, date and scope.
The Runtime response-close follow-up passed its service-owned gates and was
deployed to the development Agent; its integration results are recorded below.
The later ACP SDK audit fixed three semantic failures; its subsequent metadata
batch fixed Session title/time delivery across observers and restart. The
subsequent [combined integration](acp-platform-integration.md) passed 11 real
Gateway/Runtime/UI browser checks; strict Trace still failed on recorded clock
warnings. It is scoped integration evidence, not a fresh full-platform suite.
The C4 capability-error fix and ACP SDK/metadata/AJV candidate were subsequently
[synchronized into the retained development stack](development-sync-20260917.md).
Ten browser/business checks and four successful-chat topologies passed there;
the strict browser script still failed on recorded timing warnings.
The two later Controller fixes were then
[synchronized into the same retained stack](controller-development-sync-20260917.md).
Five lifecycle flows, eight browser business checks and eleven scoped Trace
topologies passed, including four expected Docker 404s with zero probe errors.
Strict lifecycle/chat timing warnings remain failed.
The [Workflow span repair deployment](controller-development-sync-20260921.md)
subsequently synchronized `d070a7d`'s validated Controller image, recovered the
cold development Agent without losing data, and passed 12 retained and 16
isolated Trace topologies. Strict timing/expected-error failures remain recorded.

The [Runtime crash component batch](runtime-crash-recovery-revalidation.md) now
passes four real subprocess-exit recovery boundaries with production PostgreSQL
and Docker adapters. The subsequent [public Controller/Temporal integration](runtime-crash-integration-revalidation.md)
passes both source-removed and target-started crash windows, immutable child/target
recovery and single publication. This is scoped acceptance, not a new full-platform
acceptance or deployment; strict crash/error/timing evidence remains failed.

## Implemented Boundaries

- Controller owns Agent lifecycle, Template revisions, current Provider/model
  configuration, credentials and access policy. It publishes organization
  execution snapshots to ACP and requests Agent-level settlement for lifecycle
  changes. The old Run admission/finish APIs and storage have been removed.
- ACP owns local authorization/admission, Sessions, Runs, model/Tool execution,
  cancellation, approvals and retained execution audit. Ordinary execution makes
  no Controller RPC. Cold startup still needs current configuration publication;
  an initialized ACP can execute using its last applied configuration during a
  Controller outage, subject to its local execution and access checks.
- Gateway authenticates through Identity, forwards trusted identity to ACP,
  reads Controller management metadata for discovery and ACP execution state
  for observation. Console reads management and execution audit from their owners.
- Agent UI is a Session-first ACP client with explicit Agent selection, history
  recovery, tool activity, approvals, attachments and server-advertised model,
  thinking-effort and mode settings. Browser business state is not persisted locally.
- Console owns builtin model defaults and remote discovery. Controller owns saved
  connections/models and credentials. Templates reference stable model identities
  and ordered fallback models; historical Agent build/execution snapshots remain
  immutable. There is no separate Model Profile revision-history API.
- DeepSeek and OpenRouter API-key connections are supported. Provider disable
  preserves references and revokes its ACP clients when publication arrives.
  Fallback selects among known available configured candidates; upstream errors
  do not automatically replay a Run on another paid model.

Current wire definitions are indexed in [Contracts](../contracts/README.md).
Detailed ownership is in [Service layout](service-layout.md), with implementation
details in the owning service READMEs.

## Recorded Acceptance

The latest combined result is recorded first; earlier rows retain their original
candidate and scope.

| Batch                                                      | Recorded result                                                                                                                                                                                                                                                                                                                        | Evidence and boundary                                                                                                                                                                                                                                                                                                                                                                                                    |
| ---------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Repository test layout, 2026-09-22 | Root integration/E2E layout, recovered cache-only tooling, preserved Go/Rust test functions, service/database/Linux gates and representative Docker business checks pass | [Migration report](test-layout-migration.md); strict Stage 2/C4 timing failures retained, Python anonymous-volume cleanup repaired and rerun; exact environment restored, no deployment |
| UI timeout and fixture failure follow-up, 2026-09-22 | UI initialization synchronization and bounded cleanup diagnostics; 1,242 shared checks, 69 UI unit and 128 component checks pass; three targeted Docker business/cleanup profiles and 244 topologies pass | [Follow-up report](timeout-failure-followup-20260922.md); strict timing failures retained, original deletion root cause unproven; interruption recovered and Session cost rerun with complete exit evidence; retained stopped environment and ten image IDs unchanged |
| Combined candidate regression, 2026-09-22                  | Service, database and fresh Linux build gates pass; 1,224 shared checks pass with five separately covered skips; all 32 integration entries pass business and applicable scoped topology                                                                                                                                               | [Final regression](final-candidate-regression-20260922.md); acceptance-only fixes, strict diagnostics remain failed, two recorded intermittencies; resource baseline and twelve retained containers unchanged, no deployment                                                                                                                                                                                             |
| Docker single-node baseline, 2026-09-11                    | 25 accepted; five C4 browser items explicitly deferred                                                                                                                                                                                                                                                                                 | [Report](docker-single-node-verification-report.md); historical candidate, not current-HEAD coverage                                                                                                                                                                                                                                                                                                                     |
| Controller/ACP integration, 2026-09-15                     | Nine Docker business scenarios, PostgreSQL/protocol and three Temporal recovery tests passed; trace structure errors zero                                                                                                                                                                                                              | [B5 record](controller-acp-execution-boundary-plan.md#103-可执行的小步交付); strict clock-warning failures retained                                                                                                                                                                                                                                                                                                      |
| ACP database tracing, 2026-09-15                           | Service gates and real-driver contracts passed; three real Gateway chats passed the database contract                                                                                                                                                                                                                                  | [Service report](../services/agent-acp-service/docs/observability.md#database-alignment-verification-2026-09-15); full browser profile not strictly passed                                                                                                                                                                                                                                                               |
| Workspace model selection, 2026-09-15                      | Two real model responses, selection retained after reload, no prompt replay, desktop/mobile menus passed                                                                                                                                                                                                                               | [Script](../tests/e2e/workspace-closeout/model-selection-browser.mjs); local result recorded at 20:38 +08:00                                                                                                                                                                                                                                                                                                               |
| Ordered Provider fallback, 2026-09-15                      | Three real responses, referenced Provider disable, fallback/reload, manual cross-provider selection, no-candidate and layout checks passed                                                                                                                                                                                             | [Feature and verification](provider-failover.md); local result recorded at 23:12 +08:00                                                                                                                                                                                                                                                                                                                                  |
| Model discovery, 2026-09-16                                | Real read-only discovery, draft non-persistence, explicit subset save, saved-model preservation and mobile checks passed                                                                                                                                                                                                               | [Feature and verification](model-discovery.md); local result recorded at 00:40 +08:00                                                                                                                                                                                                                                                                                                                                    |
| Runtime response-close deployment, 2026-09-16              | Rebuild and workspace retention verified; three real chats passed behavior/topology checks with zero error spans/events; a separate real tool error stayed visible                                                                                                                                                                     | [Integration record](runtime-http-close-integration.md); strict browser/lifecycle scripts still failed on clock warnings                                                                                                                                                                                                                                                                                                 |
| C4 browser revalidation, 2026-09-16                        | 10 Docker browser checks, 69 UI unit tests, 127 component tests, 40 fixture checks and browser-route regression passed; unsupported-attachment feedback repaired                                                                                                                                                                       | [Current scoped report](c4-browser-revalidation.md); nine successful chat topologies passed, strict Trace failed on a 353.713 µs clock warning; interrupted cleanup verified                                                                                                                                                                                                                                             |
| ACP SDK audit and metadata, 2026-09-16                     | Three audit failures and observer/recovery metadata gap fixed; 959 unit/component, 245 PostgreSQL and 9 SDK audit tests passed; four production-image Docker scenarios passed with cleanup                                                                                                                                             | [SDK report](../services/agent-acp-service/docs/acp-v1-sdk-audit.md); controlled model/MCP and configuration publisher, including ACP process restart; service-owned batch                                                                                                                                                                                                                                               |
| Combined ACP/Runtime/UI integration, 2026-09-16            | 11 real Gateway browser checks and 40 fixture tests passed, including two-page metadata/list/reload consistency; nine successful chat topologies passed with zero error spans/events                                                                                                                                                   | [Combined candidate report](acp-platform-integration.md); strict Trace failed on four recorded clock deltas of 165.102–458.393 µs; cleanup verified, retained development stack unchanged                                                                                                                                                                                                                                |
| Tool progress revalidation, 2026-09-17                     | Updated retired fixture contracts; 12 real Runtime business paths, 20 model requests, 12 trace topologies and 26 local fixture/collector tests passed                                                                                                                                                                                  | [Progress report](tool-progress-revalidation.md); strict Trace failed on six timing-warning traces, including explicit-cancel server spans ending after their clients; no production change                                                                                                                                                                                                                              |
| ACP AJV remediation, 2026-09-17                            | AJV 8.20.0; 961 unit/component, 245 PostgreSQL, 9 SDK audit tests and four rebuilt production-image Docker scenarios passed                                                                                                                                                                                                            | [Dependency report](../services/agent-acp-service/docs/ajv-remediation.md); official advisory/local lockfile comparison, not a full online dependency audit; retained deployment unchanged                                                                                                                                                                                                                               |
| F07 latest SDK recheck, 2026-09-17                         | Three independent official rmcp 3.4.0 codec probes passed, reproducing the missing-legacy-ID URL failure                                                                                                                                                                                                                               | [SDK boundary](../runtimes/antnest-runtime/docs/elicitation.md#latest-sdk-recheck-2026-09-17); F07 remains deferred, production Runtime stays on locked 3.2.0; no new F07 implementation or deployment acceptance                                                                                                                                                                                                        |
| Development ACP/UI synchronization, 2026-09-17             | Both verified images deployed; 11 health checks, original data retention, eight real-browser checks and two metadata/error checks passed; four real-chat topologies passed                                                                                                                                                             | [Deployment report](development-sync-20260917.md); strict browser exit 1 on 206.287 µs / -2.160485 ms timing warnings; Runtime and volumes retained, Agent ready/idle                                                                                                                                                                                                                                                    |
| File observation asset migration, 2026-09-17               | Current Provider/Model, ACP authorization and per-message Trace fixtures; 43 local tests, 16 business paths, 16 execution and 48 replay/fork topologies passed                                                                                                                                                                         | [File report](file-observation-revalidation.md); strict Trace failed on 34 timing-warning traces; disposable resources removed and 12 retained containers unchanged; no production change                                                                                                                                                                                                                                |
| Structured Plan asset migration, 2026-09-17                | 12 business paths, 22 model requests, six plan updates, two invalid-plan rejections and two real Runtime writes; 38 request topologies and 58 final local tests passed                                                                                                                                                                 | [Plan report](structured-plan-revalidation.md); strict Trace failed on 20 timing-warning traces; shared legacy replay oracle retired after consumer migration; cleanup verified, development stack unchanged                                                                                                                                                                                                             |
| Slash command asset migration, 2026-09-17                  | v1 WebSocket/HTTP and v2 WebSocket passed command, attachment-history, restore and denial checks; 40 request topologies, two real Bash executions and 73 final local tests passed                                                                                                                                                      | [Command report](slash-command-revalidation.md); strict Trace failed on 15 timing-warning traces; credential/hostname collision repaired without a privacy exemption; obsolete validator retired, cleanup verified                                                                                                                                                                                                       |
| Tool permission asset migration, 2026-09-17                | Disposable wrapper, current Provider/Model and per-message Trace contracts; 26 permission scenarios, 52 model requests, 30 request topologies and 86 local tests passed; forced client-crash cleanup verified                                                                                                                          | [Permission report](tool-permission-revalidation.md); strict Trace failed on 13 timing-warning traces; all three temporary projects cleaned, 12 retained containers unchanged; no production change                                                                                                                                                                                                                      |
| Multimodal asset migration, 2026-09-17                     | Three transports passed exact native input/history, nine Provider requests, three local capability failures, six invalid inputs and identity isolation; 48 request topologies and 98 local tests passed                                                                                                                                | [Native input report](multimodal-revalidation.md); strict Trace failed on 19 warning traces plus one −454 µs local timestamp-order failure; both temporary projects cleaned, retained development unchanged; legacy helper subsequently retired in the cost batch                                                                                                                                                        |
| Session cost asset migration, 2026-09-17                   | Three transports, 52 model requests, frozen execution prices, 9 history restorations plus observer and one actual ACP restart; 137 Session and 19 pricing topologies, 116 local tests passed                                                                                                                                           | [Cost report](session-cost-revalidation.md); strict Trace failed on 86 warning traces; all eight temporary projects cleaned, retained 12 containers unchanged; final-consumer legacy oracles retired                                                                                                                                                                                                                     |
| Base Stage 3 asset migration, 2026-09-17                   | Current default management flow, five lifecycles, three ACP transports, credential rotation, Rebuild persistence and logout revocation; 34 trace topologies/privacy checks and 55 local tests passed                                                                                                                                   | [Base report](stage3-base-revalidation.md); strict Trace failed on 17 warning traces and four Docker probe ERROR spans; all seven temporary projects cleaned, retained 12 containers unchanged; legacy extended/retained branches remain pending                                                                                                                                                                         |
| Managed MCP asset migration, 2026-09-17                    | Both SDK versions, 12 Runs, 30 model requests, 18 real Tool calls, four active-Run drain barriers, history/deletion checks; 28 Trace topologies and 63 local tests passed                                                                                                                                                              | [Managed report](managed-mcp-revalidation.md); strict Trace failed on 12 warning traces and six Docker probe ERROR spans; four projects cleaned, retained 12 containers unchanged; shared legacy oracles remain for other consumers                                                                                                                                                                                      |
| Controller publication Trace, 2026-09-17                   | Full service/race/PostgreSQL and lint gates passed; independent image built; 28 RPC topology checks verify four publication attempts and two actual acknowledgement UPDATEs with zero SQL gaps                                                                                                                                         | [Controller report](controller-publication-trace-revalidation.md); strict warnings/probe errors remain failed; retained deployment unchanged                                                                                                                                                                                                                                                                             |
| ACP commit-receipt loss migration, 2026-09-17              | Both SDKs passed six faults, six natural exit-1 restarts, 12 Runs, eight Bash calls and 12 replay checks; all 32 selected-SQL/request/lifecycle topologies passed                                                                                                                                                                      | [P1 report](acp-persistence-revalidation.md); strict gate failed on 12 traces, zero missing-evidence errors; five projects cleaned and 12 retained containers unchanged                                                                                                                                                                                                                                                  |
| ACP interruption recovery migration, 2026-09-17            | Both SDKs passed eight SIGKILL scenarios, 16 Runs, 18 replays, two Runtime protection rejections and two Rebuilds; 71 final combined fixture tests passed                                                                                                                                                                              | [P2 report](acp-persistence-revalidation.md); 44 complete topologies passed, six interrupted-parent gaps remain failed; strict gate failed on 27 traces; four projects cleaned and retained 12 containers unchanged                                                                                                                                                                                                      |
| Expected absence and crash Trace follow-up, 2026-09-17     | Runtime Controller race/PostgreSQL/lint passed; 57 affected fixture tests; fresh base and P2 deployments passed 34 and 44 complete topology checks, with eight expected Docker 404s and zero probe ERROR spans                                                                                                                         | [Follow-up](trace-acceptance-followup.md); eight recovery cases and 18 replays passed; six intentional crash traces are diagnostics, not completeness failures; normal timing warnings remain strict failures; candidates isolated and retained 12 containers unchanged                                                                                                                                                  |
| Development Controller synchronization, 2026-09-17         | Both verified Controller images deployed; 11 health checks, original data retention, five lifecycle flows, eight browser business checks and eleven Trace topologies passed                                                                                                                                                            | [Deployment report](controller-development-sync-20260917.md); three publication traces include source/HTTP/ack SQL, four Docker 404s are expected absence, zero ERROR spans; five lifecycle and one chat strict results retain timing warnings; temporary resources removed, original Agent ready/idle                                                                                                                   |
| Historical ACP closeout entry, 2026-09-21                  | Both SDKs, eight real Bash Runs, 40 foreign Session denials, four automatic Disable checks and 14 replays; 824 local checks and 94 scoped Trace topologies passed                                                                                                                                                                      | [Normal-request migration](legacy-closeout-revalidation.md); 80 strict failures retain warnings and 108 rejection error spans; three projects cleaned and retained container states unchanged; crashes remain separately opted in                                                                                                                                                                                        |
| Lifecycle foundation migration, 2026-09-21                 | 928 local checks, nine lifecycle operations, two real Tool Runs and 15 of 16 Trace topologies passed                                                                                                                                                                                                                                   | [Foundation report](lifecycle-foundation-revalidation.md); Rebuild after graceful Controller restart has two missing parent edges, so acceptance remains incomplete; ten strict failures retained, all three temporary projects cleaned. User selected a separate Controller repair batch                                                                                                                                |
| Controller Workflow parent repair, 2026-09-21              | Full service/race/lint gates, 295 Temporal/PostgreSQL/component tests, 877 fixture checks and all 16 Foundation topologies pass; zero missing parents                                                                                                                                                                                  | [Candidate integration](controller-workflow-span-revalidation.md); real graceful worker replacement preserves both original Workflow spans and drain attempts. Ten strict warning/error failures remain; all six temporary projects cleaned. Retained deployment pending                                                                                                                                                 |
| Workflow span development synchronization, 2026-09-21      | Verified Controller image deployed; original ACP rows and workspace preserved; five lifecycle flows, eight browser checks, 12 retained and 16 isolated Trace topologies pass                                                                                                                                                           | [Deployment report](controller-development-sync-20260921.md); cold Runtime identity loss recovered by normal Rebuild; Jaeger metrics mismatch corrected in opt-in Controller overlay; normal restart exits zero. Seven retained and eleven isolated strict failures remain; temporary resources cleaned, 12 development containers running                                                                               |
| Lifecycle real-network migration, 2026-09-21               | 894 local tests pass, five separately gated cases skip; six real Bash Runs, twelve model calls, four lifecycle operations and all 20 topologies pass                                                                                                                                                                                   | [Network report](lifecycle-network-revalidation.md); allow/deny/restore, old-connection revocation, reverse-push blocking, B's same-socket continuation and DNS/private-address rejection verified. Zero missing parents/ERROR spans; eleven strict timing failures retained. Default Foundation also passes all 16 topologies; all three projects cleaned, retained development unchanged                               |
| Lifecycle normal-shutdown migration, 2026-09-21            | 917 local tests pass, five gated cases skip; one full deployment passes ten normal stops/restarts, same Session/Runtime/workspace and six complete Trace topologies                                                                                                                                                                    | [Shutdown report](lifecycle-shutdown-revalidation.md); stable acceptance remains incomplete: two repeats fail at post-restart Delete, latest with a 15-second timeout and Temporal membership unavailability despite healthy containers. Separate readiness repair required. Successful run retains four strict failures; all four projects cleaned, twelve retained containers unchanged                                |
| Temporal restart readiness candidate, 2026-09-21           | 936 local tests pass, five gated cases skip; two complete shutdown runs and nine-operation Foundation regression pass all 28 topologies with zero missing parents                                                                                                                                                                      | [Readiness repair](temporal-readiness-revalidation.md); native frontend initialization and live frontend/history/matching rings replace TCP-only health; Controller directly depends on Temporal health. Real open-port/unready condition was rejected. No mutation transport failures; strict failures remain 4/4/11. Three projects cleaned, twelve retained containers unchanged; development synchronization pending |
| Temporal readiness development synchronization, 2026-09-21 | Verified image deployed; normal same-container restart, retained Session replay and five temporary-Agent lifecycle operations pass; all nine retained topologies complete                                                                                                                                                              | [Deployment report](temporal-development-sync-20260921.md); all original 21 Sessions, 43 Runs, 580 messages, 29 Tool attempts, Runtime process/workspace/binding preserved. Zero ERROR spans or missing parents; five strict timing failures remain. Temporary resources cleaned; twelve containers running, eleven healthy checks passing                                                                               |
| Runtime health/observation migration, 2026-09-21           | 950 local tests pass, five gated cases skip; Docker CPU/cadence, unhealthy propagation, same-process recovery and explicit Rebuild after normal restart pass; three complete lifecycle topologies                                                                                                                                      | [Health report](lifecycle-health-revalidation.md); zero ERROR spans or missing parents, all three strict timing results remain failed. Workspace preserved, no Run/model activity. Owned resources cleaned, twelve retained containers unchanged                                                                                                                                                                         |
| Offline restore migration, 2026-09-21                      | 953 local tests pass, five gated cases skip; seven-database/two-volume/three-key recovery, exact history replay and restored Tool execution pass; all ten final Trace topologies pass                                                                                                                                                  | [Restore report](lifecycle-restore-revalidation.md); Temporal databases and writer added to recovery set; zero ERROR spans or missing parents, four lifecycle strict timing failures retained. Both isolated projects cleaned, twelve retained containers unchanged                                                                                                                                                      |
| Runtime loss migration, 2026-09-21                         | 957 local tests pass, five gated cases skip; live/cold loss, normal Runtime exits, four Tool Runs, two denials and explicit Rebuild recovery pass; all twenty final topologies pass                                                                                                                                                    | [Loss report](lifecycle-loss-revalidation.md); zero missing parents, thirteen strict failures retain timing, rejection markers and two source-Inspect 404 errors. Three projects cleaned, twelve retained containers unchanged. Candidate repair follows below                                                                                                                                                           |
| Runtime source Inspect absence repair, 2026-09-21          | Full Runtime Controller race/PostgreSQL/Docker validation passes 204 tests and 177 subtests; lint passes; 958 shared tests pass with five gated skips. Candidate Loss/Foundation business and all 36 topologies pass, with zero Runtime Controller error spans                                                                         | [Repair report](runtime-inspect-absence-revalidation.md); HTTP 404 retained as absent. Fifteen Loss and ten Foundation strict failures retain timing, rejection and restart interruption evidence. Three projects cleaned, twelve retained containers/main image unchanged in the candidate batch; development synchronization follows below                                                                             |
| Runtime Controller development synchronization, 2026-09-21 | Candidate deployed and normal restart passes; original ACP rows, Agent binding, Runtime and workspace preserved. Five lifecycle operations including source-missing recovery, three publications and exact SDK Session replay pass all nine topologies with zero errors/missing parents                                                | [Deployment report](runtime-development-sync-20260921.md); source Inspect 404 correctly absent. Six strict timing failures remain; temporary resources cleaned, twelve containers running, eleven other processes unchanged. Backups/rollback image retained; interrupted-update migration follows below                                                                                                                 |
| Interrupted Update normal-restart migration, 2026-09-21    | Current Foundation and a real completed-response fixture replace the obsolete readiness checkpoint. Both Controllers exit zero; same child/target and explicit Template revision two recover without duplicate effects. 969 shared checks and 29 final focused checks pass; final profile plus Foundation pass all nineteen topologies | [Migration report](lifecycle-interrupted-revalidation.md); zero missing parents or Runtime Controller errors. Fourteen strict failures retain cancellation, denial and timing evidence. Four projects cleaned, twelve retained containers unchanged. Unfinished-mutation crash scope stays separate; Workspace protocol migration follows                                                                                |
| Workspace protocol migration, 2026-09-21                   | 1,227 shared script checks pass with five gated skips; real Tool cancellation, explicit Rebuild, immutable unknown audits, offline replay, owner revocation and cleanup pass. Eighteen final Trace topologies pass, including actual state-watch parents and automatic Disable                                                         | [Protocol report](workspace-protocol-revalidation.md); zero missing parents or Runtime Controller errors. Thirteen strict cancellation/rejection/timing failures remain. Shared Foundation also passes sixteen topologies; four projects cleaned and twelve retained containers unchanged. Historical browser migration follows                                                                                          |
| Historical Workspace browser migration, 2026-09-21         | Four manual scenarios now run in Chromium with real Tool/file effects, exact attachment bytes, independent replay audits and mobile layout. 1,241 shared script checks pass with five gated skips; existing C4's eleven browser groups also pass                                                                                       | [Browser report](workspace-browser-revalidation.md); actual WebSocket handshake and JSON-RPC IDs bind individual traces. Thirteen final migrated and ten C4 topologies pass; zero missing parents/errors in the migrated profile. Two migrated lifecycle and four C4 strict timing results fail. Three temporary projects cleaned; twelve retained containers unchanged. Historical helper retirement stays separate     |
| Acceptance asset retirement audit, 2026-09-21              | Reviewed launcher reachability, module/symbol references, shell/container entry points and Compose dependencies; six old flow/admission files and three exclusive tests are proposed for first cleanup                                                                                                                                 | [Audit](acceptance-retirement-audit.md); documentation-only, no deletion or new E2E result. Shared helpers and reachable obsolete retained seeding remain separate                                                                                                                                                                                                                                                       |
| First acceptance asset retirement, 2026-09-21              | Removed unreachable lifecycle fallback, six old flow/admission implementations and three exclusive test files. 1,208 shared checks pass, five gated skips; Foundation and Workspace business checks and 34 Trace topologies pass                                                                                                       | [Retirement report](acceptance-retirement-revalidation.md); zero missing parents, 24 strict failures retained. Two temporary projects cleaned, twelve development containers unchanged. Manual browser input follows in the next recorded batch                                                                                                                                                                          |
| Manual browser finish retirement, 2026-09-21               | Removed unused `waitForFinish` and three exclusive tests; shared byte/privacy checks unchanged. 1,205 shared checks pass with five gated skips; automated browser five groups/13 topologies and C4 eleven groups/10 topologies pass                                                                                                    | [Browser retirement report](browser-finish-retirement.md); zero missing parents, six strict timing failures retained and C4 intentional cancellation remains diagnostic. Two projects cleaned, twelve development containers unchanged. Retained seed entry follows in the next recorded batch                                                                                                                           |
| Retained Stage 3 seed retirement, 2026-09-21               | `KEEP_STACK=true` and invalid values reject before Node/Docker/setup; unset/empty/false retain disposable behavior. Seven test-first entry cases and 1,212 shared checks pass, five gated skips. Default Stage 3 business checks and 34 topologies pass                                                                                | [Seed retirement report](retained-seed-retirement.md); seventeen strict timing failures retained. Temporary project cleaned, twelve development containers unchanged. Unreachable inline tail and final helper cleanup remain                                                                                                                                                                                            |
| Stage 3 inline-tail retirement, 2026-09-21                 | Removed old setup, six local shell helpers, legacy Compose/cleanup branches and four exclusive CLI/adapter files. 1,225 shared checks pass, five gated skips; default Stage 3 and Identity core pass business checks and 44 topologies                                                                                                 | [Tail retirement report](stage3-tail-retirement.md); strict-umask OIDC CA readability corrected in fixture, private key stays 600. Seventeen strict timing failures retained. Five projects cleaned, twelve development containers unchanged                                                                                                                                                                             |
| Recovery helper separation, 2026-09-21                     | Current Update/loss consumers use independent recovery helpers; historical gate inspection stays separate. 1,245 shared checks pass, five gated skips; both Docker business scenarios and 23 topologies pass, zero missing parents                                                                                                     | [Split report](recovery-support-split.md); eighteen strict failures retained, so strict Docker admission remains unsatisfied. Both temporary projects cleaned; twelve development containers unchanged                                                                                                                                                                                                                   |
| Historical interruption asset retirement, 2026-09-21       | Removed eleven obsolete startup-gate/SIGKILL/Trace files and 43 exclusive fixture cases; shared suite passes 1,202 checks with five gated skips. Current recovery business checks and three topologies pass, zero missing parents                                                                                                      | [Retirement report](interruption-assets-retirement.md); three strict failures retained. Temporary project cleaned and twelve retained containers unchanged. Unfinished-mutation crash E2E remains a distinct unverified fault scope                                                                                                                                                                                      |
| Runtime reconstruction crash integration, 2026-09-22       | Two real mutation crash windows, six public operations/replays, four ordinary lifecycle topologies and two scoped recovery topologies pass; 1,222 shared checks pass with five opt-in skips                                                                                                                                            | [Integration report](runtime-crash-integration-revalidation.md); strict crash/error/timing diagnostics stay failed; separately opted in, no production service change or deployment                                                                                                                                                                                                                                      |

The model-selection, Provider-fallback and discovery results were read from
the ignored local artifacts
`artifacts/verification/model-selection-acceptance/result.json`,
`artifacts/verification/provider-failover-acceptance/result.json` and
`artifacts/verification/model-discovery-acceptance/summary.json`. This index preserves their
scoped summaries; artifacts and screenshots are not guaranteed in a fresh clone.
Those three profiles were not rerun for the index refresh. The Runtime and C4
rows record their separate later executions with reusable acceptance scripts.
The discovery outage check injects a 502 in the browser; it is not evidence of
an actual Provider outage or a deployed service fault injection.

The full development-browser result at 2026-09-15 12:57 +08:00 remains **failed**
at `chat_trace` with `Jaeger span warnings require review`, and zero browser
errors. It recorded login, real conversation/tools, history recovery without
resubmission and mobile checks; those observations do not make the entire script
pass. See [browser acceptance](../tests/e2e/workspace-closeout/README.md) and
the ACP report for the separate Runtime `client_disconnected` finding.

The [2026-09-16 Runtime follow-up](../runtimes/antnest-runtime/docs/observability.md#mcp-response-close-classification)
corrects error diagnostics when a successful MCP handler is followed by an HTTP
response close. Linux formatting/Clippy, 143 unit/contract/component tests, one
CLI test, one SDK fixture test and 10 isolated Docker E2E scenarios passed.
A controlled HTTP test forces close before EOF; the isolated JavaScript SDK run
observed ordinary EOF and retained the deliberate tool failure. The subsequent
[development deployment and integration](runtime-http-close-integration.md)
replaced the Runtime through Rebuild, retained the workspace, and verified three
real chats plus a direct failure probe. The Agent is ready on generation 3.
The current strict browser profile still fails on clock warnings; the original
historical trace returned 404, so its prior failure is not retrospectively changed.

## Remaining Scope

- The [repository-wide test layout](test-layout-migration.md) has its recorded
  scoped checks, while the complete [cache-source exit](cache-test-inventory.md)
  is complete. `.cache` may contain only reproducible dependency/compiler
  caches. Private lasting evidence belongs in `artifacts/verification/`, and
  sources and manifests belong in the versioned test tree. All cached project
  assets have been individually verified and removed; final storage enforcement
  and shared regression audit pass. Retained-environment drivers
  have not been freshly executed against the retained services in this move.
- The historical acceptance entry migration and identified source-retirement
  inventory are now reconciled in the [closeout audit](acceptance-migration-closeout.md).
  Current Stage 3, Identity, lifecycle and Workspace entries point to their
  migrated profiles; retained seeding rejects before setup. The obsolete
  inline setup, flow/admission helpers, manual finish hook and startup-gate
  SIGKILL graph are removed. Shared helpers with current consumers remain.
  The [migration inventory](acceptance-asset-migration.md) records each batch's
  evidence. There is no remaining entry migration identified in that inventory;
  this does not claim every historical fault has a current replacement.
- The [combined candidate regression](final-candidate-regression-20260922.md)
  now covers the current integration inventory against one unchanged production
  candidate, with acceptance-only fixture/cleanup corrections. The final shared
  suite passes 1,224 checks; its five opt-in skips pass in the dedicated
  PostgreSQL persistence gate. All 32 entries pass business and applicable scoped
  topology checks and restore the resource baseline. Strict timing, intentional
  cancellation/rejection and crash-export diagnostics remain failed. The original
  UI lookup timeouts and one Agent deletion failure remain recorded intermittencies.
  The [targeted follow-up](timeout-failure-followup-20260922.md) repairs fixture
  initialization synchronization and lost cleanup diagnostics, with local gates
  and three Docker business/cleanup regressions passing. It does not establish
  either original intermittent root cause; strict timing failures remain.
  The Runtime reconstruction crash batch retains its separate
  opt-in evidence; it is not silently added to normal-restart stability.
- The selected Runtime reconstruction scope now has a
  [four-boundary service component batch](runtime-crash-recovery-revalidation.md)
  and [two-window public Controller/Temporal integration](runtime-crash-integration-revalidation.md).
  Both source-removed and target-started recovery reuse the original child request,
  target identity and workspace, with one rebuild publication/event. This closes
  the selected integration batch; it does not establish Agent Session automatic
  continuation, host/database loss recovery or every possible crash boundary.
  The [pi comparison](crash-recovery-pi-reference.md) keeps those scopes distinct.
  Deliberate process-kill diagnostics remain separately opted in; stable normal
  restarts still use the committed-response profile. No new production fix or
  deployment is required by these passing reconstruction scenarios.

- F07 remains deferred under the recorded rmcp 3.4.0 recheck: standard URL
  input was rejected without a legacy `elicitationId`. That result is dated
  evidence, not a claim about today's upstream release. Runtime, ACP, UI and
  deployment work stays deferred while upstream support is absent. Per the
  current priority decision, no new F07 recheck or implementation is scheduled.
- [OBS-ACP-CLOCK](controller-acp-execution-boundary-plan.md#obs-acp-clock) is an
  accepted maintenance deferral for inspected, recorded timing warnings. Strict
  results remain unchanged. The later [Stage 3 decision](stage-3-current-services-closeout.md)
  accepts its reviewed clock-only findings for the functional/structural gate;
  these inspected nonlogical findings are not active development blockers or a
  scheduled repair item. Unrelated logic errors and unexplained warnings still
  need investigation.
- The original five C4 items retain their historical deferral. Current scoped
  browser evidence is recorded in [C4 revalidation](c4-browser-revalidation.md)
  and the later [combined integration](acp-platform-integration.md);
  automatic reuse after canceling an unconfirmed Tool effect remains outside
  that scope, and the strict clock-warning failure remains.
- Runtime deployment, C4 revalidation and AJV remediation retain their separate
  batch evidence. The later development synchronization deployed the verified
  ACP/UI candidates and added scoped real-provider regression; it is not a new
  full-platform acceptance run.
- Skill Registry and Channel Gateway are not started. They and the planned
  Scheduler belong to Stage 4. Kubernetes remains planning-only; horizontal
  scaling and high availability are outside Stage 3.
- The declared ACP profile does not imply universal conformance or client MCP
  injection support. [Protocol conformance](../services/agent-acp-service/docs/protocol-conformance.md)
  remains authoritative for individual capabilities and exclusions.
