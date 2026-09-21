# Historical Acceptance Asset Migration

Started: 2026-09-17, after development synchronization was recorded in `fd0867c`.
This inventory concerns test drivers, fixtures and their documentation, not
production capabilities. Historical passing reports retain their original date
and candidate. A green unit test of an old fixture does not make its retired
deployment contract current.

The 2026-09-21 [closeout audit](acceptance-migration-closeout.md) reconciles the
inventory after migration and bounded retirement. No entry migration remains
identified in this inventory. Batch results below are dated evidence, not a
single-candidate full-platform pass; strict failures and distinct deferred fault
scopes remain open.

## Current Contract

- Create Provider connections and Models through current Console APIs; Templates
  reference stable `model_profile_id` values and their returned revision. The
  GET `/api/admin/model-profiles` catalog remains valid. Its name alone does not
  identify obsolete code. The `/{id}/revisions` POST remains the current edit
  route with `expected_version`; immutable Model-history reads, revision-pinned
  Template references and Model-owned credential writes are retired.
- ACP owns Runs, persistence and execution. Correlate the model's propagated
  HTTP CLIENT span to `model.complete` and `agent.run`/`antnest.run.id`.
  Controller admission/finish RPCs and `admission.id` are no longer execution
  prerequisites, and a Run must not call management services.
- Each Gateway ACP WebSocket message is an independent trace linked to its
  connection. HTTP requests have their own response Trace IDs. A connection
  trace cannot stand in for load/resume/fork evidence. Collect the actual request
  trace, verify its Session/method and transport ancestry, and retain
  no-execution assertions on replay. Observe actual JSON-RPC IDs when the same
  connection issues repeated methods for the same Session.
- Gateway authenticates the connection; ACP authorizes Agent/Session access.
  A successful authenticated WebSocket upgrade is not evidence of resource
  access. Require the specific ACP access error and absence of private updates
  or execution; a transport failure cannot substitute for an authorization check.
- Disposable profiles must avoid retained host ports, credentials and Docker
  network ranges. Keep cleanup ownership and bounded waits. Timing warnings
  still fail the strict gate; inspect them separately from business/topology.

## Delivery Inventory

