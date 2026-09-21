# Historical Acceptance Asset Migration

Started: 2026-09-17, after development synchronization was recorded in `fd0867c`.
This inventory concerns test drivers, fixtures and their documentation, not
production capabilities. Historical passing reports retain their original date
and candidate. A green unit test of an old fixture does not make its retired
deployment contract current.

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

| Asset group | Finding and retained purpose | Next admission requirement |
| --- | --- | --- |
| `acp-files` / `e2e-file-observations` | First migration batch repaired old Model creation, Gateway resource denial, admission correlation and connection-wide replay traces | [Current evidence](file-observation-revalidation.md): 16 business scenarios, 16 execution and 48 replay/fork trace topology checks passed; strict timing failed; cleanup verified |
| `acp-plan` / `e2e-structured-plan` | Second migration batch repaired old Model setup, admission correlation, Gateway denial and connection-wide replay assumptions | [Current evidence](structured-plan-revalidation.md): 12 business paths and 38 request trace topology/privacy checks passed; strict timing failed; obsolete shared replay oracle removed after its final consumer migrated |
| `acp-commands` / `e2e-slash-commands` | Third migration batch repaired Model setup, admission/finish assumptions, Gateway denials, request correlation and credential/hostname collision | [Current evidence](slash-command-revalidation.md): all three transports and 40 request trace topology/privacy checks passed; strict timing failed; obsolete command trace validator retired |
| `acp-permissions` / `e2e-tool-permissions` | Fourth migration batch replaced retained-stack setup, Model revision/admission assumptions and incomplete v2 approval checks | [Current evidence](tool-permission-revalidation.md): 26 scenarios and 30 request trace topology/privacy checks passed; strict timing failed; real client-crash cleanup passed and all disposable resources were removed |
| `acp-multimodal` / `e2e-multimodal` | Fifth batch migrated current Provider/capability projections, SDK transport observation, authorization and ACP Run/driver closure | [Current evidence](multimodal-revalidation.md): three transports and 48 request topologies/privacy checks passed; strict timing failed; its shared legacy oracle was subsequently retired after cost migration |
| `acp-cost` / `e2e-session-cost` | Sixth batch migrated current prices, per-request Trace identity, publication notifications and restart readiness | [Current evidence](session-cost-revalidation.md): 52 model requests, actual restart, 137 Session and 19 pricing Trace topology/privacy checks; 116 local tests passed, strict timing failed; obsolete final-consumer oracles retired after cleanup |
| Base `e2e-stage3a` default | Seventh batch migrated Provider/Model writes, Template images, bootstrap/state ownership and current lifecycle/SDK Trace contracts | [Current evidence](stage3-base-revalidation.md): five lifecycles, three transports, Rebuild persistence, logout recovery, 34 trace topologies/privacy checks and 55 local tests passed; strict warnings and Docker probe ERROR spans remain failed |
| `managed-mcp` | Eighth batch migrated public configuration setup, ACP Run/drain ownership, current connections and individual request traces | [Current evidence](managed-mcp-revalidation.md): both SDK versions, 12 Runs, 30 Provider requests, 18 Tool calls, four drain barriers, 28 trace topologies and 63 local tests passed; strict warnings/probe ERROR spans remain failed; all four projects cleaned |
| Historical retained/extended base consumers | Some extended branches still use old setup and lifecycle helpers | Migrate each remaining consumer before retiring shared helpers; retained seeding is not current acceptance |
| RPC response-loss profile | Ninth batch maps retired acquire/finish acknowledgements to current Controller-to-ACP publication/settlement and explicitly separates ACP persistence faults | [Current evidence](rpc-response-loss-revalidation.md): four cases, eight Runs/Tools/replays, 28 scoped trace checks and 61 local checks passed; strict warnings, four probe ERROR spans and two missing Controller acknowledgement SQL traces remain failures; ten unused RPC-only files retired after all three projects cleaned |
| Controller background publication observability | A nonrecording parent suppressed acknowledgement SQL spans | [Owning-service fix and integration](controller-publication-trace-revalidation.md): service/race/PostgreSQL and 28 scoped trace checks pass; four attempts and two acknowledgement UPDATEs, zero missing-SQL gaps; later [development synchronization](controller-development-sync-20260917.md) deployed both Controller fixes, with three complete publication traces and four expected Docker 404s; strict lifecycle/chat timing warnings remain failed |
| ACP database commit-receipt loss | Old Controller admission retry is not ACP persistence recovery | [P1 evidence](acp-persistence-revalidation.md): six actual committed-result losses, six natural ACP failures/restarts, 12 replays and 32 scoped Trace checks; strict errors/warnings remain failed; P2 interruption is separately recorded below |
| ACP completed/interrupted/unknown-effect recovery | Historical admission completion and Controller release events are not current ACP oracles | [P2 evidence](acp-persistence-revalidation.md): eight SIGKILL cases, 18 replays, current Runtime barrier rejection and two physical Rebuild proofs; 44 complete Trace checks, six missing interrupted parents and strict warnings/errors remain failed |
| Historical mixed `acp-closeout` entry | Normal access scenarios now use current ACP ownership; crash recovery remains separately opted in | [Current normal-request evidence](legacy-closeout-revalidation.md): 824 local checks, eight Bash Runs, 40 foreign Session denials, four automatic Disable checks and 94 scoped Trace topologies; strict warnings/rejection errors remain failed; old source assets retained |
| Lifecycle foundation / active-Run drain | Current setup, public audits, exact replay and per-request traces migrated; original graceful-restart gap has a separate Controller repair | [Original migration](lifecycle-foundation-revalidation.md) retains its failure; [Controller candidate integration](controller-workflow-span-revalidation.md) passes nine operations and all 16 Trace topologies with zero missing parents, 295 Controller integration and 877 fixture checks. [Development synchronization](controller-development-sync-20260921.md) is complete with fresh retained/isolated scoped regression. Strict warnings/errors remain failed |
| Remaining Lifecycle and older Workspace flows | Network, shutdown, health, restore, loss, interrupted-update and old Workspace consumers retain legacy assumptions | Migrate each remaining consumer; retain shared Docker/network/wait helpers until their final consumer passes |
| Identity Agent-access / ACP-session profiles | Migrated current Provider/Model, ACP audits, idempotent replay, authorization ownership and Temporal offboarding | [Current evidence](identity-access-revalidation.md): 26 ACP session and 58 Agent/offboarding Trace topologies; 6 denied prompts, 4 completed Tool Runs, 36 admin/8 Agent/20 foreign Session denials, 9 private Runs and 5 automatic Disable checks; strict warnings/rejection errors remain failed |
| Identity HTTP/SCIM/OIDC and HTTP access | Old full-URL and causal SQL ownership assumptions; legacy parent deployment | [HTTP migration evidence](identity-access-revalidation.md): 9 local/SCIM, 7 OIDC and 4 access groups, actual outage/expiry, 13 complete Trace topologies; strict warnings/expiry error spans remain failed. ACP and Agent consumers have their separate evidence above. |

The remaining legacy branches above remain pending. No historical
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
through current public audits and Runtime replacement. Other retained/extended
shared-helper consumers remain pending; neither P1 nor P2 is equated with
Controller acknowledgement recovery.

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
- Shared `scripts/verification`, identity clients, Docker/network wrappers and
  trace topology helpers remain in use. Review imports before moving an asset.

These are scoped evidence, not replacements for every historical scenario.

## Retirement Rule

For each group, record the old scenario, its current replacement and the exact
passing business/topology evidence before removal. Keep deliberate failures,
identity isolation, no-replay and secret-boundary assertions. Record strict
timing failures without converting them to success. Remove a superseded helper
only after its final consumer migrates and applicable fixture/deployment checks
finish with owned resources cleaned. Do not delete retained development data,
rollback images or private backups as part of source-asset cleanup.
