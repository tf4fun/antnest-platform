# Current Implementation And Acceptance

Updated: 2026-09-16. This index tracks platform baseline `4169443`, Runtime
response-close fix `f8e9acf`, and the later Agent UI C4 repair described below.
Results are recorded evidence from their respective batches, not a fresh
full-suite run against one combined candidate. Historical
reports retain their original candidate, date and scope.
The Runtime response-close follow-up passed its service-owned gates and was
deployed to the development Agent; its integration results are recorded below.
The later C4 revalidation includes an Agent UI capability-error
message fix, verified in a separate Docker candidate rather than deployed to
the retained development stack.

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

- [OBS-ACP-CLOCK](controller-acp-execution-boundary-plan.md#obs-acp-clock) is an
  accepted maintenance deferral for inspected, recorded timing warnings. Strict
  results remain unchanged; unrelated errors and unexplained warnings are not waived.
- The original five C4 items retain their historical deferral. Current scoped
  browser evidence is recorded in [C4 revalidation](c4-browser-revalidation.md);
  automatic reuse after canceling an unconfirmed Tool effect remains outside
  that scope, and the strict clock-warning failure remains.
- Runtime deployment and C4 revalidation are separate recorded batches. The
  separate AJV dependency advisory remains outside both scopes.
- Skill Registry and Channel Gateway are not started. Scheduler and Kubernetes
  remain planning-only; horizontal scaling and high availability are deferred.
- The declared ACP profile does not imply universal conformance or client MCP
  injection support. [Protocol conformance](../services/agent-acp-service/docs/protocol-conformance.md)
  remains authoritative for individual capabilities and exclusions.