| Asset group                                        | Finding and retained purpose                                                                                                                                                                         | Recorded scoped evidence                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| -------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `acp-files` / `e2e-file-observations`              | First migration batch repaired old Model creation, Gateway resource denial, admission correlation and connection-wide replay traces                                                                  | [Current evidence](file-observation-revalidation.md): 16 business scenarios, 16 execution and 48 replay/fork trace topology checks passed; strict timing failed; cleanup verified                                                                                                                                                                                                                                                                                                                              |
| `acp-plan` / `e2e-structured-plan`                 | Second migration batch repaired old Model setup, admission correlation, Gateway denial and connection-wide replay assumptions                                                                        | [Current evidence](structured-plan-revalidation.md): 12 business paths and 38 request trace topology/privacy checks passed; strict timing failed; obsolete shared replay oracle removed after its final consumer migrated                                                                                                                                                                                                                                                                                      |
| `acp-commands` / `e2e-slash-commands`              | Third migration batch repaired Model setup, admission/finish assumptions, Gateway denials, request correlation and credential/hostname collision                                                     | [Current evidence](slash-command-revalidation.md): all three transports and 40 request trace topology/privacy checks passed; strict timing failed; obsolete command trace validator retired                                                                                                                                                                                                                                                                                                                    |
| `acp-permissions` / `e2e-tool-permissions`         | Fourth migration batch replaced retained-stack setup, Model revision/admission assumptions and incomplete v2 approval checks                                                                         | [Current evidence](tool-permission-revalidation.md): 26 scenarios and 30 request trace topology/privacy checks passed; strict timing failed; real client-crash cleanup passed and all disposable resources were removed                                                                                                                                                                                                                                                                                        |
| `acp-multimodal` / `e2e-multimodal`                | Fifth batch migrated current Provider/capability projections, SDK transport observation, authorization and ACP Run/driver closure                                                                    | [Current evidence](multimodal-revalidation.md): three transports and 48 request topologies/privacy checks passed; strict timing failed; its shared legacy oracle was subsequently retired after cost migration                                                                                                                                                                                                                                                                                                 |
| `acp-cost` / `e2e-session-cost`                    | Sixth batch migrated current prices, per-request Trace identity, publication notifications and restart readiness                                                                                     | [Current evidence](session-cost-revalidation.md): 52 model requests, actual restart, 137 Session and 19 pricing Trace topology/privacy checks; 116 local tests passed, strict timing failed; obsolete final-consumer oracles retired after cleanup                                                                                                                                                                                                                                                             |
| Base `e2e-stage3a` default                         | Seventh batch migrated Provider/Model writes, Template images, bootstrap/state ownership and current lifecycle/SDK Trace contracts                                                                   | [Current evidence](stage3-base-revalidation.md): five lifecycles, three transports, Rebuild persistence, logout recovery, 34 trace topologies/privacy checks and 55 local tests passed; strict warnings and Docker probe ERROR spans remain failed                                                                                                                                                                                                                                                             |
| `managed-mcp`                                      | Eighth batch migrated public configuration setup, ACP Run/drain ownership, current connections and individual request traces                                                                         | [Current evidence](managed-mcp-revalidation.md): both SDK versions, 12 Runs, 30 Provider requests, 18 Tool calls, four drain barriers, 28 trace topologies and 63 local tests passed; strict warnings/probe ERROR spans remain failed; all four projects cleaned                                                                                                                                                                                                                                               |
| Historical retained/extended base consumers        | Current extended profiles dispatch to migrated launchers; retained seed flag now rejects before setup                                                                                                | [Seed retirement](retained-seed-retirement.md) closes the obsolete entry. [Inline-tail cleanup](stage3-tail-retirement.md) removes the old setup and exclusive CLI/input helpers; current shell/Compose helpers remain                                                                                                                                                                                                                                                                                         |
| RPC response-loss profile                          | Ninth batch maps retired acquire/finish acknowledgements to current Controller-to-ACP publication/settlement and explicitly separates ACP persistence faults                                         | [Current evidence](rpc-response-loss-revalidation.md): four cases, eight Runs/Tools/replays, 28 scoped trace checks and 61 local checks passed; strict warnings, four probe ERROR spans and two missing Controller acknowledgement SQL traces remain failures; ten unused RPC-only files retired after all three projects cleaned                                                                                                                                                                              |
| Controller background publication observability    | A nonrecording parent suppressed acknowledgement SQL spans                                                                                                                                           | [Owning-service fix and integration](controller-publication-trace-revalidation.md): service/race/PostgreSQL and 28 scoped trace checks pass; four attempts and two acknowledgement UPDATEs, zero missing-SQL gaps; later [development synchronization](controller-development-sync-20260917.md) deployed both Controller fixes, with three complete publication traces and four expected Docker 404s; strict lifecycle/chat timing warnings remain failed                                                      |
| ACP database commit-receipt loss                   | Old Controller admission retry is not ACP persistence recovery                                                                                                                                       | [P1 evidence](acp-persistence-revalidation.md): six actual committed-result losses, six natural ACP failures/restarts, 12 replays and 32 scoped Trace checks; strict errors/warnings remain failed; P2 interruption is separately recorded below                                                                                                                                                                                                                                                               |
| ACP completed/interrupted/unknown-effect recovery  | Historical admission completion and Controller release events are not current ACP oracles                                                                                                            | [P2 evidence](acp-persistence-revalidation.md): eight SIGKILL cases, 18 replays, current Runtime barrier rejection and two physical Rebuild proofs; 44 complete Trace checks, six missing interrupted parents and strict warnings/errors remain failed                                                                                                                                                                                                                                                         |
| Historical mixed `acp-closeout` entry              | Normal access scenarios now use current ACP ownership; crash recovery remains separately opted in                                                                                                    | [Current normal-request evidence](legacy-closeout-revalidation.md): 824 local checks, eight Bash Runs, 40 foreign Session denials, four automatic Disable checks and 94 scoped Trace topologies; strict warnings/rejection errors remain failed; old source assets retained                                                                                                                                                                                                                                    |
| Lifecycle foundation / active-Run drain            | Current setup, public audits, exact replay and per-request traces migrated; original graceful-restart gap has a separate Controller repair                                                           | [Original migration](lifecycle-foundation-revalidation.md) retains its failure; [Controller candidate integration](controller-workflow-span-revalidation.md) passes nine operations and all 16 Trace topologies with zero missing parents, 295 Controller integration and 877 fixture checks. [Development synchronization](controller-development-sync-20260921.md) is complete with fresh retained/isolated scoped regression. Strict warnings/errors remain failed                                          |
| Lifecycle real network                             | Current setup, public Run audits, per-request traces and current lifecycle/policy oracles replace legacy admission assumptions                                                                       | [Network revalidation](lifecycle-network-revalidation.md): six real Bash Runs, twelve model calls, old-connection revocation and cross-Agent isolation; all 20 topologies pass, zero missing parents/ERROR spans; 11 strict timing failures retained. Shared Foundation revalidation passes all 16 topologies; retained development unchanged                                                                                                                                                                  |
| Lifecycle normal shutdown / stream recovery        | Current Foundation setup, ACP state ownership, real SSE Trace IDs, same-container restart and empty-Session persistence migrated                                                                     | [Original migration](lifecycle-shutdown-revalidation.md) retains repeated Delete failures. The [Temporal readiness candidate](temporal-readiness-revalidation.md) passes 936 local checks and 28 isolated topologies. [Development synchronization](temporal-development-sync-20260921.md) is complete: normal restart, exact Session replay, five lifecycle operations and nine retained topologies pass; original data/Runtime preserved. Strict timing failures remain                                      |
| Lifecycle Runtime health / observation             | Current Foundation setup, CPU/cadence evidence, public unhealthy/recovery state and explicit Rebuild after process replacement migrated                                                              | [Health evidence](lifecycle-health-revalidation.md): 950 local checks and three lifecycle topologies pass, zero missing parents or ERROR spans; all three strict timing results remain failed. Workspace retained, no Run/model activity, owned resources cleaned                                                                                                                                                                                                                                              |
| Lifecycle offline backup / restore                 | Current Foundation setup, seven-database recovery including Temporal, full writer quiescence, public audit/history and request traces migrated                                                       | [Restore evidence](lifecycle-restore-revalidation.md): 953 local tests and ten final Docker topologies pass; zero missing parents or ERROR spans, four strict timing failures retained. Two projects cleaned, twelve retained containers unchanged                                                                                                                                                                                                                                                             |
| Lifecycle live/cold Runtime loss                   | Current Foundation, normal exit/removal, fresh Inspect loss audit, exact producer route, public Runs and SDK traces migrated                                                                         | [Loss evidence](lifecycle-loss-revalidation.md): 957 local tests and twenty final topologies pass; zero missing parents. Historical thirteen strict failures preserved. Subsequent [Runtime Controller repair](runtime-inspect-absence-revalidation.md) passes service gates and 36 candidate topologies; [development synchronization](runtime-development-sync-20260921.md) now passes nine more with zero errors/missing parents. Strict timing failures remain; interrupted-update migration follows below |
| Interrupted Runtime Update                         | Normal committed-response recovery uses current Foundation, transparent receipt fixture, normal Controller stops and exact target Template revision                                                  | [Current evidence](lifecycle-interrupted-revalidation.md): 969 shared and 29 final focused checks pass; nineteen topologies across the final interrupted-update and Foundation runs pass, zero missing parents. Fourteen strict failures remain; four projects cleaned and twelve retained containers unchanged. Historical unfinished-mutation abrupt-crash evidence stays separate                                                                                                                           |
| Workspace protocol profile                         | Current Foundation/catalog, six-field ACP state, public audits, explicit Rebuild recovery, real Runtime process binding and actual response Trace IDs replace old assumptions                        | [Protocol evidence](workspace-protocol-revalidation.md): 1,227 shared checks pass, five gated skips; eighteen final topologies pass with zero missing parents. Thirteen strict cancellation/rejection/timing failures remain. Shared Foundation adds sixteen passing topologies; four projects cleaned and twelve retained containers unchanged. Older browser consumers remain separate                                                                                                                       |
| Historical Workspace browser four-scenario profile | Former manual entry now runs Chromium through current Foundation/catalog; actual handshake/request identities, public audits, exact file/attachment replay and mobile checks replace old assumptions | [Browser migration](workspace-browser-revalidation.md): 1,241 shared checks pass with five gated skips; final thirteen topologies pass with zero missing parents/errors; existing C4 eleven browser groups/ten topologies pass. Two migrated lifecycle and four C4 strict timing results fail; three projects cleaned and twelve retained containers unchanged. Helper retirement stays separate                                                                                                               |
| Identity Agent-access / ACP-session profiles       | Migrated current Provider/Model, ACP audits, idempotent replay, authorization ownership and Temporal offboarding                                                                                     | [Current evidence](identity-access-revalidation.md): 26 ACP session and 58 Agent/offboarding Trace topologies; 6 denied prompts, 4 completed Tool Runs, 36 admin/8 Agent/20 foreign Session denials, 9 private Runs and 5 automatic Disable checks; strict warnings/rejection errors remain failed                                                                                                                                                                                                             |
| Identity HTTP/SCIM/OIDC and HTTP access            | Old full-URL and causal SQL ownership assumptions; legacy parent deployment                                                                                                                          | [HTTP migration evidence](identity-access-revalidation.md): 9 local/SCIM, 7 OIDC and 4 access groups, actual outage/expiry, 13 complete Trace topologies; strict warnings/expiry error spans remain failed. ACP and Agent consumers have their separate evidence above.                                                                                                                                                                                                                                        |

