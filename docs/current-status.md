# Current Implementation And Acceptance

Updated: 2026-09-21. This index tracks platform baseline `4169443`, Runtime
response-close fix `f8e9acf`, and the later Agent UI C4 repair described below.
Results are recorded evidence from their respective batches, not a fresh
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

| Batch | Recorded result | Evidence and boundary |
| --- | --- | --- |
| Docker single-node baseline, 2026-09-11 | 25 accepted; five C4 browser items explicitly deferred | [Report](docker-single-node-verification-report.md); historical candidate, not current-HEAD coverage |
| Controller/ACP integration, 2026-09-15 | Nine Docker business scenarios, PostgreSQL/protocol and three Temporal recovery tests passed; trace structure errors zero | [B5 record](controller-acp-execution-boundary-plan.md#103-可执行的小步交付); strict clock-warning failures retained |
| ACP database tracing, 2026-09-15 | Service gates and real-driver contracts passed; three real Gateway chats passed the database contract | [Service report](../services/agent-acp-service/docs/observability.md#database-alignment-verification-2026-09-15); full browser profile not strictly passed |
| Workspace model selection, 2026-09-15 | Two real model responses, selection retained after reload, no prompt replay, desktop/mobile menus passed | [Script](../scripts/workspace-closeout/model-selection-browser.mjs); local result recorded at 20:38 +08:00 |
| Ordered Provider fallback, 2026-09-15 | Three real responses, referenced Provider disable, fallback/reload, manual cross-provider selection, no-candidate and layout checks passed | [Feature and verification](provider-failover.md); local result recorded at 23:12 +08:00 |
| Model discovery, 2026-09-16 | Real read-only discovery, draft non-persistence, explicit subset save, saved-model preservation and mobile checks passed | [Feature and verification](model-discovery.md); local result recorded at 00:40 +08:00 |
| Runtime response-close deployment, 2026-09-16 | Rebuild and workspace retention verified; three real chats passed behavior/topology checks with zero error spans/events; a separate real tool error stayed visible | [Integration record](runtime-http-close-integration.md); strict browser/lifecycle scripts still failed on clock warnings |
| C4 browser revalidation, 2026-09-16 | 10 Docker browser checks, 69 UI unit tests, 127 component tests, 40 fixture checks and browser-route regression passed; unsupported-attachment feedback repaired | [Current scoped report](c4-browser-revalidation.md); nine successful chat topologies passed, strict Trace failed on a 353.713 µs clock warning; interrupted cleanup verified |
| ACP SDK audit and metadata, 2026-09-16 | Three audit failures and observer/recovery metadata gap fixed; 959 unit/component, 245 PostgreSQL and 9 SDK audit tests passed; four production-image Docker scenarios passed with cleanup | [SDK report](../services/agent-acp-service/docs/acp-v1-sdk-audit.md); controlled model/MCP and configuration publisher, including ACP process restart; service-owned batch |
| Combined ACP/Runtime/UI integration, 2026-09-16 | 11 real Gateway browser checks and 40 fixture tests passed, including two-page metadata/list/reload consistency; nine successful chat topologies passed with zero error spans/events | [Combined candidate report](acp-platform-integration.md); strict Trace failed on four recorded clock deltas of 165.102–458.393 µs; cleanup verified, retained development stack unchanged |
| Tool progress revalidation, 2026-09-17 | Updated retired fixture contracts; 12 real Runtime business paths, 20 model requests, 12 trace topologies and 26 local fixture/collector tests passed | [Progress report](tool-progress-revalidation.md); strict Trace failed on six timing-warning traces, including explicit-cancel server spans ending after their clients; no production change |
| ACP AJV remediation, 2026-09-17 | AJV 8.20.0; 961 unit/component, 245 PostgreSQL, 9 SDK audit tests and four rebuilt production-image Docker scenarios passed | [Dependency report](../services/agent-acp-service/docs/ajv-remediation.md); official advisory/local lockfile comparison, not a full online dependency audit; retained deployment unchanged |
| F07 latest SDK recheck, 2026-09-17 | Three independent official rmcp 3.4.0 codec probes passed, reproducing the missing-legacy-ID URL failure | [SDK boundary](../runtimes/antnest-runtime/docs/elicitation.md#latest-sdk-recheck-2026-09-17); F07 remains deferred, production Runtime stays on locked 3.2.0; no new F07 implementation or deployment acceptance |
| Development ACP/UI synchronization, 2026-09-17 | Both verified images deployed; 11 health checks, original data retention, eight real-browser checks and two metadata/error checks passed; four real-chat topologies passed | [Deployment report](development-sync-20260917.md); strict browser exit 1 on 206.287 µs / -2.160485 ms timing warnings; Runtime and volumes retained, Agent ready/idle |
| File observation asset migration, 2026-09-17 | Current Provider/Model, ACP authorization and per-message Trace fixtures; 43 local tests, 16 business paths, 16 execution and 48 replay/fork topologies passed | [File report](file-observation-revalidation.md); strict Trace failed on 34 timing-warning traces; disposable resources removed and 12 retained containers unchanged; no production change |
| Structured Plan asset migration, 2026-09-17 | 12 business paths, 22 model requests, six plan updates, two invalid-plan rejections and two real Runtime writes; 38 request topologies and 58 final local tests passed | [Plan report](structured-plan-revalidation.md); strict Trace failed on 20 timing-warning traces; shared legacy replay oracle retired after consumer migration; cleanup verified, development stack unchanged |
| Slash command asset migration, 2026-09-17 | v1 WebSocket/HTTP and v2 WebSocket passed command, attachment-history, restore and denial checks; 40 request topologies, two real Bash executions and 73 final local tests passed | [Command report](slash-command-revalidation.md); strict Trace failed on 15 timing-warning traces; credential/hostname collision repaired without a privacy exemption; obsolete validator retired, cleanup verified |
| Tool permission asset migration, 2026-09-17 | Disposable wrapper, current Provider/Model and per-message Trace contracts; 26 permission scenarios, 52 model requests, 30 request topologies and 86 local tests passed; forced client-crash cleanup verified | [Permission report](tool-permission-revalidation.md); strict Trace failed on 13 timing-warning traces; all three temporary projects cleaned, 12 retained containers unchanged; no production change |
| Multimodal asset migration, 2026-09-17 | Three transports passed exact native input/history, nine Provider requests, three local capability failures, six invalid inputs and identity isolation; 48 request topologies and 98 local tests passed | [Native input report](multimodal-revalidation.md); strict Trace failed on 19 warning traces plus one −454 µs local timestamp-order failure; both temporary projects cleaned, retained development unchanged; legacy helper subsequently retired in the cost batch |
| Session cost asset migration, 2026-09-17 | Three transports, 52 model requests, frozen execution prices, 9 history restorations plus observer and one actual ACP restart; 137 Session and 19 pricing topologies, 116 local tests passed | [Cost report](session-cost-revalidation.md); strict Trace failed on 86 warning traces; all eight temporary projects cleaned, retained 12 containers unchanged; final-consumer legacy oracles retired |
| Base Stage 3 asset migration, 2026-09-17 | Current default management flow, five lifecycles, three ACP transports, credential rotation, Rebuild persistence and logout revocation; 34 trace topologies/privacy checks and 55 local tests passed | [Base report](stage3-base-revalidation.md); strict Trace failed on 17 warning traces and four Docker probe ERROR spans; all seven temporary projects cleaned, retained 12 containers unchanged; legacy extended/retained branches remain pending |
| Managed MCP asset migration, 2026-09-17 | Both SDK versions, 12 Runs, 30 model requests, 18 real Tool calls, four active-Run drain barriers, history/deletion checks; 28 Trace topologies and 63 local tests passed | [Managed report](managed-mcp-revalidation.md); strict Trace failed on 12 warning traces and six Docker probe ERROR spans; four projects cleaned, retained 12 containers unchanged; shared legacy oracles remain for other consumers |
| Controller publication Trace, 2026-09-17 | Full service/race/PostgreSQL and lint gates passed; independent image built; 28 RPC topology checks verify four publication attempts and two actual acknowledgement UPDATEs with zero SQL gaps | [Controller report](controller-publication-trace-revalidation.md); strict warnings/probe errors remain failed; retained deployment unchanged |
| ACP commit-receipt loss migration, 2026-09-17 | Both SDKs passed six faults, six natural exit-1 restarts, 12 Runs, eight Bash calls and 12 replay checks; all 32 selected-SQL/request/lifecycle topologies passed | [P1 report](acp-persistence-revalidation.md); strict gate failed on 12 traces, zero missing-evidence errors; five projects cleaned and 12 retained containers unchanged |
| ACP interruption recovery migration, 2026-09-17 | Both SDKs passed eight SIGKILL scenarios, 16 Runs, 18 replays, two Runtime protection rejections and two Rebuilds; 71 final combined fixture tests passed | [P2 report](acp-persistence-revalidation.md); 44 complete topologies passed, six interrupted-parent gaps remain failed; strict gate failed on 27 traces; four projects cleaned and retained 12 containers unchanged |
| Expected absence and crash Trace follow-up, 2026-09-17 | Runtime Controller race/PostgreSQL/lint passed; 57 affected fixture tests; fresh base and P2 deployments passed 34 and 44 complete topology checks, with eight expected Docker 404s and zero probe ERROR spans | [Follow-up](trace-acceptance-followup.md); eight recovery cases and 18 replays passed; six intentional crash traces are diagnostics, not completeness failures; normal timing warnings remain strict failures; candidates isolated and retained 12 containers unchanged |
| Development Controller synchronization, 2026-09-17 | Both verified Controller images deployed; 11 health checks, original data retention, five lifecycle flows, eight browser business checks and eleven Trace topologies passed | [Deployment report](controller-development-sync-20260917.md); three publication traces include source/HTTP/ack SQL, four Docker 404s are expected absence, zero ERROR spans; five lifecycle and one chat strict results retain timing warnings; temporary resources removed, original Agent ready/idle |
| Historical ACP closeout entry, 2026-09-21 | Both SDKs, eight real Bash Runs, 40 foreign Session denials, four automatic Disable checks and 14 replays; 824 local checks and 94 scoped Trace topologies passed | [Normal-request migration](legacy-closeout-revalidation.md); 80 strict failures retain warnings and 108 rejection error spans; three projects cleaned and retained container states unchanged; crashes remain separately opted in |
| Lifecycle foundation migration, 2026-09-21 | 928 local checks, nine lifecycle operations, two real Tool Runs and 15 of 16 Trace topologies passed | [Foundation report](lifecycle-foundation-revalidation.md); Rebuild after graceful Controller restart has two missing parent edges, so acceptance remains incomplete; ten strict failures retained, all three temporary projects cleaned. User selected a separate Controller repair batch |
| Controller Workflow parent repair, 2026-09-21 | Full service/race/lint gates, 295 Temporal/PostgreSQL/component tests, 877 fixture checks and all 16 Foundation topologies pass; zero missing parents | [Candidate integration](controller-workflow-span-revalidation.md); real graceful worker replacement preserves both original Workflow spans and drain attempts. Ten strict warning/error failures remain; all six temporary projects cleaned. Retained deployment pending |
| Workflow span development synchronization, 2026-09-21 | Verified Controller image deployed; original ACP rows and workspace preserved; five lifecycle flows, eight browser checks, 12 retained and 16 isolated Trace topologies pass | [Deployment report](controller-development-sync-20260921.md); cold Runtime identity loss recovered by normal Rebuild; Jaeger metrics mismatch corrected in opt-in Controller overlay; normal restart exits zero. Seven retained and eleven isolated strict failures remain; temporary resources cleaned, 12 development containers running |

The model-selection, Provider-fallback and discovery results were read from
the ignored local artifacts
`.cache/model-selection-acceptance/result.json`,
`.cache/provider-failover-acceptance/result.json` and
`.cache/model-discovery-acceptance/summary.json`. This index preserves their
scoped summaries; artifacts and screenshots are not guaranteed in a fresh clone.
Those three profiles were not rerun for the index refresh. The Runtime and C4
rows record their separate later executions with reusable acceptance scripts.
The discovery outage check injects a 502 in the browser; it is not evidence of
an actual Provider outage or a deployed service fault injection.

The full development-browser result at 2026-09-15 12:57 +08:00 remains **failed**
at `chat_trace` with `Jaeger span warnings require review`, and zero browser
errors. It recorded login, real conversation/tools, history recovery without
resubmission and mobile checks; those observations do not make the entire script
pass. See [browser acceptance](../scripts/workspace-closeout/README.md) and
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

- The latest ACP SDK/metadata combination now has scoped browser and 12-path
  Runtime progress/cancellation integration evidence. Other historical Stage 3
  and closeout deployment profiles were not comprehensively migrated or rerun;
  their recorded historical results do not imply current-candidate acceptance.
  The [asset inventory and migration](acceptance-asset-migration.md) has now
  started after development synchronization. File observations, structured Plan
  and slash commands now have current business/topology evidence. Tool
  permissions also have disposable deployment and forced-crash cleanup evidence;
  multimodal now has three-transport native-input and 48-request Trace evidence.
  Session cost now has 52-model-request, real-restart and 156-Trace scoped
  evidence. Its final-consumer legacy multimodal/pricing oracles were retired.
  The default base Stage 3 flow now has five-lifecycle, three-transport and
  34-Trace evidence, including Rebuild retention and logout revocation. Its
  strict gate retains both timing warnings and four Docker absence-probe ERROR
  spans. Managed MCP now has both-version active-Run Rebuild and real-child
  lifecycle evidence: 12 Runs and 28 trace topologies passed, strict warnings
  and six lifecycle probe ERROR spans remain failed. [RPC response loss](rpc-response-loss-revalidation.md)
  now has four publication/settlement cases, eight Runs and 28 scoped trace
  checks. The [Controller-owned follow-up](controller-publication-trace-revalidation.md)
  now records four publication attempts and two actual acknowledgement UPDATEs
  with zero SQL gaps. Its full service/race/PostgreSQL gates and 28 scoped
  integration checks pass; strict warnings and four probe ERROR spans remain
  failed. The later [Controller deployment synchronization](controller-development-sync-20260917.md)
  promoted both verified Controller candidates into retained development and
  passed five lifecycle flows, eight browser business checks and eleven scoped
  Trace topologies; strict timing warnings remain failed.
  [ACP commit-receipt loss](acp-persistence-revalidation.md)
  now has six fault cases and 32 scoped Trace checks; its strict failures remain.
  [P2 interrupted-Run recovery](acp-persistence-revalidation.md) now passes eight
  business cases, 18 replays, two protective rejections and two Rebuilds; 44
  complete Trace topologies passed in the original run. The
  [Trace follow-up](trace-acceptance-followup.md) now classifies deliberate
  SIGKILL traces as diagnostics, keeps normal-request export/completeness checks,
  and removes expected Docker absence errors in the independent candidate.
  Normal lifecycle regression passes 34 topologies with four expected 404s and
  zero Docker probe ERROR spans; strict timing warnings remain.
  [Identity/access migration](identity-access-revalidation.md) now has four
  independent HTTP/SCIM/OIDC, access/outage/expiry, ACP session and Agent
  offboarding deployments: 810 local checks and 97 scoped Trace topologies pass.
  Both SDK versions retain logout/recovery, accepted-Run effects and foreign
  Session isolation; five automatic Disable checks include Controller restart
  and SCIM reprovisioning. Strict warnings and rejection error spans remain
  failed. Retained/extended legacy base branches remain pending.
  The [historical mixed ACP closeout entry](legacy-closeout-revalidation.md)
  now runs current normal access/recovery cases, with same-organization
  principal/Agent isolation and 94 scoped Trace checks. Its former crash cases
  remain in P2. [Lifecycle foundation](lifecycle-foundation-revalidation.md) now
  has current business evidence. Its separate
  [Controller repair](controller-workflow-span-revalidation.md) now passes all
  16 topologies with zero missing Workflow parents; strict warnings/errors
  remain failed. The [development follow-up](controller-development-sync-20260921.md)
  deployed the verified image and passed retained and isolated regression.
  Network, shutdown, health, restore, loss, interrupted-update and older Workspace consumers still
  require migration.
  The obsolete shared replay, command and permission admission validators were
  replaced after their consumers migrated. Other shared helpers remain until
  their consumers migrate. Strict timing failure is not full deployment acceptance.

- F07 remains deferred: the latest official rmcp 3.4.0 still rejects standard
  URL input without a legacy `elicitationId`. The independent SDK recheck is
  complete; Runtime, ACP, UI and deployment batches await upstream support.
- [OBS-ACP-CLOCK](controller-acp-execution-boundary-plan.md#obs-acp-clock) is an
  accepted maintenance deferral for inspected, recorded timing warnings. Strict
  results remain unchanged; unrelated errors and unexplained warnings are not waived.
- The original five C4 items retain their historical deferral. Current scoped
  browser evidence is recorded in [C4 revalidation](c4-browser-revalidation.md)
  and the later [combined integration](acp-platform-integration.md);
  automatic reuse after canceling an unconfirmed Tool effect remains outside
  that scope, and the strict clock-warning failure remains.
- Runtime deployment, C4 revalidation and AJV remediation retain their separate
  batch evidence. The later development synchronization deployed the verified
  ACP/UI candidates and added scoped real-provider regression; it is not a new
  full-platform acceptance run.
- Skill Registry and Channel Gateway are not started. Scheduler and Kubernetes
  remain planning-only; horizontal scaling and high availability are deferred.
- The declared ACP profile does not imply universal conformance or client MCP
  injection support. [Protocol conformance](../services/agent-acp-service/docs/protocol-conformance.md)
  remains authoritative for individual capabilities and exclusions.