The [retirement audit](acceptance-retirement-audit.md) identifies the reachable
retained seed mode, unreachable duplicate dispatch and current shared consumers.
Its first removal is recorded in the [retirement revalidation](acceptance-retirement-revalidation.md);
[Manual browser input retirement](browser-finish-retirement.md) follows in its
own batch with both browser regressions. [Retained seeding](retained-seed-retirement.md)
now rejects before setup; [inline-tail cleanup](stage3-tail-retirement.md) removes
the old setup and its exclusive CLI/input helpers. No historical
directory has been retired wholesale. The obsolete file replay helper was removed only
after both Files and its final Plan consumer gained current request evidence;
the mapping and final checks are in the Plan report.
The old command admission/finish validator and its obsolete fixture cases were
also removed after their current request-level replacements passed deployment.
The permission admission-based Trace oracle and fixture were replaced after
current Run/HTTP and approval-before-effect checks passed deployed business/topology
validation, including an independent client-crash cleanup control.
The old shared multimodal `evidence.mjs` and its three admission-era cases were
removed after cost, its final consumer, passed current per-request checks and
cleanup. The old ancestry-only pricing validator was replaced with exact
management HTTP and committed current Model SQL evidence.

The Managed-only old admission/pinned-snapshot and clock-based drain validators
were removed after both versions gained current Run/publication/settlement and
real stdio evidence. Its shared legacy trace oracle remains for other consumers.
The obsolete RPC-only acquire/finish client, proxy, snapshot, model and oracles
were removed after current response-loss business checks and cleanup. The dated
report remains historical. ACP commit-receipt loss now has its separate P1
evidence; P2 separately verifies completed/interrupted/unknown-effect recovery
through current public audits and Runtime replacement. Retained seeding and old
extended branches have since been retired or migrated; shared helpers remain for
their current consumers. Neither P1 nor P2 is equated with Controller
acknowledgement recovery.

## Assets With Current Scoped Evidence

- [Tool progress](tool-progress-revalidation.md): 12 business paths and current
  Run/HTTP correlation, with strict timing failures recorded.
- [File observations](file-observation-revalidation.md): 16 business paths and
  64 independent message trace topology/privacy checks, with strict timing
  failures recorded.
- [Structured Plan](structured-plan-revalidation.md): 12 business paths,
  12 execution, 20 replay/fork and six denial trace topology/privacy checks,
  with strict timing failures recorded.
- [Slash commands](slash-command-revalidation.md): three transports, six command
  Runs, two ordinary Runs and 32 setup/restore/rejection request traces,
  with strict timing failures recorded.
- [Tool permissions](tool-permission-revalidation.md): 26 scenarios, 26 execution
  and four recovery/denial trace topology/privacy checks; strict timing failures
  retained, independent client-crash cleanup verified.
- [Native multimodal input](multimodal-revalidation.md): three transports, 12
  execution and 36 setup/configuration/replay/rejection trace topology/privacy
  checks; nine Provider requests and three local capability failures, with
  explicit strict warning/order failures.
- [Session cost](session-cost-revalidation.md): three transports, 52 executions,
  137 Session and 19 pricing Trace topology/privacy checks, real ACP restart,
  preserved cumulative/fork costs and strict timing failures.
- [Base Stage 3](stage3-base-revalidation.md): current default management flow,
  five lifecycle and 29 Session trace topologies/privacy checks, actual Provider
  credential rotation, Rebuild workspace/history retention and logout revocation;
  strict warnings and Docker probe ERROR spans remain failures.
- [Managed MCP](managed-mcp-revalidation.md): both SDK versions, real child reuse,
  active-Run Rebuild barriers, existing-connection refresh, history and deletion;
  28 trace topologies passed, strict warnings/probe ERROR spans remain failures.
- [RPC response loss](rpc-response-loss-revalidation.md): both SDK versions,
  four actual publication/settlement acknowledgement losses, preserved effects
  and eight replays; 28 scoped trace checks pass, with strict warnings, probe
  ERROR spans retained. The [Controller follow-up](controller-publication-trace-revalidation.md)
  closes the original background acknowledgement SQL gap with four attempt
  spans and two real acknowledgement UPDATEs.
- [ACP commit-receipt loss](acp-persistence-revalidation.md): six real PostgreSQL
  result losses, six natural ACP restarts, 12 Runs, 12 replays and 32 scoped Trace
  checks, with strict warnings and error spans retained.
- [ACP process interruption](acp-persistence-revalidation.md): eight SIGKILL
  scenarios, 18 replays, two protective rejections and two physical Rebuilds;
  the original run passed 44 complete Trace checks. The
  [follow-up contract](trace-acceptance-followup.md) treats intentional SIGKILL
  traces as diagnostics while preserving normal-request strict checks and
  validating expected Docker absence in the independent candidate.
- [C4 combined integration](acp-platform-integration.md): current Provider/Model
  setup, two-page metadata, attachments, approvals and browser lifecycle.
- [Development synchronization](development-sync-20260917.md): deployed ACP/UI,
  real-provider conversation/tools, retained history and metadata/error checks.
- [Identity and access](identity-access-revalidation.md): four independent
  deployments cover HTTP/SCIM/OIDC, outage/expiry/logout, ACP accepted-Run
  continuation, organization isolation and automatic offboarding. 810 local
  checks and 97 scoped Trace topologies passed; strict warnings and rejection
  errors remain failed. Retained parent branches/shared assets remain separate.
- [Historical ACP closeout entry](legacy-closeout-revalidation.md): both SDKs,
  same-organization principal/Agent isolation, eight actual Bash effects,
  14 exact history replays and four automatic Disable checks; 824 local checks
  and 94 scoped Trace topologies passed. Strict warnings/rejection errors remain
  failed; P2 crashes, lifecycle and Workspace consumers retain separate scope.
- [Lifecycle foundation](lifecycle-foundation-revalidation.md): nine completed
  lifecycle operations, two real Tool Runs, two busy rejections and exact history
  replay. Its original 15-of-16 result is retained. The separate
  [Controller candidate](controller-workflow-span-revalidation.md) now passes
  all 16 topologies with zero missing parents; strict warnings/errors remain
  failed. The [development synchronization](controller-development-sync-20260921.md)
  is complete, with 12 retained and 16 isolated topologies passing; strict
  failures remain recorded. No old asset retired.
- [Controller development synchronization](controller-development-sync-20260917.md):
  both verified Controller images deployed, original data preserved, five
  lifecycle flows and eight browser business checks passed; eleven scoped Trace
  topologies include complete publication SQL and four expected Docker 404s.
  Strict lifecycle/chat timing warnings remain failed.
- [Lifecycle network](lifecycle-network-revalidation.md): four lifecycle
  operations, six real Runtime probes, current public execution audits and all
  20 topologies pass. A's deny removes its original conntrack and blocks reverse
  delivery while B's original connection survives. Strict timing failures remain;
  all three projects cleaned, twelve retained development containers unchanged.
- [Lifecycle shutdown](lifecycle-shutdown-revalidation.md): ten normal stops and
  same-container restarts, remote stream closure, preserved Session/Runtime and
  workspace, and six complete topologies pass in one deployment. Four strict
  failures remain. Original repeated post-restart Delete failures captured
  Temporal membership unavailability despite TCP health. The separate
  [readiness candidate](temporal-readiness-revalidation.md) now passes two full
  shutdown runs and Foundation regression, with 28 complete topologies and zero
  mutation transport failures. Its three projects and the original four are
  cleaned; twelve retained containers unchanged during the candidate batch.
  [Development synchronization](temporal-development-sync-20260921.md) then
  deployed the candidate, passed normal restart and nine retained topologies,
  and preserved the original data/Runtime. Strict failures are not waived.
- [Runtime health/observation](lifecycle-health-revalidation.md): unchanged CPU
  and cadence thresholds, three failed health probes, public offline propagation,
  same-process recovery and explicit Rebuild after normal process replacement
  pass. All three lifecycle topologies have zero missing parents or ERROR spans;
  their strict clock-warning results remain failed. Shared regression passes
  950 checks with five gated skips. The isolated project is cleaned and twelve
  retained development containers are unchanged.
- [Offline restore](lifecycle-restore-revalidation.md): seven databases including
  Temporal history/visibility, two persistent volumes and three saved keys recover
  into new empty owned storage after clean writer shutdown. Frozen fingerprints,
  two permission-drift probes, exact replay with no new execution and restored
  Tool execution pass. All ten final topologies pass with zero missing parents
  or ERROR spans; four lifecycle strict clock results remain failed. Shared
  regression passes 953 checks with five skips. Both projects cleaned, twelve
  retained containers unchanged.
- [Live/cold Runtime loss](lifecycle-loss-revalidation.md): four completed Tool
  Runs, two semantic denials, two explicit Rebuilds and exact same-Session history
  pass. Normal exit/removal replaces forced deletion; fresh Inspect audits are
  checked separately from exact Docker-event/reconciliation producer evidence.
  All twenty final topologies pass with zero missing parents. Thirteen strict
  failures remain, including two source-Inspect 404 errors in that historical run.
  Three projects cleaned, twelve retained containers unchanged. The subsequent
  [Runtime Controller repair](runtime-inspect-absence-revalidation.md) passes
  service gates and 36 candidate Loss/Foundation topologies with zero Runtime
  Controller errors; strict timing, rejection and restart interruption evidence
  remains failed. [Development synchronization](runtime-development-sync-20260921.md)
  now passes normal restart, original data preservation and nine complete
  topologies, including source-missing recovery. Six strict timing failures
  remain. Interrupted-update migration follows below; older Workspace assets remain.
- [Interrupted Update normal recovery](lifecycle-interrupted-revalidation.md):
  a real completed Update response is withheld until normal caller shutdown;
  both Controllers exit zero, and the same child/target recovers with the selected
  new Template revision. Exact replay preserves effects, generation, workspace
  and event counts. The final profile and ordinary Foundation pass nineteen
  topologies; fourteen strict cancellation, denial and timing results remain
  failed. Four projects cleaned, twelve retained containers unchanged. The old
  readiness-gated SIGKILL checkpoint is historical, not equivalent current
  evidence of unfinished Runtime mutation recovery. Workspace protocol follows below.
- [Workspace protocol](workspace-protocol-revalidation.md): real cross-connection
  Tool cancellation, explicit Rebuild recovery with immutable unknown Run facts,
  offline completion/exact replay, replacement Runtime context and owner revocation
  pass. All eighteen final topologies include two state watches and automatic
  Temporal Disable; zero missing parents. The old observer's fabricated parent
  is replaced with the Gateway response Trace ID. Thirteen strict failures remain;
  1,227 shared checks pass with five gated skips. Older interactive browser assets
  follow in the browser batch below. Shared Foundation adds sixteen passing topologies; all four projects
  cleaned and twelve retained containers unchanged. No historical directory is
  removed by this batch.
- [Historical Workspace browser profile](workspace-browser-revalidation.md): the
  four manual prompts now run in Chromium with real Tool effects, exact uploaded
  bytes, unsupported-file feedback, audit-preserving reload and mobile layout.
  Actual WebSocket handshake/request identities replace model-only Trace lookup.
  Shared regression passes 1,241 checks with five gated skips; existing C4's eleven
  browser groups and ten topologies also pass. All thirteen final migrated topologies
  pass with zero missing parents/errors. Two migrated lifecycle and four C4 strict
  timing results fail. Three temporary projects are cleaned and twelve retained
  containers unchanged. The subsequent retirement batches below resolve the
  identified obsolete helper graph while retaining current consumers.
- Shared `scripts/verification`, identity clients, Docker/network wrappers and
  trace topology helpers remain in use. Review imports before moving an asset.

These are scoped evidence, not replacements for every historical scenario.

## Retirement audit, 2026-09-21

The [source/reference audit](acceptance-retirement-audit.md) identifies six
superseded flow/admission implementations and three exclusive tests for the first
bounded cleanup batch. The [first removal record](acceptance-retirement-revalidation.md)
records their removal and the simplified lifecycle entry: 1,208 shared checks
pass with five gated skips; Foundation/Workspace add 34 passing topologies and
zero missing parents. All 24 strict failures remain. Two projects are cleaned
and twelve development containers unchanged.
The [manual browser input batch](browser-finish-retirement.md) removes only its
unused export and three tests; its module still owns current exact-byte checks.
Its 1,205 shared checks pass with five gated skips; automated browser passes five
business groups/thirteen topologies and C4 eleven groups/ten topologies. Six
strict timing failures and C4 cancellation diagnostics remain. Two projects are
cleaned and twelve retained containers unchanged. The retained Stage 3 seed flag now [rejects before setup](retained-seed-retirement.md);
its obsolete inline tail and exclusive CLI/input helpers are now
[removed separately](stage3-tail-retirement.md). That batch also repairs public
OIDC fixture certificate readability under strict umask, retaining private-key
mode 600. Its final 1,225 shared checks pass with five skips; default/Identity
business checks and 44 topologies pass, seventeen strict timing failures remain.
All five projects are cleaned and twelve development containers unchanged.
Seven new entry cases and 1,212 shared checks pass with five gated skips. Default
Stage 3 passes business checks and 34 topologies; seventeen strict timing failures
remain. Its temporary project is cleaned and twelve development containers unchanged. Current Identity shell clients, Compose model peers and
shared Trace helpers must remain. Current interruption helpers are now
[separated from historical startup-gate diagnostics](recovery-support-split.md).
Its 1,245 shared checks pass with five gated skips; current Update/loss business
checks and 23 topologies pass with zero missing parents. Eighteen strict results
remain failed; both projects are cleaned and twelve development containers unchanged.
The historical startup-gate/Compose/image/Trace graph is subsequently
[retired](interruption-assets-retirement.md): eleven files and 43 exclusive cases
removed; 1,202 shared checks pass with five skips. Current recovery business
checks and three topologies pass with zero missing parents; three strict results
remain failed. The temporary project is cleaned and twelve retained containers
unchanged. Shared observability/current recovery helpers remain. This does not
close unfinished-mutation crash E2E scope.
The original audit itself removed no code and added no Docker acceptance result.

## Retirement Rule

For each group, record the old scenario, its current replacement and the exact
passing business/topology evidence before removal. Keep deliberate failures,
identity isolation, no-replay and secret-boundary assertions. Record strict
timing failures without converting them to success. Remove a superseded helper
only after its final consumer migrates and applicable fixture/deployment checks
finish with owned resources cleaned. Do not delete retained development data,
rollback images or private backups as part of source-asset cleanup.
