# Docker Single-Node Closeout

> Status: accepted within the 2026-09-11 scope; C4 client acceptance deferred
>
> Updated: 2026-09-11
>
> Inspection baseline: `c989f20`

## 1. Stage Boundary

The next delivery is a complete single-node product, not another service split.
Close three business flows through the real Edge Gateway:

1. Identity: provision a person, authenticate, use the authorized application,
   and revoke access correctly.
2. Agent management: configure a model and Template, create and operate an
   isolated Agent, and observe a definitive lifecycle outcome.
3. Agent usage: converse through Edge ACP, use Runtime Tools, cancel, and
   recover conversation state after reconnecting. Agent Web UI client acceptance
   is deferred by the scope decision below.

ACP protocol support is the first implementation priority. Identity integration
is the second. Documentation, operations, and Gateway-rooted Jaeger evidence
are delivery requirements, not work left for a later production stage.

This plan controls the remaining work. Earlier accepted stages remain evidence
for their specific cases, not proof that every flow below has been accepted.
Service documents and `contracts/` remain the authorities for service behavior.

**Scope decision, 2026-09-11:** the user deferred Agent Web UI client validation
pending further product decisions. C4-01..05 stay unaccepted and are excluded
from the current closeout gate, not marked passed or deleted. Their desktop/
mobile rendering, attachments, cancellation UX, multi-Session feedback, reconnect
and open-page identity/rebuild checks will resume in a later client batch.
The related user-facing recovery decision after unknown-effect cancellation is
also deferred; this does not change the current server fencing policy.
ACP service/protocol, Gateway authorization, Runtime execution, identity effects,
and lifecycle regression remain required. Admin Console operations and live
Jaeger navigation in C5-04 are separate and are not deferred. Earlier dated
statements that C4 blocks this closeout are superseded by this scope decision.
The checklist has 25 accepted items, five deferred C4 items, and no remaining
in-scope items. The final verification report distinguishes prior accepted
Console workflows, current-candidate service regression, and the final live
Console recovery/Jaeger observations; none substitutes for deferred C4 checks.
Dated batch notes below retain the acceptance boundary at that checkpoint;
the current checkboxes and final report supersede their earlier open-item counts.

### Deferred explicitly

| Work | Decision in this stage |
| --- | --- |
| Agent Web UI client acceptance (C4) | defer browser interaction/rendering and its pending UX decisions; retain implementation, tests and unmet acceptance criteria |
| Skill Registry | do not start the service, storage, RPC, or pages |
| Channel Gateway | do not start the service, connectors, or pages |
| Scheduler | record ownership and intended trigger flow only; no implementation |
| Kubernetes | retain the Runtime Controller adapter boundary; no adapter or manifests |
| Horizontal scaling, HA, multi-node failover | do not implement or make them acceptance dependencies |
| Generic event bus or separate cross-service audit service | do not introduce for closeout |
| New public third-party OpenAPI surface | do not expand beyond the existing product/ACP entry requirements |

One PostgreSQL instance is sufficient for development and acceptance. Each
owner retains its own database, role, migrations, and DSN; no cross-service SQL,
foreign keys, transactions, or shared persistence adapter is permitted.

## 2. Inspected Starting Point

This section retains the inspection-baseline gaps, not the current completion
count. Section 3's checkboxes and final batch results are the current authority.

| Area | Existing implementation/evidence | Remaining closeout work |
| --- | --- | --- |
| ACP | official SDK `1.4.0`, stable `/v1/acp`, draft `/v2/acp`, shared application core, capability and wire tests | explicit platform-only MCP profile; wire plus persistence evidence for reconnect, isolation, cancellation, and revision changes |
| Identity | local login, OIDC, SCIM, membership checks, transactional local journal, Console administration | prove the complete Gateway flows and effective deactivation across existing connections; identify any necessary downstream lifecycle synchronization |
| Agent management | async lifecycle operations, immutable revisions, Docker Runtime, Egress, durable events | close remaining UI/owner-service error and recovery paths against the three-flow acceptance matrix |
| Agent UI | production Edge-to-ACP v1 path, messages, attachments, Tool activity, cancel and replay | prove restored input availability, no duplicate execution on reconnect, and consistent visibility of authoritative outcomes |
| Observability | service OTLP, Stage 3 admission/linked lifecycle-worker traces, Gateway-rooted managed MCP create/chat/rebuild evidence | one reproducible report covering Gateway-origin identity, lifecycle, and ACP/Runtime execution; verify causality, not just service-name presence |
| Operations | Compose builds, private logical databases, disposable test cleanup | clean bootstrap runbook, restore exercise, failure diagnostics, idle CPU investigation, final resource accounting |

Important distinctions from inspection:

- The ACP protocol matrix explicitly identifies stdio MCP as a stable-v1
  baseline incompatibility. This stage accepts only empty client MCP lists,
  uses platform Runtime MCP and does not claim complete v1 conformance. Applicable
  stable capabilities remain implementation targets even when optional or
  currently unadvertised; only explicit architecture/stability/SDK decisions
  remove or defer an item.
- `scripts/stage3-workspace-client.mjs` tests v1 prompt and load on the same
  connection. That is not reconnect or process-restart evidence.
- Agent Controller already checks Identity at Run admission. The absence of
  cross-service Identity event delivery does not by itself prove an access
  control defect. Do not add an event bus to solve a check that already exists.
- Stage 3 Jaeger assertions cover lifecycle admission/worker phases and managed
  MCP execution. They do not yet produce the required identity, management,
  and usage three-flow verification report.
- The bounded C5-03 CPU investigation below identifies health-probe overhead and
  verifies reduced Runtime probe frequency. Sustained 100% service CPU was not
  reproduced; this is not a blanket claim that all historical spikes are solved.

The ACP service's [protocol matrix](../services/agent-acp-service/docs/protocol-conformance.md)
continues to distinguish implemented behavior, layer coverage, missing tests,
and product gaps. Keep that distinction when closing tasks here.

### Closeout Reconciliation After Managed MCP

The managed MCP feature, including its Console editor, is complete at the
inspection baseline. It does not replace C1-C6. The following are evidence
boundaries verified by source inspection, not new test-run results:

| Item | What exists | What is still open |
| --- | --- | --- |
| Stdio MCP | Template-owned configuration starts children inside Runtime; ACP discovers/calls their aggregated HTTP tools; Console and Docker evidence exists | Client-supplied ACP stdio remains unsupported. Keep the stable-v1 baseline incompatibility visible; do not launch commands on the ACP host or silently turn Session input into Template configuration |
| Session recovery | v1 real WebSocket/PostgreSQL reconnect and application-recreation cases; application recovery unit tests | Actual ACP process interruption with completed and in-flight work, both protocol versions, admission settlement and replay without repeated effects through Edge |
| Access isolation | v1/v2 Gateway integration with two real users, three Agents and owner deactivation on an existing connection; service tests for revision changes | Real-platform access-revision change and browser-session revocation semantics; OIDC/SCIM flows remain separate |
| Identity events | Transactional revocation feed, atomic owner authorization, durable consumer, and Docker/Jaeger offboarding acceptance | Uncertain Runtime stays fenced/pending; mid-Disable crash injection is outside this happy-path acceptance |
| Documentation and operations | Current Stage 3 entry and MCP feature evidence | Remove stale current-status wording, exercise restore/cleanup, measure the reported idle CPU spikes, and produce the final three-flow Jaeger report |

## 3. Ordered Delivery Checklist

Use `doc -> test -> code -> acceptance` for each bounded change. Work on one
functional gap at a time. Implement tracing propagation with its owning flow;
the last milestone aggregates evidence rather than retrofitting instrumentation.
Only mark a milestone accepted when its stated executable evidence passes.

### Service-Owned Execution Order

Keep the milestones below as the acceptance authority; this is their delivery
order, not a second checklist:

1. **Agent ACP Service:** reconcile the pinned v1/v2 matrix and fill wire and
   owned-PostgreSQL gaps, including unsupported MCP rejection and recovery.
   Record real-platform dependencies still needed instead of marking them done.
2. **Edge Gateway:** close any demonstrated forwarding or identity-boundary
   defects with its own tests. Then an integration-only batch proves ACP
   isolation, reconnect, actual process interruption, and trace causality on
   disposable Docker resources.
3. **Identity Service:** complete the local/OIDC/SCIM access cases and decide
   the business requirement for journal delivery. If downstream lifecycle work
   is required, define the owner contract and implement the producer here first.
4. **Agent Controller:** separately implement any required Identity consumer
   and its idempotent business effect. Preserve authoritative admission checks;
   event delay must not grant access. Then integrate the two services through
   Edge, including existing connections. A generic event bus remains deferred.
5. **Agent UI or Admin Console:** fix demonstrated feedback gaps in separate
   service batches; retain reusable component tests before browser acceptance.
6. **Operations and final integration:** update current runbooks, measure CPU,
   exercise restart/backup/restore/cleanup, and aggregate C1-C5 into C6. Run
   resource-intensive checks serially; do not start deferred services.

An accepted implementation batch does not accept a milestone whose required
integration evidence is still missing. Identity event delivery is neither
silently waived nor introduced just to make the topology look complete.

### 1. ACP Protocol And Durable Session Closure (C1)

- [x] **C1-01** Reconcile stable v1 and draft v2 separately against the pinned
  official SDK schemas. Enumerate baseline requirements, advertised options,
  unsupported options, exact external routes, and their executable tests.
  Reconciled on 2026-09-10 against SDK 1.4.0 and the F01-F10 implementation.
  The protocol matrix separately names approved exclusions, implemented
  capabilities and remaining test combinations; an absent capability flag is
  not grounds for waiving an applicable requirement.
- [x] **C1-02** Restrict ACP input to `mcpServers: []` on both versions.
  All client HTTP/stdio/SSE/MCP-over-ACP inputs are explicitly rejected with no
  partial writes, activation, replay or execution. No client MCP capability is
  advertised. Platform-owned Runtime MCP and managed stdio hosting remain.
  The 2026-09-08 product decision supersedes the earlier HTTP-only input profile;
  all client injection support and its future administrator authorization are
  deferred, not only the client proxy. The mandatory v1 stdio incompatibility
  remains documented. The [trust policy](../services/agent-acp-service/docs/client-mcp-policy.md)
  distinguishes administrator-owned configuration from client-supplied tools.
  Service evidence and exact
  dependency boundaries are in the
  [protocol matrix](../services/agent-acp-service/docs/protocol-conformance.md).
- [x] **C1-03** Exercise both versions over real WebSockets and PostgreSQL:
  new, prompt, user/assistant/Tool history, version-specific completion,
  reconnect, load/resume, list, and the advertised lifecycle operations.
- [x] **C1-04** Prove cross-user/Agent isolation, access revision invalidation,
  semantic cancel, and honest error/capability behavior at the wire boundary.
- [x] **C1-05** Verify service restart recovery and explicit Agent rebuild:
  durable history survives, replay never invokes model/Tools, Run A keeps its
  captured Runtime, and Run B receives the published replacement. Interrupted
  in-flight Tool effects remain distinct from replaying completed history.
- [x] **C1-06** Propagate Gateway-origin request context through ACP admission,
  model requests, and Runtime MCP. Preserve standard ACP payloads; do not add
  private Agent-routing fields to the protocol.

**Milestone C1:** the declared platform-only ACP profile has no unacknowledged
baseline or advertised-capability gaps. Reusable wire/persistence tests pass separately for
v1 and v2; the protocol matrix names exactly which real dependencies each test
uses. Adapter stubs must not be described as full-platform acceptance.

### 2. Identity And Effective Access Closure (C2)

- [x] **C2-01** Test local bootstrap/login/logout/password rotation, expired or
  revoked sessions, member versus administrator surfaces, and organization
  isolation through Edge rather than only through Identity RPC.
  The dedicated HTTP access profile covers scoped directory/SCIM access,
  same-email users, shared-User organization roles and token/Membership/User
  invalidation. Console password-command 401 classification is now covered by
  BFF, API/App and real-token-expiry tests. The separate Agent access profile
  now verifies scoped catalogs, lifecycle commands, workspace and v1/v2 ACP
  entry, history and Membership revocation with the same User in two
  organizations. See the Agent Organization Access batch below for evidence
  and the fixed lifecycle error-disclosure defect. Live-browser acceptance
  remains part of C4/C6, not this protocol integration milestone.
- [x] **C2-02** Exercise OIDC discovery/start/callback/login using a controlled
  IdP fixture with real redirect and token exchange. Confirm SCIM/local
  provisioned identities converge on the same User/Membership. Provider secrets,
  PKCE verifiers and Provider tokens must not reach browser responses, logs or
  traces; the application session belongs only in an HttpOnly cookie, not
  JavaScript-accessible storage. Accepted for the controlled HTTP workflow by
  the [Gateway OIDC suite](../scripts/identity-closeout/README.md), not as vendor
  IdP UI/browser acceptance or a claim that all of C2 is closed.
- [x] **C2-03** Exercise Gateway SCIM discovery, User/Group create/update,
  membership changes, deactivate/reactivate, deletion, and token rotation/revoke
  within the supported SCIM profile. Do not advertise unsupported SCIM features.
  Accepted for this workflow scope by the
  [Gateway identity suite](../scripts/identity-closeout/README.md): real HTTP,
  Identity-owned PostgreSQL, Console projections and Jaeger parent chains.
  This does not accept OIDC convergence or cross-organization isolation.
- [x] **C2-04** Verify deactivation after a user has connected: existing HTTP
  credentials and ACP connections cannot authorize a new Run or bypass owner
  checks. Define and test the treatment of an already-admitted Run separately;
  do not claim admission revocation retroactively cancels it.
  Edge now revalidates the originating browser token after assembling each
  client WebSocket message and before forwarding it; ACP still owns Agent
  identity/revision and Session authorization. This is message admission, not
  atomic revocation of ACP Run creation: overlapping checks can admit work.
  Accepted by the HTTP access, ACP closeout and separate ACP session fault
  profiles: real logout, owner deactivation, natural token expiry and Identity
  outage/recovery reject new messages; browser logout/disconnect does not cancel
  already-running work. The latter does not promise continuation after owner
  deactivation or failures inside Run dependencies. No event bus is needed.
- [x] **C2-05** Consume transactional owner revocations with the narrow
  owner RPC/cursor and idempotent consumer; authorization continues to use
  authoritative Identity checks. Do not automatically delete an Agent or its
  workspace merely because its owner is disabled.
  Decision confirmed: identity deactivation must disable associated Agents and
  Runtime while retaining data; restoration does not automatically enable them.
  Delivery follows the [revocation contract](../contracts/identity/principal-revocations.md)
  in Identity producer, Controller consumer, then integration batches.
  Identity, Controller and the cross-service integration batches are complete.
  Docker acceptance covers scoped/global/SCIM offboarding, offline consumer
  catch-up, retained workspace/history, explicit reauthorization and new ACP
  Runs. Source Gateway traces connect to every Disable phase and mutating RPC.
  See the C2-05 assessment below. Access revocation is not a substitute for
  the whitepaper's automatic Agent freeze and delegated-credential recovery.

**Milestone C2:** an actual local or OIDC user can reach the correct application,
SCIM changes have tested effective access semantics, and administrator versus
member boundaries hold across both new and already-open connections. Record
the journal-consumption decision with its business reason, not just a checkbox
for having event delivery.

### 3. Agent Control Workflow Closure (C3)

- [x] **C3-01** Verify empty instance -> model -> Template -> active owner ->
  Agent -> ready Runtime, using only the administrator's Gateway entrypoints.
- [x] **C3-02** Cover create, rebuild, disable, enable, and delete with durable
  operation status, actionable failure cause, event recovery, and UI feedback.
  Accepted `202` is never presented as a completed build.
- [x] **C3-03** Verify immutable configuration and workspace behavior: revision
  publication does not silently rebuild existing Agents; explicit rebuild
  blocks new Runs; disable retains the workspace; delete follows the documented
  removal/retention contract.
- [x] **C3-04** Exercise Egress policy changes and Runtime-start failures without
  introducing a new deployment platform, MCP proxy, or rollout mechanism.
- [x] **C3-05** Check restart recovery of the single lifecycle worker and event
  replay from its authoritative cursor. Duplicate requests must not create a
  second Agent, Runtime, or lifecycle effect.

Delivery batches keep each service change separate from deployed acceptance:

1. **Console lifecycle evidence (service batch passed, 2026-09-10):** exercise real page recovery
   handlers, accepted-to-terminal presentation, and BFF operation/event/command
   contracts. Preserve the global event cursor, including `Last-Event-ID`
   precedence on Watch reconnect. These component tests do not prove Docker
   effects or worker restart recovery.
2. **Network management entry (Egress, Controller and Console service batches passed, 2026-09-10):**
   Console now provides an independent Agent network-policy section and scoped
   GET/PUT BFF routes (contract revision 36). Egress exact policy reads
   are implemented (contract revision 4). Organization-scoped Agent Controller
   read/CAS commands are implemented (control contract revision 16). GET/CAS,
   exact retry, stale conflicting change and disabled attachment behavior passed
   isolated Docker integration; real TUN packet behavior is verified in batch 10.
   No policy copy in AgentSpec, Runtime generation update, new table,
   or lifecycle side effect. Do not count lifecycle fencing as user-controlled
   policy management. Egress assignment GET is desired state only; errors must
   not be cleared by pretending this proves packet-gate application.
3. **Docker integration (foundation passed, 2026-09-10):** independent
   [lifecycle profile](../scripts/lifecycle-closeout/README.md), invoked with
   `make e2e-lifecycle`. The initial batch closes C3-01 and adds deployed
   evidence for C3-02..05, without claiming their remaining fault scenarios.
4. **Runtime-start failure ownership (Runtime Controller service batch passed,
   2026-09-10):** control contract revision 7 retains a non-executable `failed`
   Environment after definitive Initialize failure. Readiness expiry after
   confirmed creation is terminal with `runtime_not_ready`; cancellation,
   identity drift and unknown effects retain the original mutation slot.
   CAS Delete of the retained revision removes compute before workspace.
   Agent Controller consumption and deployed failure/cleanup acceptance are
   recorded below. This producer batch alone does not close C3-02/04.
5. **Failed Agent cleanup (Agent Controller service batch passed, 2026-09-10):**
   consume Runtime Controller failure/unknown results, leave admission local,
   and resolve unpublished Runtime ownership during `network_fence`. Freeze
   the authoritative revision/proof with phase and child key before deletion.
   No new phase, table or RPC route; PostgreSQL migration 6 updates the source
   constraint without editing earlier migration checksums. Physical Docker
   cleanup and the cross-service trace chain are verified in the following batch.
6. **Runtime-start failure integration (passed, 2026-09-10):** a required
   nonexistent managed MCP executable fails in an actually created Runtime.
   Gateway exposes the terminal failure, and business Delete removes the owned
   compute/workspace before teardown. Exact replay, idle restart, retained
   terminal events and Jaeger failure/cleanup causality passed. This closes the
   deployed startup-failure subcase, not all remaining C3 work.
7. **Active Run and explicit rebuild (passed, 2026-09-10):** a real ACP v1
   Runtime bash is held across a nonterminal `drain` and clean Agent Controller
   stop/start. New Run admission is denied before and after restart; the held
   Run completes before compute replacement. The same ACP Session loads on a
   fresh connection, reads preserved workspace effects through the new Runtime,
   and uses revised guidance plus the environment-change notice. This closes
   C3-03 and the graceful-drain subcase of C3-05, not interrupted physical
   effects or SIGKILL recovery.
8. **Interrupted Update convergence (Runtime Controller service batch passed,
   2026-09-10):** reproduce existing-target retry and post-effect persistence
   failures; reconcile physical source/target identity without allocating new
   claims. Reject foreign targets and retain uncertainty after source removal.
   A definitive source deletion rejection requires fresh source readiness proof
   before restoring the source. The following integration batch verifies this
   producer correction under an actual interrupted physical update.
9. **Interrupted Update Docker integration (passed, 2026-09-10):** hold the new
   Runtime at a test-only startup barrier, freeze the caller and SIGKILL both
   Controllers. Frozen post-kill journals prove the same nonterminal attempt;
   natural lease expiry recovers the exact existing target. Exactly one new
   execution publication and one Runtime updated event; replay repeats no effect.
   Only the precisely captured killed attempt lacks an exported span. Together
   with cursor replay and graceful-drain evidence above, this closes C3-05.
10. **Runtime network policy integration (passed, 2026-09-10):** a separate disposable
    profile drives actual ACP Runtime tools through allow/deny/allow, established
    connection revocation and per-Agent isolation. A local target behind test-only
    Egress DNAT removes public-network availability as a dependency without
    bypassing the Rust policy, TUN or kernel path. No production policy change.
   Together with startup-failure evidence above, this closes C3-04.
11. **Console lifecycle browser closure (passed, 2026-09-10):** align unavailable-Agent
    cleanup with the Controller's existing Delete contract; retain failure code
    and phase without advertising unsupported rebuild. Add reusable page
    regressions before deployed create/rebuild/disable/enable/delete, refresh and
    stream-recovery browser acceptance. Keep operation progress independent of
    a stale Agent projection, preserve terminal results against late admission,
    and refresh authority after event replay. Browser-discovered unavailable and
    deleted-state descriptions are corrected. This Console-owned batch closes
    C3-02; no new lifecycle operation or backend state is introduced.

Lifecycle foundation final evidence:

| Check | Final result |
| --- | --- |
| Empty-instance business path | Gateway login -> active member -> model -> immutable Template -> available Agent and physically healthy Runtime |
| Lifecycle and idempotency | Seven terminal operations across two Agents; five lifecycle kinds. Exact key/body replay before and after Controller restart preserves operation identity and physical resources |
| Workspace and configuration | Publishing Template revision 2 leaves the original Agent/container unchanged. Explicit rebuild adopts revision 2; rebuild and disable/enable preserve exact sentinel bytes. Delete removes compute and workspace before test teardown, hides inventory and retains audit records |
| Network management | Two real Gateway/BFF/Controller/Egress assignment CAS changes, exact replay and stale conflicting update. No Runtime replacement; disabled attachment stays closed. No claim about TUN traffic |
| Events and idle recovery | Ten primary-Agent events; another Agent creates global-sequence gaps. Disconnect Watch, page List at limit 2, resume using Last-Event-ID over the stale URL, then restart the idle Controller: replayed journal and terminal commands remain unchanged |
| Jaeger | Five Gateway -> Console -> Controller admission traces, plus 21 worker phase traces (3/5/4/4/5). Exact Agent/request/kind, admission links, predecessor links, downstream ancestry and final completed state verified |
| Reusable collector checks | 23 fixture tests passed, including disconnected spans, missing predecessor/terminal state, wrong Agent, malformed cursors and failed Docker inventory. No raw trace/coverage artifacts retained |
| Admission | `make -j1 fmt-check lint` passed: Go 0 issues, both Rust Clippy gates, ACP lint/typecheck and both frontend typechecks |
| Resource isolation | Fresh Compose project, service-owned databases on one Postgres. Own creators stopped before cleanup; no test-owned containers, volumes or networks remain. Retained development instances untouched |

Runtime-start failure integration final evidence:

| Check | Final result |
| --- | --- |
| Fresh deployment | Latest Stage 3 images, isolated `antnest-lifecycle-1a6bdec4`, synthetic identities/model configuration, one Postgres with service-owned databases; no external Provider calls |
| Lifecycle regression | Nine terminal operations across three Agents. Normal create/rebuild/disable/enable/delete, immutable configuration, workspace sentinel persistence, network CAS and global event cursors still passed |
| Actual startup failure | Required `missing-mcp` cannot initialize. Owned-container JSON diagnostics match Agent and generation with `managed_mcp_start_failed`. Gateway operation is failed at `runtime_initialize`, code `runtime_not_ready`, with configuration/MCP guidance; Agent is unavailable with no executable binding |
| Resource and audit retention | Failed container and allocated workspace are independently present before Delete. Gateway Delete removes both before teardown, hides the Agent, retains exact requested/failure/deletion events and the failed operation. Exact-key retries before/after idle restart change neither resources nor event history |
| Jaeger | Seven exact Gateway -> Console -> Controller admission chains and 28 worker phase traces (3/5/4/4/5/2/5). Failure prefix/terminal state, failed Runtime RPC, successful journal read, persistence classification, and successful ownership-inspect/delete RPC ancestry are checked |
| Production correction | Agent Controller `fail_agent_create` now uses the existing failure observation helper for phase/code. Real exported-span regression verifies classification without copying diagnostic secrets; no lifecycle semantics, table, or RPC contract changed |
| Reusable verification | 59 script fixture tests pass, including missing/duplicate terminal events, unrelated startup logs, false success, failed ownership lookup, detached delete, missing journal and broken causal links. Agent Controller race regression and repository formatting/lint gates pass |
| Review and cleanup | Read-only review findings fixed and re-reviewed with no remaining scoped blockers. All verification serial; reviewer closed after each report, disposable resources removed. No raw log/trace artifacts retained; existing development stacks untouched |

Only the completed final run is acceptance evidence; the initial assertion
failure was discarded and its isolated resources cleaned. Startup timeout
diagnostics identify the failing stage and configuration to inspect; the owned
Runtime log independently establishes the intended missing-MCP cause. This
does not claim browser acceptance or nonterminal crash recovery.

Active Run/rebuild integration final evidence:

| Check | Final result |
| --- | --- |
| Deployment | Isolated `antnest-lifecycle-cd45ac24`, current Stage 3 images and a local deterministic model. No external Provider, production fault flag or database edits |
| Active execution barrier | Real Runtime bash writes the first workspace effect and remains alive. Rebuild stays `running/drain` with the original binding/container, open attachment and no release file. Two prompts in another Session are rejected as `agent_rebuilding`, without model execution |
| Nonterminal restart | Stop only Agent Controller; inspect exit code 0, no OOM/error and completed shutdown, then start the same container and verify new process start time/health. Old Runtime, shell PID, pending Run, configuration and rebuild request identity remain unchanged |
| Rebuild and Session continuation | Release the barrier, observe successful Run/closed admission, then exactly one replacement Runtime. Reconnect and load the original Session ID; next Run sees revision 2 and the environment-rebuild notice. Real `read` returns exactly `held\nfinished\n`, with no repeated bash side effect |
| Regression | Nine terminal lifecycle operations across three Agents; immutable publication, disable/enable workspace retention, business deletion before teardown, startup failure, exact request/event replay, network CAS and idle recovery all pass |
| Jaeger | Two completed Run traces (253/175 spans), one real bash/read dispatch each, fresh Runtime information/catalog and successful acquire/finish admission. Model and Runtime tools descend from the same ACP Run and Gateway. Seven lifecycle admission chains plus 30 phase traces (3/7/4/4/5/2/5) preserve admission/predecessor links across the worker restart |
| Reusable evidence | 96 fixture tests pass. Negative cases reject detached model spans, foreign-trace parents, wrong Run, missing admission completion, masked dead shells, forced/unclean exit and duplicate effects. Close WebSockets before checking completed Gateway spans |
| Admission | `make -j1 fmt-check lint` passed: Go 0 issues, both Rust Clippy gates, ACP ESLint/typecheck and both frontend typechecks. `git diff --check` and 36 local links in the two batch documents pass |
| Review and scope | Four read-only review findings corrected and re-reviewed without remaining scoped findings. Tests/documentation only in this batch; no service implementation, schema or external protocol change |
| Cleanup | Final profile reports verified removal of all test-owned containers, volumes and networks. Independent exact-label inspection confirms zero resources for all three attempted profiles; no lifecycle test/lint processes remain. Failed preliminary profiles discarded; retained development stacks untouched |

Console lifecycle final evidence (2026-09-10):

| Check | Final result |
| --- | --- |
| Deployed browser scope | Chrome on disposable `antnest-lifecycle-48ceae32`, local model fixture and synthetic administrator/member. Five lifecycle kinds submitted from Console, plus real required-MCP startup failure and its Delete. No external Provider or retained development instance mutation |
| Admission and terminal feedback | Each request shows running progress and closes lifecycle actions before settlement. Delete shows Removing until deleted, then Removed and read-only audit detail. Failed construction retains phase, code and diagnostic detail after reload and offers Delete without unsupported rebuild/enable/disable |
| Recovery | Page reload recovers durable operation history. Actual Controller stop shows resyncing and separate read errors with mutation actions closed; restart restores live state, clears errors, preserves events and does not create another lifecycle request |
| Reusable regressions | `npm --prefix services/admin-console/web test`: 94 logic tests and 187 component tests pass. Deferred responses cover replay/read ordering, terminal-before-202, operation-read-before-202 with Agent-read failure, accepted running progress after failed refresh, cleanup without a published Runtime and terminal-state descriptions |
| Business records and physical effects | Independent Gateway reads confirm seven terminal operations and fourteen unique events across two retained Agents. Current inventory is empty; deleted inventory exposes both records. Exact Agent/scope Docker checks confirm both compute and workspace absent before fixture teardown |
| Jaeger | All seven browser admission chains have Gateway -> Console -> Controller ancestry. Twenty-eight worker phase traces (3/4/4/5/5/2/5) pass the existing lifecycle inspector, including admission/predecessor links and failed-start cleanup. No per-packet tracing introduced |
| Admission and review | `make -j1 fmt-check lint` passes, including Go 0 issues, both Rust Clippy checks and all configured JS/type checks. Independent read-only review findings are covered by regressions; reviewers closed. Final Console image `2aeffbe12e1b` built and healthy; screenshot inspection confirms diagnostics fit their layout |
| Cleanup | Test tab closed. Exact-scope cleanup reports zero containers, volumes and networks for this project. Existing development stacks remain untouched. Temporary Compose network-parameter omission was corrected using the fixture's actual networks, not by changing deployment networking |

C3 is accepted. The next service-owned batch is C4 Agent WebUI usage; C5/C6
operations and final cross-flow acceptance remain open.

Runtime network integration final evidence (2026-09-10):

| Check | Final result |
| --- | --- |
| Reproducible scope | `make e2e-lifecycle-network`; isolated `antnest-lifecycle-a923be4a`. Two Agents, actual ACP v1 Runtime bash as UID/GID 1000, local deterministic model and TCP target. No external Provider, production code or database edits |
| Real packet path | Six completed probes traverse Runtime TUN and Egress policy/kernel path. Disposable Egress-only DNAT reaches the local target; a separate fail-closed guard prevents the synthetic public destination escaping when translation is absent. This does not claim public Internet reachability |
| Live policy | Allow -> deny -> allow without Runtime replacement. Fresh denied TCP and private-address probes receive explicit rejection in under 1ms in this run; timeout is never accepted as rejection. Exactly five authorized target requests |
| Existing connections and isolation | After deny ACK, A's original conntrack is absent, B's original established tuple remains. A cannot receive the target's pushed data and its next send is rejected. B receives its push and continues on the original socket, including after a stale conflicting policy request |
| DNS and retained state | A's configured resolver rejects TCP while B resolves successfully under the same deny interval. Runtime ID, generation/configuration, process start, restart count, mounts, workspace sentinel and executable binding remain unchanged across policy changes and exact replay |
| Jaeger | Six Gateway-rooted Run traces, 183 spans each; fresh Runtime info/catalog, exactly one real bash dispatch and correlated released/completed/settled admission each. Four Gateway -> Console -> Agent Controller -> Egress policy-write traces, 10 spans each. No packet-level OTLP |
| Export and deletion | Both Agents deleted through Gateway before teardown; exact Runtime die/stop/destroy events prove one clean exit each, no OOM/SIGKILL. Seven remaining trace-producing services exit cleanly before final collection |
| Reusable checks | 207 lifecycle/shared MCP fixture tests pass, including peer TCP reset, DNS timeout misclassification, foreign admission, incomplete shutdown, cancellation, malformed HTTP status and wrong trace ancestry. Only compact final metrics are retained |
| Admission | `make -j1 fmt-check lint` passes: Go 0 issues, both Rust Clippy gates, ACP ESLint/typecheck and both frontend typechecks. Read-only review findings have corresponding coordinator fixes and regression assertions |
| Cleanup | Final profile and independent exact-label inspection verify zero test-owned containers, volumes and networks across all four attempted projects. No test/lint processes remain. Failed preliminary results discarded; retained development instances untouched |

Runtime Controller Update recovery service evidence (2026-09-10):

| Check | Final result |
| --- | --- |
| Reproduced defect | Strict single-container tests reproduced target-created response loss, unready target and completion-write loss turning into `failed/not_started` and restoring a destroyed source |
| Corrected model | Observe exact source/present target/explicit absence before replacement. Existing exact target goes through idempotent Create plus workspace and Runtime readiness checks; no new generation or operation journal phase |
| Failure boundaries | Foreign scope/generation/digest, malformed observation, unreadable platform, missing/foreign workspace, earlier stopped source and Inspect/Delete identity changes remain unknown without publishing/restoring unproven state |
| Retained source and reply | Only a definitive source-delete rejection plus fresh healthy source/status proof can restore source. A prior Unknown target inspection is cleared from the return, stored operation and terminal replay |
| Reusable regression | All 12 test-bearing Runtime Controller packages pass with race detection, including real Docker-driver workspace checks. Both completion-before-commit and committed-response-loss paths preserve exact effects and a single completion event |
| PostgreSQL | Independent ephemeral Postgres; running/unknown recovery preserves source/target claims, opaque revision and operation owner. Attempt fencing rejects stale restoration; head/event completion is atomic and duplicate completion rejected. Two claims and one Update event remain |
| Admission/review | Final repository formatting/lint gates passed: Go 0 issues, both Rust Clippy gates, ACP and frontend checks. Read-only findings corrected and re-reviewed; no new RPC, table or migration in this batch |
| Scope/cleanup | Test Postgres uses tmpfs and was removed; exact-label inventory confirms no remaining container. No retained development stack changed. Strong physical-interruption Docker/Jaeger evidence remains a separate integration batch |

Interrupted Update integration final evidence (2026-09-10):

| Check | Final result |
| --- | --- |
| Reproducible profile | `make e2e-lifecycle-interrupted`; final isolated project `antnest-lifecycle-4e4e0e1a`. Derived test image executes the unchanged Runtime after its workspace barrier; no production fault flag, external Provider or database edits |
| Crash and recovery | Both Controller containers exit 137 without OOM. Post-kill journals retain original parent attempt/lease/traceparent and running child. Both Controllers restart before the real 175s lease expires; the old claim is not overtaken |
| Exact effects | Same child request, target revision/generation/digest, physical container and workspace after recovery. Two total execution publications and generation claims (initial + replacement), one Runtime updated observation, one Agent rebuilt event. Internal binding matches actual Runtime `/status`; Console need not expose internal execution identity |
| Replay and deletion | Exact Gateway request replay preserves target, attempt, counts and full event history. Gateway Delete removes compute and workspace before teardown |
| Jaeger | Three Gateway admissions; create/delete have 3/5 fully linked phase traces. Rebuild reaches attempt 6 with 5 exported phase roots; only frozen killed attempt 3 is missing. The recovered update RPC uses its original child request and Runtime server ancestry; all surviving roots link to exact admission and predecessor, including the killed root |
| Admission/review | 141 lifecycle fixture tests pass, including stale killed identities, pre-kill RPC substitution, cancellation and cleanup failures. Repository fmt/lint gates pass (Go 0 issues, both Rust Clippy gates, ACP lint/typecheck and both frontend typechecks). Read-only findings corrected and re-reviewed; reviewers closed |
| Cleanup and scope | Profile verifies removal of owned containers, volumes, networks and both temporary image tags. Preliminary failed runs discarded. Integration fixtures/docs only; retained development instances unchanged |

The stricter ordinary lifecycle trace oracle remains unchanged. Process termination
can lose an unexported span; the fault oracle permits exactly the durable captured
tuple, never an arbitrary missing attempt or a missing recovered Runtime call.

The foundation profile changed tests/documentation only. The startup-failure
integration additionally corrected one Agent Controller telemetry wrapper.
No schema, Provider call or retained development stack changed in that batch.

Runtime Controller failure batch final evidence (not deployed C3-02/04 acceptance):

| Check | Final result |
| --- | --- |
| Owned lifecycle | Definite compute rejection retains failed ownership; exact retry has no effects, fresh Initialize and stale Delete are rejected, current-revision Delete removes compute/workspace through the platform port |
| Uncertain execution | Direct/wrapped platform identity conflicts and cancellation after compute creation retain the mutation slot and block a competing Delete; bounded readiness failure remains distinct |
| Persistence | Isolated real Postgres, migration 4: both failed/not_started and failed/completed retain matching head/revision/generation claim, release the terminal slot, and permit CAS Delete to a tombstone |
| Regression | All 12 test-bearing Runtime Controller packages passed with `-race`; overall statement coverage 64.5%, control 66.9%, Postgres 66.8%, readiness-failure classification 100% |
| Contract and admission | Stable `runtime_not_ready` HTTP 500/non-retryable regression passed; `make -j1 fmt-check lint` passed with Go 0 issues, both Rust Clippy gates, ACP lint/typecheck and both frontend typechecks |
| Review and limits | Independent read-only review found no blocking producer defect. No claim of historical migration-3 orphan recovery, consumer compatibility, physical failure cleanup E2E or new Jaeger evidence |

Only Runtime Controller implementation and its contract/docs/tests changed in
this batch. The raw coverage profile and test-owned Postgres container/volume
are temporary; retain only these final metrics. Development stacks and their
data are not upgraded by this service batch.

Agent Controller failure batch final evidence (not deployed C3-02/04 acceptance):

| Check | Final result |
| --- | --- |
| Failure consumption | Real HTTP decoder tests consume exact recorded failed/not_started and failed/completed results; unknown/completed stays nonterminal. Missing/unavailable/foreign journals and conflicting keys cannot fabricate completion |
| Cleanup orchestration | Admission does no Runtime RPC and creates no fabricated absence proof. Worker freezes the failed Runtime revision before Delete; restart/retry retains revision and child key. Foreign identity is rejected; transitional ownership remains pending |
| Durable source and barrier | Real isolated Postgres covers failed ownership, authoritative not-found and deleted proofs, phase/source atomic persistence and replay, and rejection of stale source writes. Network-release absence explicitly clears a prior closed attachment instead of blocking publication |
| Degraded ownership | ready/unhealthy and disabled/unhealthy remain inspectable through the HTTP client for cleanup, but cannot satisfy executable publication. Independent review exposed this gap; regression and scoped re-review closed it |
| Regression | All 13 test-bearing service packages passed with `-race` and the Postgres profile enabled. Overall statements 71.0%; application 76.5%, Postgres 67.7%, Runtime client 84.5%; unready-result classification 100%, journal reader 87.5% |
| Admission and scope | `make -j1 fmt-check lint` and diff/document checks passed. No external Provider, retained-stack upgrade, historical pseudo-proof repair, or new physical Docker/Jaeger acceptance is claimed |

The temporary database and coverage profile are removed after verification.
Reviewers only read code and were closed; all executable verification ran
serially under the coordinator. Only compact final metrics are retained.

Console batch final evidence (not full C3 acceptance):

| Check | Final result |
| --- | --- |
| Defect reproduced then fixed | Watch ignored `Last-Event-ID`; now uses it over the old URL cursor and rejects malformed/repeated headers |
| New BFF contract scenarios | 18: five command retry identities across handler replacement/organization, operation evidence, List/Watch envelope and global cursor |
| Frontend regression | 88 unit tests and 166 component tests passed; nine new recovery cases plus expanded create/four-action terminal chains |
| Console Go tests | Five test-bearing packages passed; overall statement coverage 69.8%, server 82.4%, changed Watch handler/cursor functions 100% |
| Admission | `make -j1 fmt-check lint` passed, Go lint 0 issues; docs links and whitespace checked |
| Independent review | Read-only review closed; explicit no-mutation ledger checks, mismatched event/operation timing, and private-field projection sentinels added |

Sources: [BFF tests](../services/admin-console/internal/server/lifecycle_contract_test.go),
[recovery components](../services/admin-console/web/src/pages/agent-event-recovery.test.tsx),
[lifecycle components](../services/admin-console/web/src/pages/agent-mutations.test.tsx),
and [service recovery contract](../services/admin-console/docs/operations.md#lifecycle-recovery).
No Docker stack, browser, external Provider or Jaeger acceptance was run in this
service batch. This component evidence alone does not close C3; the deployed
foundation and outstanding fault batches supply separate evidence. Raw coverage output is temporary,
not an additional repository artifact.

Egress batch final evidence (not deployed C3-04 acceptance):

| Check | Final result |
| --- | --- |
| Policy read | Exact immutable revision/spec/digest; opaque built-in IDs; no new network, assignment, table, generation or traffic side effect |
| Cleanup defect | Ensure and same-state open could bypass a failed cleanup fence; now cleanup must complete before reopening, with six recovery scenarios and actual allow/deny packet decisions |
| Regression | 94 host tests passed; six real PostgreSQL tests passed, including exact HTTP policy reads after reconnect without changing the assignment |
| Control tracing | Success, missing revision and invalid path preserve W3C parent and outcome; process-isolated exporter test avoids shared tracing state interference |
| Linux build | Image built; container-side format, Clippy, 95 tests (one additional Linux-only test) and release compilation passed |
| Admission | `make -j1 fmt-check lint` passed; Go lint 0 issues and both Rust Clippy profiles clean |
| Independent review | Read-only reviewers closed; malformed UTF-8 paths now use stable JSON errors; failed allow cannot replace persisted deny on recovery |

Sources: [HTTP contract tests](../services/runtime-egress/tests/control_http.rs),
[recovery tests](../services/runtime-egress/tests/control_service.rs),
[trace test](../services/runtime-egress/tests/control_trace.rs),
and [PostgreSQL tests](../services/runtime-egress/tests/postgres_repository.rs).
The six PostgreSQL cases use their separate database profile, not an ignored-test
pass claim. Test-owned PostgreSQL container/volume/networks were removed; existing
development stacks were not replaced. This batch does not prove Console policy
switches, cross-service Gateway/Jaeger ancestry or live TUN traffic; those remain
in the Console and deployed integration batches. No raw trace or
intermediate metric artifacts are added.

Controller network-policy batch final evidence (not deployed C3-04 acceptance):

| Check | Final result |
| --- | --- |
| Scope and ownership | Required organization; absent/foreign/deleting/deleted Agents rejected before Egress; disabled Agents can save desired policy without opening attachment or changing Agent/Runtime revisions |
| RPC contract | Revision 16; required production dependency, exact revision/spec/digest GET and single assignment CAS PUT; machine success/error schemas updated |
| Recovery semantics | No redirect, automatic retry, read repair or post-write read; response loss retains original CAS; conflict never rebases; desired GET does not certify live enforcement |
| Reusable regressions | 25 new top-level application/client/HTTP/trace tests, including table-driven scope, malformed response and error cases; full Controller module passed, including all 13 test-bearing packages under race |
| PostgreSQL | Real repository and HTTP lifecycle suites passed in the separate database profile; no new policy table or cross-service database access |
| Unit/component coverage | Application 76.6%, Egress client 86.2%, HTTP server 78.2%; new GET/PUT HTTP handlers and mutation observation 100%; PostgreSQL profile is separate from these coverage figures |
| Observability | Incoming parent -> Controller HTTP -> Egress client -> propagated header verified; GET third-call failures and PUT success/conflict/response loss retain bounded errors and audit fields; no packet tracing |
| Admission | `make -j1 fmt-check lint` passed, Go 0 issues, both Rust Clippy targets and frontend checks clean; documentation links and whitespace checked |
| Independent review | Two read-only rounds closed; attachment error decoding, response-body cancellation classification, per-client tracer lifetime and PUT audit assertions corrected and rechecked |

Sources: [service contract and sequence](../services/agent-controller/docs/network-policy.md),
[application tests](../services/agent-controller/internal/application/network_policy_test.go),
[wire tests](../services/agent-controller/internal/egressclient/network_policy_test.go),
[component tests](../services/agent-controller/internal/server/network_policy_flow_test.go),
and [trace/audit tests](../services/agent-controller/internal/server/network_policy_trace_test.go).
The dedicated PostgreSQL container, volume and networks were removed. This
batch did not rebuild retained development stacks or run browser, external
Provider, live TUN or deployed Gateway/Jaeger acceptance. The remaining shared
request-path variants (direct deadline expiry and attachment-body cancellation)
were not separately exercised; header/body cancellation is covered for assignment
GET and PUT. Console policy controls were pending at this producer handoff;
the following batch delivers them. Deployed evidence is tracked separately in
the lifecycle foundation and outstanding C3 integration batches above.
Only compact final metrics are retained; the raw coverage profile is temporary.

Console network-policy batch final evidence (not deployed C3-04 acceptance):

| Check | Final result |
| --- | --- |
| BFF boundary | Administrator-only GET/PUT; exact safe projection; action -> built-in revision 1; trusted organization/actor and expected-account precondition; one upstream command, no redirect or new persistence |
| Browser semantics | Confirmed desired policy, separate paused attachment, no optimistic success, original CAS/key retry, version conflict requires explicit fresh selection; disabled Agents can save without enabling |
| Recovery defects | Cross-tab account change, close/reopen recovery, overlapping pending requests, lifecycle invalidation during PUT, and offline GET failure followed by SSE reopen now have executable regressions |
| Frontend regression | 92 pure-function tests and 182 component cases passed, including 13 network-control cases and Agent-page recovery integration; production build/typecheck passed |
| HTTP evidence | Actual local HTTP BFF -> Controller fixture preserves incoming W3C parent -> server -> client -> outgoing header, single dispatch and private-field exclusion; not a deployed Gateway claim |
| Go regression and coverage | All five test-bearing Console packages passed under race; server statement coverage 83.7%, upstream client 59.0%; network principal check and read projection 100%. These are service unit/component metrics, not deployed integration coverage |
| Admission | Final `make -j1 fmt-check lint` passed: Go 0 issues, both Rust Clippy profiles clean, frontend type checks passed; five changed documentation link checks and whitespace check passed |
| Browser acceptance | Built Console at 1440x1000 and 360x800 with synthetic HTTP: save feedback, no duplicate dispatch, exact retry after tab close, stable 44px switch, no horizontal overflow and no page errors |
| Independent review | Two read-only reviewers closed; reported recovery gaps reproduced in failing tests, fixed, and rechecked; no reviewer executed tests or altered files |

Sources: [BFF scenarios](../services/admin-console/internal/server/network_policy_test.go),
[HTTP trace test](../services/admin-console/internal/server/network_policy_trace_test.go),
[network component](../services/admin-console/web/src/components/agent-network-policy.test.tsx),
[page recovery](../services/admin-console/web/src/pages/agent-event-recovery.test.tsx),
and [service contract](../services/admin-console/docs/network-policy.md).
This batch changes only Console implementation and its contract/docs. Retained
development stacks were not rebuilt. Separate C3 integration is required for real lifecycle,
workspace, TUN traffic and Gateway-rooted Jaeger integration. Browser previews
and temporary metric files are disposable, not additional evidence journals.

**Milestone C3:** each lifecycle command ends in a visible, authoritative
success or failure; the administrator can locate and correct ordinary Docker
configuration errors without reading a database or guessing hidden state.

### 4. Agent WebUI Usage Closure (C4)

**Deferred by user on 2026-09-11.** The five unchecked items below are retained
for the later client iteration and are not current stage blockers. Existing
component and server-side integration evidence remains valid within its scope;
none of it is promoted to browser acceptance by this deferral.

- [ ] **C4-01** Verify member login -> accessible Agent -> new/load Session ->
  prompt -> assistant/Tool updates -> completion through Edge and ACP.
- [ ] **C4-02** Cover supported file/image inputs and Tool result presentation,
  with capability-dependent rejection instead of silent acceptance or loss.
- [ ] **C4-03** Verify cancel, two Sessions contending for one Agent, page
  close/reopen, disconnection, and completion while offline. Input availability
  follows authoritative state and reconnect never resubmits a prompt implicitly.
- [ ] **C4-04** Verify explicit rebuild and identity revocation feedback in an
  already-open page; no private Runtime address or access subject reaches UI.
- [ ] **C4-05** Maintain component/browser-route regression tests for each fixed
  behavior, then perform desktop/mobile browser acceptance against the real
  stack. Browser screenshots supplement, not replace, executable regression tests.

**Milestone C4:** a user completes a multi-message conversation, observes Tool
activity, cancels work, and returns later without becoming permanently blocked
or seeing duplicate messages/effects. Admin Console and Agent UI retain their
separate roles and shared visual language.

#### C4 First Service Batch: Agent UI Conversation Recovery

Implemented in `services/agent-ui` only; C4-01..05 remain open until integration.
The unchanged boundaries are Gateway bootstrap and official ACP v1 SDK traffic.

- Stop targets the outstanding prompt's Session across sidebar navigation;
  stopping during attachment preparation prevents a later prompt from starting.
- Selected-history readiness gates input and Session configuration independently
  of WebSocket readiness. Failed loads offer retry; late unrelated loads do not
  unlock the composer.
- Prompt and replay cannot overlap within one Session on one connection. Cached
  text, attachments and Tool history survive failed replay, including reconnect;
  successful replay replaces them rather than appending a second history.
- Prompt settlement re-reads Gateway availability instead of assigning ready.
  Explicit workspace refresh disposes stale connection attempts, refreshes access,
  preserves current selection, reconnects and loads history without resubmission.
  Closing the page cannot start another bootstrap request.
- Two read-only adversarial reviews produced executable regression cases before
  fixes. The coordinator alone ran verification; both reviewers are closed.

Service regression: `npm --prefix services/agent-ui/web test` passes 39 unit
tests and 38 component tests (77 total, no skips). Component tests use the real
ACP SDK with a controlled WebSocket peer and cover delayed responses, replay
failure, cancellation, access refresh and connection disposal. They do not
substitute for actual Gateway/Docker acceptance.
`make -j1 fmt-check lint`, Agent UI production build, `git diff --check`, and
45 local link-target checks across the three changed Markdown documents pass.
Go lint reports 0 issues; both Rust Clippy checks pass with warnings denied.
Vite still reports upstream Zod annotation and >500 kB bundle advisories; these
are not claimed resolved. Final process inspection found no leftover test,
lint or build workers.

Remaining C4 work: authoritative cross-connection busy/lifecycle notification,
cancel/reopen while work continues, rebuild/revocation delivery in open pages,
and real Docker desktop/mobile browser + Gateway-rooted trace acceptance. This
batch did not rebuild retained development stacks or call external providers.

#### C4 Second Service Batch: Agent Controller State Observation

Implemented in `services/agent-controller` and its owned control contract only.
The new GET `/internal/workspace/agents/{agent_id}/state` and `/state/watch`
endpoints expose scoped current state, not another conversation protocol.
See [Workspace state](../services/agent-controller/docs/workspace-state.md).

- Snapshot fields are Agent ID, availability, access permission, Agent aggregate
  revision and the requesting principal's active Session ID. Credentials,
  executable configuration and another principal's Session are not disclosed.
- Lifecycle reservations and disabled intent now close workspace availability
  even while the previous stable lifecycle state is still `available`. Active
  work remains identifiable for cancellation during an authorized drain.
- Normal Run acquisition/release wakes the existing PostgreSQL listener via
  migration 0007. Rollback, idempotent replay and unchanged state do not emit a
  transition. There is no new table or normal-Run audit append.
- SSE subscribes before reading, emits full changed snapshots without replay
  IDs, and closes with a sanitized terminal snapshot on lost access. Writes
  have bounded deadlines; request cancellation and failed reads/subscriptions
  end the waiter. Notifications remain coalescible hints, not a journal.
- A read-only adversarial reviewer found no unresolved implementation defects;
  recommendations added read-race, write-failure and migration-upgrade tests.
  Verification runs only on the coordinator; the reviewer is closed.

Gateway consumption is implemented in the third service batch below, with
authenticated scope and bounded stream/identity leases. Agent UI consumption
and Docker/browser/Jaeger integration follow as separate batches. A retrying
shared LISTEN connection
does not promise bounded freshness; this producer alone does not close C4.
No retained development stack was rebuilt and no external Provider was called.

Final local evidence: all 13 Agent Controller packages pass `go test -race -p=1
./services/agent-controller/... -count=1` against a dedicated temporary
PostgreSQL test database: 402 top-level tests, 0 failures, 0 skips. This includes
HTTP/PostgreSQL component tests, JSON/SSE contracts, notification commit/rollback
and replay semantics, version-6 upgrade, trace ancestry, read/write races and
scope isolation. `make -j1 fmt-check lint` passes with Go lint at 0 issues, both
Rust Clippy checks warning-free, and all configured Node lint/type checks green.
The temporary database is removed after verification; existing acceptance
databases, containers and volumes remain untouched.

#### C4 Third Service Batch: Edge Gateway State Subscription

Implemented in `services/edge-gateway` and its owned session contract only
(revision 10). GET `/api/app/agents/{agent_id}/state` and `/state/watch` expose
the Controller's five-field scoped snapshot through the existing browser
session. See [Gateway workspace state](../services/edge-gateway/docs/workspace-state.md).

- Identity resolution supplies the User and Organization. Browser query fields,
  replay cursors and cross-origin requests are rejected. Backend responses are
  bounded, decoded, validated and re-encoded; no credentials, executable
  configuration or another principal's active Session are forwarded.
- Watch has a first-snapshot timeout, bounded writes, an existing five-minute
  default stream lease and separate capacity from ACP connections. Identity is
  revalidated before later snapshots. Quiet revocation is bounded by the lease,
  not promised instantaneous. There is no Gateway polling, automatic renewal,
  additional journal or prompt replay.
- Client cancellation, access loss, dependency failure and expiry end the watch.
  Service shutdown explicitly cancels and drains state streams before telemetry
  shutdown; ordinary HTTP requests retain graceful drain. Failed observation
  neither invents a ready state nor cancels the durable ACP Run.
- Actual HTTP component tests cover fragmented upstream frames, downstream
  disconnect propagation and Gateway-rooted Identity/Controller span ancestry.
  Response wrappers preserve Flush errors. Identity span status contains fixed
  classifications rather than upstream error codes or transport exception text.
- Two read-only adversarial reviews are complete and closed. Reproduced findings
  about shutdown, Origin scheme checks and trace privacy have regression tests
  and fixes. Only the coordinator executed verification.

Agent UI subscription consumption remains the next service-owned batch. It must
mark disconnected state uncertain, refresh authentication/access and reconnect
with backoff without resubmitting prompts. Docker/browser/Jaeger end-to-end
acceptance remains pending; this service batch does not close C4-01..05.
No retained containers or databases were modified and no external Provider was
called in this batch.

Final service evidence: all 7 Gateway packages pass `go test -race -p=1
./services/edge-gateway/... -count=1`: 71 top-level tests, 0 failures, 0 skips.
`make -j1 fmt-check lint` passes, including Go lint, both warning-denied Rust
Clippy checks and configured Node lint/type checks. These results are service
regression and controlled HTTP component evidence, not deployed-stack acceptance.
All 48 local link targets across the six changed Markdown documents and
`git diff --check` pass. Final process inspection found no remaining verification
workers.

#### C4 Fourth Service Batch: Agent UI State Consumer

Implemented in `services/agent-ui` only. The UI now consumes the Gateway state
contract without changing ACP or introducing another message protocol. See
[Workspace observation](../services/agent-ui/docs/workspace-state.md).

- ACP connectivity, selected-history readiness and authoritative Agent state
  independently gate input, attachments and Session configuration. Bootstrap
  summaries cannot overwrite the selected Agent's newer state snapshot.
- A bounded EventSource adapter rejects malformed or foreign snapshots and
  disables native implicit retry. The observer owns first-response timeout,
  authenticated bootstrap recovery and one-to-thirty-second backoff. Healthy
  streams do not poll; subscription replacement never reuses old readiness.
- Stop targets the outstanding local prompt or the scoped active Session after
  re-entry, independently of sidebar selection. A sent notification is not
  completion. Pending Stop is scoped to the subscription/connection lifetime,
  so a later operation in the same Session can still be cancelled.
- Access loss removes affected history and approvals immediately. User and
  Organization changes discard prior identity state even for overlapping Agent
  IDs. Aborted opening also closes ACP during initialize/session listing; stale
  callbacks and late prompt failures cannot restore private history or drafts.
- Busy-to-ready, revision changes and missed-state recovery refresh the Session
  list/configuration/history at idle, preserving an ongoing local prompt until
  it settles. State loss during Session creation or attachment reading prevents
  a later send. Neither observation recovery nor ACP reconnect replays prompts.

Final local regression: 41 unit tests and 60 component tests pass (101 total,
0 failures, 0 skips), including official ACP SDK traffic with controlled
WebSocket/EventSource peers. Independent read-only review findings were
reproduced before fixes and retained as regression tests; targeted re-review
found no remaining defects in those fixes and all reviewers are closed. Production build
passes; existing upstream Zod annotation and >500 kB bundle advisories remain.
`make -j1 fmt-check lint`, `git diff --check` and 51 local link-target checks
across the four changed Markdown documents pass. No retained Docker stack,
database or external Provider was used for this service batch. The local Vite
preview is presentation-only, not an authenticated deployment acceptance result.
Full Docker/browser/Jaeger acceptance, including actual cross-connection Run
termination and access/rebuild delivery, is the next integration batch.
C4-01..05 remain open until that evidence exists.

#### C4 Fifth Batch: Deployed State And Conversation Integration

The [workspace profile](../scripts/workspace-closeout/README.md), invoked with
`make e2e-workspace`, passed on 2026-09-10 using current Stage 3 images and
isolated project `antnest-lifecycle-cad9af5b`. Only the model protocol peer is
synthetic; Identity, Gateway, ACP, PostgreSQL and Runtime tools are real.

| Check | Final result |
| --- | --- |
| Cross-connection control | One real bash starts, the original ACP connection closes, another Session is denied without model execution, and a fresh connection cancels the original Session. Its entire observed process group has no live members |
| Cancellation boundary | The interrupted MCP response retains `unresolved/unknown` and `blocked_unknown_effect`, consistent with F02. State becomes offline, not ready. Explicit administrator Disable/Enable recovers admission and retains workspace bytes. Automatic reuse after Tool cancellation remains a product decision, not accepted behavior |
| Offline completion | Both ACP and state connections close while a second bash runs. Completion is observed through a fresh snapshot; fresh-connection load replays one reply and exact `started/finished` bytes without another model or Tool call |
| Explicit rebuild | An open observer sees ordered offline then ready with a newer revision. The actual container changes, workspace remains, and a subsequent Run reads the retained bytes with environment-rebuild context |
| Revocation | An observer proven live before owner deactivation closes; state HTTP is 401, existing ACP closes with 1008 and new ACP upgrade is 401/403. Timeouts and server errors are not accepted as authorization denials. No additional model calls. Offboarding disables Runtime and retains workspace; this case revokes an idle Agent, not an in-flight Tool |
| Jaeger | Two state traces (39/27 spans) require Gateway route/method plus Identity and Controller query ancestry. Three Run traces (170/140/178 spans) require correlated model/preparation/actual Tool and matching admission. The cancelled Run remains fenced; both completed Runs release admission |
| Reusable checks | 189 lifecycle/workspace fixture tests pass, no skips or failures. New regressions cover Node WebSocket handshake cancellation, hard request deadlines against a silent peer, malformed state closure, exact process-group inspection, unknown-effect trace identity and rejection of false-positive revocation evidence |
| Admission and review | Final `make -j1 fmt-check lint` passes: Go 0 issues, both Rust Clippy gates and configured Node lint/typechecks. Two read-only reviews closed; findings reproduced and fixed in the test helpers, with explicit denial-code verification added to the final Docker run. Fifty local links and `git diff --check` pass |
| Scope and cleanup | No production service, schema, external Provider or retained deployment changed. Final runner and independent exact-label inspection verify no containers, volumes or networks remain across all five attempted projects. Preliminary failed profiles are not acceptance evidence |

C4-01..05 remain open for actual desktop/mobile browser and attachment/Tool
presentation acceptance. The cancellation usability decision above is explicit;
this batch does not silently replace automatic recovery with administrator work
or declare the complete Stage 3 usage flow accepted.

#### C4 Sixth Batch: Browser Findings And Tool Presentation

Actual Chrome acceptance on disposable project `antnest-lifecycle-8ff1d2be`
completed member login, two messages with real bash/read calls, history reload,
and a new conversation at 390 x 844. The model recorded exactly five requests
for three completed prompts, no errors or replay calls; workspace bytes matched
one write. Both Tool entries were initially collapsed. Page width stayed 390 px
and the composer recovered after completion. This is partial browser evidence,
not a passing complete interactive profile.

The page exposed a real presentation defect: expanded Tool output used hidden
single-line overflow, and the JSON summary was only an opening brace. Agent UI
now uses status summaries and literal multiline, wrapping, vertically scrollable
detail, without the additional silent 12,000-character UI truncation. Regression
tests cover long object/string output, empty shapes, literal HTML text and the
actual stylesheet. Agent UI passes 43 unit and 61 component tests (104 total).

The reusable `browser-run.mjs` profile uses synthetic uploads and exact Tool
call/result checks. Its EOF/error handling aborts unfinished setup; workspace
mismatch errors do not print actual bytes. Lifecycle/workspace fixtures pass
197 tests, zero failures or skips. Two read-only reviewers are closed and their
findings have fixes and regression cases. Final `make -j1 fmt-check lint`
passes (Go zero issues, both Rust Clippy gates and Node lint/type checks).
The final Agent UI image builds successfully; existing upstream Zod annotation
and bundle-size advisories remain, with no threshold or baseline change.

File selection was denied by Chrome's file-URL access permission; the browser
connection subsequently became unavailable during new-image visual rechecking.
No upload, final repaired layout or complete C4 result is claimed. The runner
was interrupted, and independent label-based inspection confirmed zero owned
containers, volumes and networks; generated uploads were removed. Retained
development stacks were untouched. Remaining browser work includes attachment
preview/denial/replay, the repaired Tool layout, open-page rebuild/revocation,
and cancellation usability. C4-01..05 remain open.

The subsequent Agent UI-only correction separates live updates from replay using
the existing connection replay scope. Historical messages and Tool entries omit
unknown original timestamps; replay preserves the Session's known activity time.
Explicit Session metadata remains authoritative. New reducer, official-SDK
transport and rendering regressions pass: 45 unit plus 63 component tests (108
total), followed serially by a successful production build. Browser/deployment
acceptance of this correction remains pending; the browser connection is still
unavailable, so it is not a replacement for C4's remaining page checks.

#### C4 Seventh Batch: Preview Ownership

The final-candidate regression reproduced an attachment-preview lifetime defect:
an earlier passive effect could revoke a newly allocated URL before its draft
committed. Agent UI now captures allocation candidates and draft/in-flight/history
ownership from the same render; in-flight attachments use React state. A
controlled layout-effect regression fails before the correction. Full Agent UI
tests pass (45 unit, 64 component), followed by typecheck/production build and a
successful complete Node sweep (1,462 tests). Independent read-only review found
no additional scoped defect. This is reusable service evidence, not a browser
acceptance claim; C4 remains open.

### 5. Docker Operations And Maintainer Documentation (C5)

- [x] **C5-01** Document and exercise clean image build, runtime image/tag
  availability, one-node startup, bootstrap accounts, secrets, ports, and
  readiness. Never commit test credentials or integration secrets.
  Accepted by the operator runbook and fresh-project build/bootstrap batch
  below. BuildKit cache reuse is explicit; no cache-free-build claim is made.
- [x] **C5-02** Exercise backup and restore of each service-owned database plus
  workspace data and required encryption keys. State the single-node quiescence
  procedure; do not imply cross-service atomic online backup exists.
  The [offline recovery runbook](docker-backup-restore.md) and disposable
  `restore` profile pass the planned, fully quiesced recovery scenario below.
- [x] **C5-03** Diagnose the reported idle CPU spikes with bounded sampling,
  per-service attribution, and a regression check if code is at fault. Record
  sample duration, host/container environment, idle/busy baselines, and outcome.
- [x] **C5-04** Verify shutdown, restart, incomplete-operation diagnosis, log
  access, Jaeger navigation, and cleanup for success/failure/interruption. Each
  test deletes only resources it created; retained acceptance stacks are named.
  The C3 Console active-Watch shutdown failure is reproduced and fixed in the
  service-owned batch below. The platform-wide operations checks are recorded
  below; closing browser tabs before teardown is not a substitute for them.
  Runtime-loss review confirmed stale `available` state. The consumer and
  producer corrections and explicit unavailable-Agent Rebuild are verified in
  local service batches below. Console action wiring also passes its local
  batch. Disposable Docker live/cold-loss integration passes in the batch below;
  final deployed page acceptance is recorded in the verification report.
  Planned disabled-Agent backup does not prove unplanned loss recovery.
  Gateway receive-stream shutdown and request-telemetry drain also pass the
  isolated service and Docker regression recorded below; their scope remains
  distinct from the whole-platform checks.
  Real-platform shutdown with open streams and same-container restart now pass
  `e2e-lifecycle-shutdown`: nine clean exits, server-closed Watches, ACP 1001,
  retained Session/workspace and Gateway-rooted traces. The report records the
  fixed WebSocket-close ordering and precisely classified HTTP cancellation.
  Live Jaeger navigation is now verified in the 2026-09-11 browser batch in
  the report: search by lifecycle request, open an execution phase, and follow
  its reference back to the Gateway admission span. The final Console browser
  batch observes live `runtime_deleted`, Rebuild submission/running state,
  automatic `available`/completed recovery and cleared diagnostics. A separate
  verifier checks replacement compute, retained workspace bytes, one rebuild,
  five linked phase traces and zero model requests. Exact-scope cleanup passes.
  Existing restart, failure/log diagnosis and success/failure/interrupted-runner
  cleanup records are reconciled without rerunning unrelated suites.
- [x] **C5-05** Align root quickstart, service READMEs, contracts, business
  sequences, feature surfaces, and known limits with executable behavior.
  Accepted on 2026-09-10 after source-backed ownership/sequence review and
  read-only independent recheck. Corrections cover asynchronous lifecycle,
  attachment CAS, retained failed Runtime ownership, private generation versus
  process execution identity, migration/readiness behavior, browser recovery,
  and current ACP/Identity consumer status. The TLS-proxy and cancellation
  limits remain explicit, not declared implemented. Final checks: repository
  format/lint/typechecks pass, 85 Markdown documents have 387 valid local file
  targets, and `git diff --check` passes. Link checks do not validate external
  URLs or heading anchors. C4, C5-04 and C6 remain open.

**Milestone C5:** another maintainer can build, operate, diagnose, back up,
restore, and clean up the single-node instance using repository documentation.
The idle CPU concern has a measured disposition, not an assumed fix.

#### C5 Build And Bootstrap Batch (2026-09-10)

[Operator runbook](docker-single-node-operations.md), `.env.example` and root
quickstart now cover image ownership, bootstrap-on-start behavior, persistent
encryption keys, coupled URL/network configuration, private ports and cleanup.
The current-status MCP, identity revocation, asynchronous lifecycle and Egress
attachment descriptions are corrected; broader C5-05 alignment stays open.

| Check | Final result |
| --- | --- |
| Build | `COMPOSE_PARALLEL_LIMIT=1 COMPOSE_DISABLE_ENV_FILE=1 make -j1 docker-build-stage3` passed for all nine project images; unchanged BuildKit layers reused |
| Empty deployment | `antnest-lifecycle-20535a23`: one Postgres, eleven running Compose services, ten healthy probes; eight application containers match built image IDs. Only Gateway/Postgres/Jaeger plus the fixture-only model publish exact selected loopback ports |
| Business path | Gateway bootstrap login -> member -> model -> Template -> ready Agent; nine lifecycle operations including actual failed managed-MCP startup and its business cleanup. Explicit rebuild/drain restart, exact replay, retained workspace and actual bash/read pass |
| Trace causality | Two completed Gateway-rooted Tool Runs; seven lifecycle admission chains and thirty linked worker phase traces. No external Provider calls, no packet traces |
| Reusable checks | 223 deployment/lifecycle fixture tests pass. New negative checks reject stale images, missing/duplicate services, unhealthy/stopped containers and unintended public/internal port bindings. All repository formatting/lint/typecheck gates pass, including Go zero issues and both Rust Clippy gates |
| Cleanup and review | Read-only review corrections applied. Both attempted projects have independently verified zero containers/volumes/networks; no build/test/lint processes remain. Retained development stacks unchanged |

The initial inspector failed on Jaeger's absent optional health field, before
business operations; that run was discarded and cleaned. The corrected
optional-field lookup passed against both actual health-bearing and no-health
containers before the full successful run. This does not accept C4 browser
flows, remaining C5 operations or C6 final integrated reporting.

#### C5 Console Shutdown Batch (2026-09-10)

The production HTTP composition reproduced the reported failure: `Shutdown`
waited for a quiet upstream Watch until its deadline, returned an error and
forced connections closed. Console now cancels Watches before graceful drain,
unblocks downstream stream writes, and rejects new requests while stopping.
Ordinary in-flight requests may finish; real deadline failures are retained.
After forced close, a separate bounded five-second drain waits for cancelled
handlers and their request telemetry before exporter shutdown.

| Evidence | Final result |
| --- | --- |
| New regression scenarios | 10: quiet Watch shutdown, ordinary request drain, real timeout, delayed request trace, drain admission/budget, new-Watch refusal, client/service cancellation, downstream write backpressure |
| Service Go verification | All six test-bearing packages pass normally and with `-race`; targeted Run/Watch regressions also pass five repetitions |
| Admission | `make -j1 fmt-check lint` passes; Go 0 issues, both Rust Clippy targets and configured Node checks pass |
| Docker signal/restart | `antnest-console-stop-84f10371`: SIGTERM, restart, SIGINT with active Watches; exit codes `[0, 0]`, both upstream subscriptions closed |
| Image | `antnest/admin-console:local`, `sha256:7e2ab5bbd46648cd3ab398895b4c86f95c8c47c90fe5352986a44e1c920f1f2f` |
| Review and cleanup | Read-only findings reproduced and fixed; final scoped review found no blockers; reviewers closed. Independent label inventories show zero test containers and networks |

The reusable container regression is documented in
[Console operations](../services/admin-console/docs/operations.md#shutdown-contract).
It uses controlled internal HTTP dependencies and disables the OTLP exporter;
local trace-order regressions do not replace C6's Gateway-rooted Jaeger report.
C5 backup/restore and remaining platform operations acceptance are not completed
by this service batch. CPU diagnosis is recorded separately below.

#### C5 Gateway Shutdown Batch (2026-09-10)

Quiet ACP v1 and admin event streams previously outlived shutdown; slow
downstream writes could also block cancellation. Gateway now covers all four
HTTP receive routes, interrupts blocked writes without resetting cancellation
deadlines, and drains all request handlers through telemetry completion.
Ordinary ACP POST/DELETE requests retain graceful drain. Real shutdown errors
are preserved, with a separate bounded five-second handler cleanup window.
Gateway's Compose stop budget is 30 seconds for the default HTTP, handler and
exporter shutdown budgets.

Final checks: all seven Gateway test-bearing packages pass with `-race`;
repository `make -j1 fmt-check lint` passes. The reusable
[Gateway shutdown regression](../services/edge-gateway/docs/operations.md)
ran project `antnest-gateway-stop-a0dbef48` against built image
`sha256:e18790571373b5c6459287b9ab40976e27b0da3b55f3f45c3cee8115297c311c`:
four HTTP receive routes, SIGTERM -> restart -> SIGINT, eight upstream
cancellations and exit codes `[0, 0]`. Independent label inventories confirm
zero remaining test containers, networks or volumes. Read-only final review
found no blockers and the reviewer was closed. Docker uses controlled HTTP
dependencies without OTLP; local trace-drain tests do not replace C6's actual
Jaeger report or C4 browser acceptance. C5-04 remains open.

#### C5 Idle CPU And Runtime Health Batch (2026-09-10)

Environment: OrbStack Linux/x86_64, 16 logical CPUs, approximately 7.82 GiB Docker
memory. Docker percentages below are relative to one CPU. The retained
`antnest-stage3-e2e-75838` stack and its Runtime were observed without injecting
business requests, builds or tests. From 07:21:27 to 07:23:27 UTC, 59 bounded
`docker stats --no-stream` snapshots were collected per container:

| Service | Sampled mean CPU % | Sampled maximum CPU % |
| --- | ---: | ---: |
| Agent UI | 0.109 | 3.49 |
| Edge Gateway | 0.151 | 4.34 |
| Runtime Controller | 0.294 | 3.93 |
| Identity | 0.188 | 4.12 |
| Admin Console | 0.236 | 4.65 |
| ACP service | 0.232 | 5.23 |
| Agent Controller | 0.232 | 4.81 |
| Runtime | 1.650 | 4.36 |
| Egress | 0.133 | 3.90 |
| PostgreSQL | 0.479 | 6.69 |
| Jaeger | 0.207 | 1.05 |
| Synthetic model fixture | 0.696 | 14.98 |

These are sampled windows, not continuous accounting: periodic probes can alias
with `stats` sampling. Most peaks above 1% coincided within one second of probe
completion. PID counts were stable except PostgreSQL's bounded 16-19 range.
The synthetic Node model health probe accounts for the largest observed peak;
no sustained 100% service CPU or accumulating business processes was reproduced.

A separate 60.47-second Runtime counter delta (07:26:14 to 07:27:15 UTC) measured
0.02 CPU-seconds in PID 1 (0.0331%) versus 1.192132 CPU-seconds in its whole cgroup
(1.9714%). The container had only the Runtime process when inspected. This points
to transient probe overhead rather than a busy Runtime main loop. The two
`docker exec cat` counter reads add small measurement overhead. The old Runtime
started a `curl` health process about every 2.045 seconds indefinitely.

Runtime Controller now configures `StartInterval=2s`, `StartPeriod=30s`,
`Interval=10s`, `Timeout=2s`, `Retries=3`. The one-minute readiness budget and
`unless-stopped` restart policy are unchanged. Only newly created/recreated
Runtimes receive these settings. Steady health failure needs three consecutive
failures; Docker does not automatically restart a merely unhealthy live process.

The reusable [health profile](../services/runtime-controller/docs/operations.md#platform-health-and-restart)
created a fresh Agent through Gateway and both Controllers, checked exact-request
replay, measured CPU, injected a finite three-second ordinary-user load, observed
health failure/recovery and restarted only that owned Runtime:

| Evidence | Final result |
| --- | --- |
| Disposable project | `antnest-lifecycle-694497d9` |
| Controller image | `antnest/runtime-controller:local`, `sha256:a244f753ba21bcc495c7c39a75023319f3d3b4cc9cac42e8fde3ed9535f96b59` |
| Runtime image | `sha256:f9cc91d38c5ae6e59df430e54e6f0e649ca57f5c76e888ae6e23860ebb544ad3` |
| Initial/restart readiness | 2.190 / 2.185 seconds |
| Observed steady intervals | 10.001, 10.001, 10.002, 10.001 seconds |
| Idle, 60.4243 seconds | PID 1: 0.0662%; cgroup: 0.4763% |
| Bounded load, 3.5217-second sample | cgroup: 3.4019 CPU-seconds, 96.5981% |
| Return to idle, 60.1197 seconds | PID 1: 0.0499%; cgroup: 0.5031% |
| Fault/recovery | Paused Runtime becomes unhealthy after exactly three consecutive failures; resume becomes healthy; restart resets fast startup cadence |
| Verification | Runtime Controller package tests and race tests pass; lifecycle/workspace fixture tests 205/205 pass; `make -j1 fmt-check lint` passes |
| Adversarial review | Retained pre-restart probe logs caused a real test false-failure risk. Current-start filtering plus three regression cases and the Docker restart check close it; reviewer closed |
| Cleanup | Owned containers, volumes and networks removed; retained `antnest-stage3-e2e-75838` and `antnest-stage3-e2e-58844` stacks unchanged |

Disposition: C5-03 has measured service attribution and a verified reduction of
unnecessary Runtime probe work, not an assumed busy-loop fix. This is a local
control/health workload, not an LLM benchmark or the C6 full-stack performance
report. Future sustained spikes require a new process/cgroup sample; health
request logging in other services remains a separate potential optimization.
At this CPU-batch checkpoint C5-01/04/05 remained open; the current checklist
above supersedes that checkpoint. C5-02 is recorded below.

#### C5 Offline Recovery Batch (2026-09-10)

Scope is a planned single-node maintenance window: complete the Run, disable the
Agent through its lifecycle API, stop all eight application services cleanly,
then export while only PostgreSQL remains active. Jaeger stays available until
application exporters finish; stopping it simultaneously caused a real initial
exit-check failure, and that failed attempt was discarded and cleaned.

| Evidence | Final result |
| --- | --- |
| Disposable project | `antnest-lifecycle-e68f5318` |
| Real replacement | Original PostgreSQL container/data volume, dynamic Agent workspace and system Skills volume removed; restore targets checked empty |
| Database recovery | All five private service databases restored with matching row/sequence and schema/object owner/ACL fingerprints, before service startup |
| Permission negative controls | Table SELECT grant and schema-owner changes are detected without changing business rows; both transactions roll back and original fingerprints match again |
| Persistent files | Whole workspace/home and system Skills archives match; hidden personal Skill, binary bytes, UID/GID 1000, mode 0600 and symlink target preserved |
| Encryption | Three independent random test keys backed up privately, cleared from runner environment, restored and compared with actual container-injected values; no `.secret` used |
| Functional recovery | Original member identity, model/Template configuration, disabled Agent and closed network policy retained; explicit Enable creates a new executable Runtime |
| ACP history and Tool | Five durable history updates replay with zero model requests; an untouched old Session directly prompts against its original encrypted MCP revision and executes one real file-read Tool |
| Reusable verification | 218 lifecycle/workspace fixture tests pass, including missing-manifest preflight, conflicting cleanup ownership and changed Identity-key cases; `make -j1 fmt-check lint` passes |
| Cleanup | Temporary containers, volumes, networks and private recovery files removed; retained human-acceptance stacks were not modified |

Review exposed and closed four acceptance gaps: finally cleanup could bypass an
ownership conflict; a missing manifest volume could survive as an original disk;
row-only fingerprints missed permission drift; local login alone did not verify
the Identity encryption key. Regressions now cover each path; cleanup tests put
the conflicting resource first for containers, volumes and networks. Final
read-only re-review confirms the four fixes, and all reviewers are closed. The fixture is not
a general backup service and does not certify live cross-service snapshots,
nonstandard PostgreSQL globals, external IdP exchanges, existing TCP connections,
or arbitrary host migration. Those are not implied by this offline result.

This recovery deliberately stores disabled Agents and does not count as proof
for the unplanned-loss scenario addressed by the C5-04 batches below.

#### C5-04 Runtime Loss: Producer And Consumer Batches

Both gaps were reproduced with failing regressions before implementation.
Agent Controller previously advanced its observation cursor past
`runtime_missing`/`runtime_deleted` without invalidating the executable binding.
Runtime Controller also rejected confirmed absence as digest drift and could
publish a false missing event from an inventory captured before creation.

- Agent Controller now atomically commits binding invalidation, the distinct
  `agent_runtime_missing` audit event and its consumer cursor. New Runs are
  rejected; old Run snapshots and unresolved-effect fences are unchanged.
  Confirmed absent snapshots cover bootstrap/expired-cursor reconstruction.
- Runtime Controller now exposes logical ready/absent state without an endpoint
  or execution ID. Missing inventory candidates receive one exact-key platform
  reinspection; present resources still require matching digest and generation
  claim. Inspection errors and contradictory absence are never deletion proof.
- New reusable cases: 15 actual PostgreSQL scenarios, two HTTP decoding cases,
  and 17 Runtime Controller cases. Both service race suites pass; Agent
  Controller's complete service run includes its PostgreSQL/E2E packages using
  an isolated synthetic database. Runtime Controller's DB-gated tests were not
  enabled in this batch, which changes no persistence schema in that service.
  Final repository `make -j1 fmt-check lint` passes with zero Go lint issues.
- Read-only review added real EventService LIST/Watch, whole-page rollback with
  no commit notification, and physical-resource-ID negative controls. Reviewers
  are closed. The temporary PostgreSQL container and its data volume were
  removed; existing human-acceptance deployments were not replaced.

The separate Agent Controller recovery batch now accepts explicit Rebuild for
enabled unavailable Agents with valid immutable last-successful lineage. A
separate recovery-source value leaves executable fields empty; locked admission
checks aggregate/spec/runtime/history, identity and concurrent operation state.
The existing drain/fence/update/open/publish sequence installs the replacement.
No new RPC, recovery worker or database schema is introduced by this batch.

Final local recovery evidence:

- 29 focused cases cover source eligibility/lineage, seven stale-admission
  races and seven PostgreSQL recovery scenarios. Missing/deleted/restarted
  Runtime observations reject new Runs until explicit replacement; replay and
  late old-revision observations cannot repeat or undo publication.
- Definite pre-replacement failures remain unavailable and can be retried with
  a fresh request after correction. Permanent rejection with an unchanged
  logical Runtime head no longer leaves a dead-process readiness loop. An
  unresolved Runtime Tool fence remains until exact replacement proof.
- Two full HTTP lifecycle scenarios (available and runtime-loss recovery) use
  actual PostgreSQL and controlled Runtime/Egress HTTP peers. Both independently
  verify lifecycle trace causality with isolated recorders. The complete Agent
  Controller `go test -race -p=1 ... -count=1 -timeout=300s` passes with its
  database suites enabled; `make -j1 fmt-check lint` passes with zero Go issues.
- Read-only implementation re-review reported no new grounded findings; the
  reviewer is closed. The disposable PostgreSQL resource is cleaned after
  verification; existing human-acceptance deployments are not replaced.

Console's separate local batch now projects retained spec/history identifiers
without treating them as executable configuration. Eligible unavailable Agents
can request the existing Rebuild with a Template revision; initial failures
without history retain cleanup only. Missing/restarted Runtime explanations and
event labels do not misrepresent an unsolicited observation as a failed command.

Console verification and review:

- The BFF's actual scoped route preserves the two safe history identifiers and
  still strips private access/process/endpoint/credential fields. Its complete
  Go race suite passes. No lifecycle authority or database access moves to BFF.
- 96 pure-logic and 204 component tests pass. Coverage includes live/replayed
  loss, explicit request and progress, reopening during Rebuild, no duplicate
  mutation, initial history/Agent read ordering, stale/failed read recovery and
  dialog submission after active-operation/quarantine/access/read changes.
- Read-only review exposed three races and re-review exposed one related
  history-selection race, all reproduced before correction. Event aggregate
  watermarks gate stale snapshots; newest operation hints stay separate from
  read targets, accepted unfinished requests cannot be replaced by old history,
  and confirmation/submit share the current action gate. Reviewers are closed.
- Repository `make -j1 fmt-check lint` and the Console image build pass. No new
  interval polling, automatic lifecycle retry, Runtime proxy or repair command
  is added. These tests do not substitute for deployed browser acceptance.

#### C5-04 Runtime Loss: Docker Integration

`make e2e-lifecycle-loss` passes on disposable project
`antnest-lifecycle-5d9ff1c9` with the rebuilt Console and both Controllers.
Two independent Agents cover live container removal and removal while Runtime
Controller is stopped. The actual producer records respectively
`runtime_deleted / docker_event` and `runtime_missing / platform_reconciliation`.
The public loss event is correlated by ID/sequence with its service-owned audit
and producer observation; Console does not expose arbitrary internal event data.
Read-only queries use each service's own database role and never update records.

- Both cases preserve the last-successful spec/history, clear executable identity
  and endpoint, and reject a new ACP prompt as `agent_build_failed`. The model
  receives no rejected prompt. Runtime Inspect still returns the logical head as
  ready/absent rather than a fabricated endpoint or digest-drift error.
- Four completed ACP prompts dispatch four actual MCP Tools: one append before
  each fault and one exact read after explicit Rebuild. The original Session,
  history and workspace survive; loading history causes zero model calls. New
  execution/container identities and a model-visible environment-reset notice
  prove that recovery is not merely displaying an old answer.
- All six Gateway create/rebuild/delete operations complete and exact-request
  replay leaves physical resources and event history unchanged. A further
  Runtime Controller restart reaches a verified consumer cursor checkpoint
  without changing the replacement binding or duplicating loss audit.
- Jaeger validates four Gateway-rooted Run traces, including correlated Runtime
  tool success and released/settled admission, plus six lifecycle admissions
  and 26 linked worker-phase traces. Write traces are collected before forced
  removal so a killed Runtime cannot erase its unexported evidence.
- Both Agents are deleted normally after recovery, including their workspace
  volumes. Profile teardown verifies that all owned containers, volumes and
  networks are absent; the retained human-acceptance stacks are unchanged.
- All 210 lifecycle fixture tests pass. Read-only review found a missing
  producer-kind/consumer-reason equality assertion; both mismatch directions
  were reproduced as failing tests before correction and the complete Docker
  profile was rerun successfully. Reviewers are closed. Only final metrics are
  retained here, not intermediate logs or trace dumps.

This closes the deployed idle live/cold-loss subcase, not C5-04 as a whole.
Rebuild remains the explicit recovery path; Disable is not a recovery command.
The later final browser batch accepts deployed recovery separately. Artificially delayed
old-revision observations and in-flight unknown Tool effects retain their
separate Controller/PostgreSQL evidence, not a claim of coverage by this profile.

### 6. Integrated Acceptance And Jaeger Report (C6)

- [x] **C6-01** Run repository admission and complete single-node regression
  serially on the final candidate, using one shared test PostgreSQL instance
  with private service databases. Record skipped cases separately.
  Accepted on 2026-09-11 after final image/assertion reconciliation of all
  deployed entries, including Workspace service-side cancellation/recovery,
  lifecycle fault/restore/health and Console/Gateway signal profiles. Unit,
  component, race, admission and documentation results are in the verification
  report. Test-only Runtime image exceptions are explicit; C4 is deferred, not
  passed. C5-04 page navigation and C6-02/04 have separate final evidence below.
- [x] **C6-02** Execute every in-scope scenario in section 4. Defer only the
  Agent Web UI client flows listed in C4; retain Admin Console operations and
  Jaeger navigation. Use controlled protocol peers for deterministic regression; report
  separately any real IdP/Provider checks and their limitations.
  Accepted on 2026-09-11 after the report's per-scenario reconciliation: prior
  C3 Console operations plus current-candidate deployment regression and final
  Runtime-loss browser recovery. Controlled peers are not real-vendor acceptance.
- [x] **C6-03** Query Jaeger and validate the causal paths in section 5. A trace
  containing the expected service names is not sufficient evidence.
  Accepted on 2026-09-10 after requirement-by-requirement reconciliation of the
  recorded deployments and reusable causal assertions: local/OIDC/SCIM identity,
  implemented revocation-to-Disable links, lifecycle admission/worker execution,
  and Gateway-rooted model/Runtime Tool Runs. The independent read-only audit
  identified no missing required service-side path. This acceptance uses the
  report's explicitly identified captures; it is not a fresh full-candidate run
  or acceptance of C4, C5-04 page navigation, C6-01/02/04.
- [x] **C6-04** Produce `docs/docker-single-node-verification-report.md` from
  actual final results. Include source revision, commands, final quantitative
  results, scenario IDs, trace links, known limits, explicit user-deferred
  client checks, and cleanup outcome.
  Accepted on 2026-09-11. The report maps all nine scenario IDs to outcomes,
  causal evidence and scope limits. Independent read-only review found no
  additional in-scope gap once the final Console observations were supplied.

**Milestone C6:** all in-scope scenarios pass, no unresolved correctness defect
breaks the three flows, and the Jaeger report independently demonstrates their
entry-to-owner/dependency causality. Deferred services remain deferred.

The [verification report](docker-single-node-verification-report.md) records
the 2026-09-10 final-candidate service rerun, replacing earlier headline metrics:
863 Go tests pass with race detection, 10,970/15,618 statements covered (70.2%),
and all 54 test-bearing packages pass. The complete Node entry passes 1,462
tests after the deterministic preview-ownership correction; all 160 ACP
PostgreSQL and six explicit Egress PostgreSQL cases pass. C6-01 stays open:
its complete single-node regression also requires the existing deployed
profiles, reconciled by candidate images and actual assertion coverage in
the report's final Docker regression boundary. Fixture counts do not stand
in for those workflows. This does not reopen the accepted C1-C3/C6-03 items
or claim that C4 browser acceptance has occurred.

The final Docker foundation batch builds all nine current images, passes the
standalone Runtime/Egress and Runtime Controller profiles, and verifies cleanup.
It corrects the Stage 1 test caller to explicitly open/close Egress attachment
state and use independent CAS versions, with stronger live-network assertions.
The Stage 2 caller is now aligned with lifecycle actor and asynchronous
operation contracts: distinct administrator/owner identities, automatic
offboarding, retained original workspace, exact replay, access rejection and
final deletion pass the deployed test. Its 23 verifier tests include the three
independently identified ordering false positives, reproduced before correction.
The final rerun verifies all three linked worker phases and the actual ACP/Tool
execution trace. Detailed results and remaining profile scope are in the
report; C6-01 remains open.

The 2026-09-11 Stage 3 plus ACP-closeout rerun passes on the same nine product
images: Gateway local/SCIM/OIDC and lifecycle/workspace flows, both ACP versions,
eight real process restarts, unknown-effect recovery through explicit rebuild,
and 26 model requests. Four Gateway-rooted Runtime Tool traces total 812 spans.
The fixture now owns WebSocket errors and bounded SDK requests (49 fixture tests
pass). A prior HTTP 503 did not recur, but its server-side origin is not proven;
the report retains this limit. Other deployed profiles and actual browser
acceptance still prevent closure of C6-01/02/04.

The final-image capability regression now also passes tool progress (12
scenarios), file observations (16), structured plans (12), and slash commands
(v1/v2 WebSocket and v1 HTTP), plus native multimodal input and Session cost
across all three transports, and 26 v1/v2 tool-permission scenarios. Cost recovery
includes one actual ACP restart and nine restored Sessions. All seven deployed
ACP user-capability profiles pass on the final images. Each uses a separate
disposable deployment and checks authoritative protocol output, replay/isolation,
actual execution and
Gateway-rooted traces. Compact counts, durations and remaining scope are in the
report's final-candidate ACP capability table. These are not browser results;
C4 and the final C6 items remain open.
Both managed-MCP stable-v1 and draft-v2 profiles also pass six business phases
each, including active-Run rebuild drain, child reuse and post-rebuild context/
workspace recovery. Their final-candidate reruns and owned-resource cleanup pass.

Final-image identity access, existing ACP connection faults, Agent isolation/
offboarding and committed RPC response loss now pass as well. The last profile
exercises four actual ACP process recoveries across both protocol versions,
without repeated side effects. Agent access verifies 36 management denials,
eight upgrade denials, 20 Session denials and five automatic Disable chains.
An empty-Session fixture false rejection is corrected without changing product
behavior; 125 targeted tests and repository format/lint/type gates pass.
The report records precise counts, candidate scope and trace references.
Remaining lifecycle/operations regression and Console page checks still prevent
C6 closure; the explicitly deferred C4 checks are not current blockers.

The subsequent final-image lifecycle batch completes foundation/startup failure,
real network, live/cold Runtime loss, interrupted update, offline restore,
open-stream shutdown/restart and health/CPU. Console/Gateway SIGTERM/SIGINT
profiles also pass. All 15 projects in this identity/lifecycle/signals batch,
including discarded attempts, are independently clean (84 exact-label
inventories, no temporary image tags or test workers). The Workspace protocol
profile remains applicable and is explicitly reconciled, not deferred with C4.
This closes C6-01. Chrome control recovered on 2026-09-11; live Jaeger navigation
and, after explicit synthetic-account approval, Console Runtime-loss recovery
both passed. Final report reconciliation closes C5-04 and C6-02/04. C4 remains
explicitly deferred and unaccepted. Completed service suites were not repeated
solely to fill the earlier browser-access wait.

The report also records the fresh lifecycle and Stage 3 entry deployments after
hardening their shared trace verifier: 241 helper tests pass, exact admission and
predecessor links replace service-presence checks, and dynamic session canaries
are covered. Both disposable stacks pass and are independently cleaned up.
Measured Gateway/Identity, lifecycle and actual Runtime Tool trace references
are retained in the report. Full browser acceptance, OIDC outbound request-span
assertions and remaining operations checks were still pending at that checkpoint.
The subsequent OIDC increment closes the outbound assertion gap: 317 targeted
Identity/lifecycle helper tests pass, and a fresh disposable Stage 3 deployment
verifies four Discovery exchanges, twelve authorization grants/JWKS requests
and one authenticated UserInfo fallback. Selected traces require exact nearest
Identity server ownership for both persistence and outbound client spans.
The complete profile and independent resource cleanup pass; source fingerprint,
trace references and evidence limits are in the report. Actual browser and
remaining operations acceptance still prevent final C6 completion.
The subsequent shutdown increment closes the real-platform open-stream
maintenance gap. Gateway race tests, 300 reusable helper tests, the final-image
SIGTERM/SIGINT regression, full-stack stop/restart and repository admission pass.
This is an affected-service rerun after a Gateway fix, not a new measurement of
all service coverage. C4, the two remaining C5-04 browser checks and C6 remain open.
Within C6, the service-side causal-path item C6-03 is now accepted separately;
remaining scenario/browser coverage does not invalidate already verified paths.

## 4. Business Acceptance Matrix

| ID | Entry and scenario | Required observable outcome |
| --- | --- | --- |
| ID-01 | Edge local login -> Console/Workspace -> logout | correct role/application, revoked session rejected |
| ID-02 | Edge OIDC start -> IdP -> Edge callback -> Identity | same provisioned subject, server-owned credential exchange |
| ID-03 | Edge SCIM User/Group changes -> Identity -> Agent admission | intended membership changes and disabled-user denial, no cross-organization mutation |
| MG-01 | Edge Console model/Template/Agent create | durable operation, ready Runtime, immutable executable lineage |
| MG-02 | Edge Console rebuild/disable/enable/delete | correct admission boundary, retained or removed workspace per command, visible outcome |
| USE-01 | Edge ACP Session prompt -> model -> Runtime Tool -> reply | ordered protocol updates and durable conversation; Agent UI rendering/composer acceptance deferred |
| USE-02 | ACP v1/v2 cancel/reconnect/load or resume | version-correct terminal state, no duplicate model/Tool effects from replay |
| USE-03 | open Session across identity change or explicit rebuild | authorization rechecked, old Runtime not reused for a new Run |
| OPS-01 | fresh Docker deployment, restart, backup/restore, cleanup | documented recovery and no orphan test resources |

These IDs identify acceptance scenarios, not new persisted business entities.
The 2026-09-11 deferral removes only Agent Web UI client observations from
ID-01 and USE-01..03; their server-side behavior remains in scope. C5-04's
Console recovery and Jaeger navigation remain required browser observations.

## 5. Gateway-Rooted Observability Contract

Instrument the actual services in each path, not every service in every trace:

| Flow | Expected causal path |
| --- | --- |
| Local identity | Edge Gateway -> Identity RPC -> Identity PostgreSQL spans |
| OIDC | Provider registration: Edge -> Console -> Identity -> IdP Discovery and owned provider persistence. Login start: Edge -> Identity -> owned authorization transaction, then client navigation to IdP. Callback: a separate Edge -> Identity request with IdP Token/JWKS/optional UserInfo spans and owned login persistence |
| SCIM | Edge protocol forwarding -> Identity SCIM -> owned persistence; link any later domain consumer only if implemented |
| Lifecycle admission | Edge -> Admin Console -> Identity/Agent Controller -> durable lifecycle intent |
| Lifecycle execution | admission linked to Agent Controller worker attempts -> Runtime Controller/Docker and Egress control RPC -> final Agent event |
| Conversation | Edge ACP entry -> ACP method/Run -> Agent Controller admission/credential resolution -> model request and Runtime MCP -> executor request/response -> completion |

Long-lived WebSockets, browser redirects, and durable asynchronous operations
are not one HTTP request. Preserve W3C parent context where the work is a direct
call; use standard span links and bounded correlation at asynchronous/request
boundaries. A later prompt needs its own attributable operation rather than
being hidden inside a never-ending WebSocket-upgrade span. No new private ACP
success fields or payload-required trace metadata are allowed.

For async lifecycle operations, retain the existing admission trace and linked
per-attempt/phase traces. Validate the link back to admission and predecessor
where applicable, operation identity, terminal outcome, and missing/orphan
spans. Do not keep one giant span open until the lifecycle finishes.

Egress traces **control RPC only**. Raw IP/UDP packet forwarding does not emit
per-packet, per-flow, or payload traces. Model request spans do not require
instrumentation inside the external Provider. Browser-only rendering is
covered by browser tests, not fabricated server spans.

The report must contain:

1. Candidate revision, tool versions, Compose topology, test profiles and
   sampling/export configuration used for the measurement.
2. For every scenario: business outcome, expected/observed services and causal
   edges, trace IDs/Jaeger links, and verdict. State related trace boundaries.
3. Automatic assertions for Gateway origin, parent/link integrity, identity
   and operation correlation, terminal status, and absent secret material.
4. Tests passed/failed/skipped, changed-module coverage, lint/complexity gate
   results, E2E/browser cases, duration and idle CPU measurements.
5. Remaining limitations and cleanup result. Do not equate service count,
   trace count, or screenshots with business correctness.

Keep one compact final report and reusable assertions. Do not commit complete
trace exports, credential-bearing HTTP dumps, repetitive reviewer transcripts,
or intermediate metric files. Jaeger links are diagnostic references and may
expire; record the compact asserted result so the verdict remains intelligible.

## 6. Scheduler Planning Only

Scheduler will be the initiator of scheduled-Agent usage, separate from an IM
or browser client. Its intended ownership is schedules, timezone/next-due
calculation, and durable trigger/deduplication records. It will request normal
authorized Agent execution through the platform ACP entry/contract, not bypass
Run admission or call Runtime Tools directly.

Agent Controller remains the owner of Agent availability and authorization;
Agent ACP Service remains the owner of Sessions, Runs, context, and Tool loops.
Scheduler must not copy either service's tables or become a second Agent Core.

Before that future stage, decide execution principal, Session reuse, overlap,
missed-fire policy, cancellation, result delivery, and retention. Those are
future design decisions, not implicit requirements to implement now. Add no
scheduler directory, dependency, RPC placeholder, database table, or Console
control during this closeout.

## 7. Verification Discipline

- Fix a demonstrated business gap before widening adjacent abstractions.
- Unit and contract tests establish rules; owned-database integration tests
  establish persistence; Docker/ACP/browser tests establish complete workflows.
- Run resource-intensive verification serially. Reviewers are read-only and
  do not spawn tests, browsers, Docker workloads, or further reviewers.
- Run the existing formatting, lint, affected tests, and applicable contract/
  documentation gates before committing. Do not lower thresholds, suppress
  findings, or increase baselines to claim acceptance.
- Coverage reports name modules and denominators; skipped/external profiles
  are never counted as passing coverage. Prior test counts are not new runs.
- Stop and close test processes and disposable resources after each profile.

Historical checkpoint before C2/C3 closeout (2026-09-10):
C1-01/02/03/04/06 and the C2 service/integration
items have supporting execution evidence. Active-Run rebuild, unknown in-flight
Tool recovery and explicit rebuild have stable-v1/draft-v2 Docker evidence.
C1-05 also has deployed acquire/finish committed-response-loss evidence for
both versions. Remaining protocol test combinations are explicit in the matrix.
At that checkpoint C3-C6 were not accepted. The checklist in section 3 is the
current authority; the historical batches below retain their original scope
and dates.

### C1 RPC Response Loss (2026-09-10)

The separate `make e2e-rpc-response-loss` profile withholds a real Controller
HTTP 200 after commit, checks ACP's durable state independently, then drops
the response connection. It observes ACP self-exit 1 (not SIGKILL, OOM or an
automatic restart), starts the same container with a new process, and verifies
recovery before accepting new work. All four cases passed in one fresh project.

- Acquire recovery reuses the original request/admission and complete response.
  Its saved execution snapshot is compared with the upstream result after
  mapping wire/persistence field names, including authorization and pricing.
- Finish recovery reports the same terminal fields as ACP's durable Run and
  receives `already_finished/released`. It performs no model or Tool work.
- Both versions reload twice without changing Run/Tool/history or model counts.
  Current configuration comes from the load/resume response; old configuration
  events are not replayed into the chat. A later real Read verifies each Bash
  append occurred exactly once in the unchanged Runtime.
- Original RPC and later read traces retain Gateway ancestry. Startup retries
  have distinct trace IDs with no invented Gateway parent, correlated by the
  persisted request/admission IDs. No packet-level Egress tracing is added.

The test caught an implementation defect: the initial admission returned Go
nanosecond timestamps, but replay returned PostgreSQL microseconds. The
Controller adapter now uses `INSERT ... RETURNING` timestamps. A real database
regression with nanosecond input compares complete first/replayed records.
Read-only adversarial reviews also tightened terminal, snapshot and trace
oracles; their findings were reproduced in negative tests and fixed.

| Final execution evidence | Result |
| --- | --- |
| Fault matrix | v1/v2 x acquire/finish: 4 passed; 4 observed self-exits and controlled restarts |
| Execution/replay | 8 Runs, 8 real Tools, 16 deterministic model requests; 8 load/resume replays without execution |
| RPC Jaeger | 8 traces, 678 spans; original Gateway ancestry and separate startup replay chains verified |
| Post-recovery execution Jaeger | 4 Gateway-to-Runtime traces, 852 spans; fresh information/catalog reads before each model request |
| Shared script tests | 180 passed serially, including 18 RPC-specific tests and cleanup publication checks |
| Controller | Full module tests and real PostgreSQL repository/E2E suites passed; image rebuilt |
| Admission gates | `make -j1 fmt-check lint` passed: Go 0 issues, both Rust Clippy targets, Node lint and all three TypeScript checks; five document-link checks, two shell syntax checks and `git diff --check` passed |

Reproduction and limits: [RPC profile](../scripts/acp-closeout/rpc-loss.md).
No external Provider or real credential was used. Final success was published
only after owned containers, volumes and networks were removed. This completes
the remaining C1-05 recovery window; crash-during-rebuild, browser acceptance,
operations recovery and final aggregation remain in C3-C6.

### C1 Recovery And Matrix Reconciliation

This batch changes tests, their oracles and documentation, not service behavior.
Command discovery is checked separately from conversation history; v2 recovery
must include idle state, and Tool inputs/IDs follow the actual persisted encoding
and response-scoped identity. Owner restoration requires explicit Agent Enable.
Two independent read-only reviews checked the oracles and boundary coverage.

| Final evidence (2026-09-10) | Result |
| --- | --- |
| ACP unit/component suite | 538 passed in 59 files; both versions reject binary/oversized frames; all eight v2 Session requests reject before initialize without application calls |
| ACP PostgreSQL suite | 160 passed in 21 files; each version paginates 52 owned Sessions without loss, duplication or foreign entries |
| Reusable fixture/oracle tests | 77 passed serially; recovery, identity, command, cost and subnet-discovery checks |
| Admission | `make -j1 fmt-check lint` passed: Go 0 issues, both Rust Clippy targets, Node lint/typechecks; changed document links, shell syntax and `git diff --check` passed |
| Default Stage 3 + ACP recovery profile | Passed; local/SCIM/OIDC access, administrator lifecycle, Workspace ACP, two protocol versions, owner deactivation/restoration and 6 actual SIGKILL/restarts |
| Recovery execution evidence | 20 deterministic model requests; replay does not execute model/Tools, Bash effects are not duplicated, interrupted Runs finish admission and new prompts remain usable |
| Recovery baseline Jaeger evidence | 2 Gateway-rooted traces, 462 spans; Identity, Controller, ACP, model spans and actual Runtime calls verified |
| Test environment allocation | Existing Docker IPAM ranges are excluded from subnet selection, including enclosing/contained ranges; discovery errors abort rather than assume a free range |

The reusable commands are in the [recovery profile](../scripts/acp-closeout/README.md)
and the updated [protocol matrix](../services/agent-acp-service/docs/protocol-conformance.md).
No external Provider or real credential was used. Temporary resources were
removed; retained development instances were not modified. This does not accept
active-Run Runtime replacement, unknown in-flight Tool effects, browser scenarios
or the final operations/report milestone.

### C1 Active-Run Rebuild (2026-09-10)

The existing managed-MCP profile now tests rebuild while a real Run is active.
Template publication leaves the deployed Agent unchanged. Two bounded model
response barriers expose the interval after each Tool has completed, including
the interval before the final assistant answer. Each interval requires a fresh,
successful Controller drain-worker observation and a real Runtime inspection.
The original execution and revision remain healthy and unchanged; another
Session receives `agent_rebuilding`, without conversation output or model work.

After the final response is released, the Run closes its admission and rebuild
publishes a new execution. The old connection's Prompt is rejected by Controller
admission with `access_denied`; reconnect/load (v1) or resume from start (v2)
preserves history without model or Tool replay. The next Run discovers `beta`
instead of `alpha`, retains the workspace guidance and Skill summary, and starts
a fresh child-process counter.

v2 acknowledges Prompt before execution: only its own `running` then
`idle/end_turn` notifications complete a successful Run. Neither held model
response may produce an idle state. Replay compares the unified user/Tool/answer
timeline, message identities and terminal Tool results, not independent lists
that could hide reordered output. Its idle follows the final business record;
separate setup/catalog notifications may follow.

v1 suppresses the initiating user's live echo. Its replayed inputs are checked
against the sent phases, with nonempty unique IDs and placement before each
Run's observed Tool/answer sequence. v2 also compares user message IDs/content
directly to live output. Neither version drops user messages from acceptance.

This scenario deliberately sends a stale Prompt in the original Session before
reconnecting. Controller rejects it before execution; ACP retains a failed
admission intent without accepting a new user message. Consequently v2 replay
reports the latest intent as `idle/_failed`, while all five earlier successful
Runs retain their original history and Tool results. This is an explicit oracle
for that rejection, not a fallback accepting arbitrary failed completion. The
subsequent Run on the replacement Runtime must still finish `idle/end_turn`.

| Final deployed evidence | Result |
| --- | --- |
| Stable-v1 Gateway ACP | Six successful Runs, 15 validated model requests, nine real Tool calls; two execution traces, 1,002 spans |
| Draft-v2 Gateway ACP | Same six Runs, 15 model requests and nine real Tool calls; two execution traces, 1,020 spans |
| Run-boundary checks | Each version has two matching fresh drain observations; unchanged Runtime during both holds; distinct replacement execution |
| Context and process checks | Each version has one information/catalog read per Run; admitted execution/spec pinned; old child counters 3/4, rebuilt child counter 1 |
| Jaeger execution chains | Four Gateway-rooted traces, 2,022 spans, 12 information reads, 12 catalogs and 18 ACP-to-Runtime Tool dispatches |
| Test cleanup | All test-owned containers, volumes and networks removed; final managed-profile `passed` is emitted only after cleanup checks |
| Reusable tests | All 161 shared Node fixture/oracle tests passed serially, including 31 managed-MCP cases; no skipped cases |
| Admission checks | `make -j1 fmt-check lint` passed; Go lint 0 issues, both Rust Clippy targets and Node lint/typechecks |

Final execution trace IDs: v1 `70ceefc6e0ac76653cc56319e5fe43fa` and
`02936beed3229e2305a7f9ab631bdd21`; v2 `22adf6042e3d0802324571ecd67b6abb` and
`967e70ae9fdcebc2daeeb69073eac219`. Jaeger belongs to each disposable stack;
these IDs identify the assertions, not permanently hosted trace exports.

The deterministic model is not an external Provider. No production service
behavior changed. The profile's SDK child, completion/replay oracles and final
evidence publication order are checked independently. Read-only reviews led to
strict mixed-history ordering and a duplicate-input case with distinct IDs,
so duplicate-ID checks cannot mask a missing message-count assertion. Shell
cleanup tests cover success, failed teardown and remaining resources. The v2
extension reuses existing images; this batch does not claim a new image build.

Reproduction and negative-oracle tests are in the
[managed MCP profile](../scripts/managed-mcp/README.md). This accepts the active-Run
portion of C1-05 for stable v1 and draft v2, not a crash during rebuild, RPC
response-loss windows, or C3-C6 in their entirety. Unknown in-flight Tool effects
are covered by the separate profile below.

### C1 Unknown-Effect Recovery (2026-09-10)

The recovery profile now holds a real Runtime Bash process after one physical
append. Before SIGKILL, the host requires the exact test scope/Agent labels,
unique container ID, exact marker, closed release gate and live Bash PID. ACP
must then retain `unresolved/quiescent/unknown/runtime_mcp` and a visible failed
Tool result explaining uncertainty. Here `quiescent` describes the local ACP
executor; neither it nor `admission_finished_at` proves remote quiescence or
released occupancy.

Repeated official-SDK replay must preserve the ordered history and emit the
unknown Tool result once. v2 emits exactly one `idle/_unresolved` state; v1's
original prompt loses its connection. Another Session receives the exact
`agent_busy` error without model/Tool work. Explicit administrator rebuild is
linked to the same admission by `run_admission_unresolved` and
`run_admission_released` events, including `runtime_replaced` and the source
Runtime revision from the internal event API. The public Console projection
must retain matching event identities. No Controller database access is used.

The host confirms old-container removal immediately after each rebuild, before
the next prompt or version can proceed. The new Runtime reads the retained
marker exactly once. Old Run/Tool records and history remain unknown and
unchanged after replay, rebuild and the later successful Run.

| Final evidence | Result |
| --- | --- |
| Stable v1 and draft v2 Docker | Eight real SIGKILL/restarts, two unknown in-flight Bash effects, two explicit rebuilds, 26 deterministic model requests |
| Jaeger | Four completed Gateway-rooted baseline/recovery traces, 812 spans; each verifies Identity, Controller, ACP model/context and Runtime MCP ancestry |
| Reusable tests | 150 shared fixture/oracle tests passed serially, including wrong/duplicate effects, hidden/duplicate terminal updates, premature release, incomplete checkpoint publication and failed cleanup |
| Admission | `make -j1 fmt-check lint` passed: Go lint 0 issues, both Rust Clippy targets, Node lint and all three Node/frontend typechecks |
| Resource lifetime | Both test invocations cleaned their owned resources; source-container retirement is checked before resumed work; final `passed` follows parent cleanup |

Two independent read-only reviews checked the recovery contract and test
implementation. Their findings strengthened visible-wire assertions, atomic
checkpoint publication and immediate retirement observation. No production
service behavior changed and no external Provider credentials were used. This
does not cover acquire/finish response-loss windows, crash-during-rebuild or
browser acceptance. Active-Run replacement on both versions is covered separately
above, rather than inferred from this unknown-effect profile.

Runtime-context feature accepted (2026-09-07): the four backend service-owned
batches, Console follow-up, and real Docker Gateway create/chat/rebuild flow are
complete. Five Runs verified
fresh runtime guidance, Skill summaries, managed stdio tools and Session reuse;
Jaeger parent relationships cover five information reads and seven Tool calls.
See [the feature report](runtime-context-and-managed-mcp.md) for reproducible
evidence and limits. This supplies a subset of C1-05/C1-06 evidence; it does not
close unrelated protocol, identity or operational checklist items.

C1-03 partial evidence (2026-09-07): the ACP-owned WebSocket/PostgreSQL happy
path suite passes 3/3 cases, including new stable-v1 reconnect and application
recreation cases. Repeated load retains identical history without more model,
Tool, or admission calls. The external ports are deterministic stubs, not a
real Runtime/Provider. The temporary database was removed; full process-crash,
Gateway integration, and Jaeger report acceptance remain open.

C1-04 partial evidence (2026-09-07): 16 v1/v2 wire/PostgreSQL cases now cover
cross-principal/Agent ownership, access-revision changes, principal deactivation,
and unauthorized cancellation of active Runs. They exposed and fixed disclosure
of a foreign Session's busy state before ownership checks. Controller/model/Tool
ports are deterministic; actual Identity/Gateway revocation remains unaccepted.
The complete ACP PostgreSQL profile passes 37 cases. Its worker-lock fault test
was also fixed to terminate only its own connection, not a same-key lock owner
in another database. C5-03 was still open at that checkpoint; its subsequent
measured disposition is recorded in the 2026-09-10 C5 batch above.

Gateway/integration batch accepted (2026-09-07): the explicit stable/draft Edge
routes now preserve protocol versions, with the existing Workspace route kept
as a v1 alias. `ANTNEST_E2E_ACP_CLOSEOUT=true make e2e-stage3` adds real
Identity/Controller/Runtime/PostgreSQL evidence for both versions: two users,
three Agents, cross-owner/Agent denials and owner deactivation on an existing
connection. It supersedes the service-only limitation above for these cases,
but not for access-revision changes or browser-token logout/expiry.

The same profile performs six actual ACP SIGKILL/restart cycles, covering
completed history, model-wait interruption and already-settled Tool effects.
Twenty deterministic model requests and six Runtime Tool calls verify history
replay without execution, no repeated Bash appends, truthful failed outcomes,
finished admissions and subsequent prompt usability. Ten fixture/oracle tests
cover malformed/replayed effects and missing, duplicated, mistyped or reordered
history. Two baseline Jaeger traces totaling 204 spans verify Gateway ancestry
through Identity, Controller, ACP and Runtime. All temporary containers,
volumes, networks and checkpoints are cleaned after the run.

This is a C1-03/04/05/06 evidence increment, not acceptance of all C1-C6.
At that checkpoint, unknown in-flight Tool effects, admission RPC response-loss
windows, active-Run rebuild, remaining Identity workflows and C5-03 CPU diagnosis
were still open. The current C1-C6 checklists above supersede this dated status.
The [integration README](../scripts/acp-closeout/README.md) and
[protocol matrix](../services/agent-acp-service/docs/protocol-conformance.md)
define the reproducible scope. No external Provider was used.

C2 Identity-owned admission batch (2026-09-08): local token issuance now
revalidates the verified password and exact active principal within its write
transaction. OIDC registrations keep issuer/Client ID immutable while allowing
secret rotation, and login completion checks expiry after database lock waits.
Fourteen new PostgreSQL component cases cover stale local snapshots, actual
administrator-deactivation concurrency, OIDC deadline boundaries and lock waits,
registration replacement rejection, secret rotation, and credential-free replay.
The local controlled HTTPS IdP performs real authorization redirects, PKCE,
client-secret authentication, and signed-token/JWKS verification.

The complete Identity service suite passes with race detection; aggregate Go
statement coverage is **67.1%**, including cross-package component execution
(`go test -race -coverpkg=./services/identity-service/... -p=1
./services/identity-service/...` with a dedicated test database). This is not a
coverage threshold or a claim that startup/telemetry and every error branch are
covered. Read-only adversarial review found a lock-order inversion and stale
completion clock during this batch; both were reproduced with actual PostgreSQL
blocking, fixed, and independently rechecked. The new tests remain reusable;
intermediate review/test logs are not retained as acceptance artifacts.

That service-owned batch covered Identity plus its contract/documentation.
Gateway-driven local/OIDC/SCIM workflow evidence, C2-04 browser logout/expiry
semantics and C2-05's journal business-effect decision remain open. No generic
event bus, downstream consumer, browser acceptance, or new Jaeger report is
claimed by this service-owned batch.

C2 Gateway integration batch (2026-09-08): the default Stage 3 suite now runs
`scripts/identity-closeout/client.mjs` through Edge, Console and real Identity.
Its **78 HTTP requests / 9 scenario groups** cover local cookie/CSRF/login/logout,
member restrictions, inactive Membership denial, global User token revocation,
SCIM User/Group lifecycle, pagination, group PATCH and unlinking, stable User
identity on reprovisioning, and replacement/revocation of SCIM credentials.
SCIM deactivation explicitly leaves the global User active. Both successful
single-resource reads and deleted-resource denial are asserted.

Three Jaeger traces (**18 spans**) verify causality, not only service presence:

| Entry | Required parent chain | Spans |
| --- | --- | --- |
| Local login | Edge -> Identity HTTP -> `identity.repository.issue_access_token` | 5 |
| Administrator SCIM token issuance | Edge -> Console -> Identity HTTP -> `identity.repository.issue_scim_token` | 9 |
| SCIM User creation | Edge -> Identity HTTP -> `identity.repository.create_scim_user` | 4 |

The checked traces contain none of the suite's synthetic passwords, session
cookies or SCIM credentials. Nine helper tests reject false trace ancestry,
cross-trace parent references, missing operations/Console, credential leakage
on failures and incorrect cache directives. Read-only adversarial review led to
stronger pagination, User-state and successful-read assertions. These are
reusable HTTP tests, not browser UI acceptance or full log-sink inspection.

C2-03 is closed; C2-01/04 have additional HTTP evidence but remain open for their
other requirements. At that batch boundary, C2-02 controlled IdP-through-Gateway
integration and C2-05's journal business-effect decision remained open. No event bus,
external Provider, cross-organization acceptance or whole-C2/C6 acceptance is
claimed. Final metrics belong here; transient logs and disposable traces are
not checked into Git.

C2 Gateway OIDC batch (2026-09-08): a controlled HTTPS IdP now exercises actual
discovery, authorization redirects, PKCE S256, client-secret authentication,
one-use code exchange, signed ID tokens and JWKS. The suite has **6 scenario
groups, 11 token exchanges/grants, 11 JWKS requests and 3 discovery requests**.
Local and SCIM login converge on their existing User/Membership; after SCIM
reactivation the same subject with a changed IdP email retains its original
identity. Inactive, unknown, unverified, administrator and wrong-nonce logins
are rejected. Provider revision/secret rotation and disable are also exercised.

The integration work reproduced and fixed Gateway login CSRF: a valid callback
was previously transferable to a different browser. Gateway now binds state to
an HttpOnly, SameSite=Lax transaction cookie (`__Host-` prefixed under HTTPS).
Missing, mismatched or duplicate bindings and ambiguous callback parameters are
rejected before Identity. Only the latest pending browser attempt is admitted;
failed foreign callbacks leave the existing application session untouched.
Identity remains authoritative for expiry and atomic transaction consumption.

Five additional Jaeger traces (**46 spans**) prove Gateway ancestry through
Identity's actual repository operations: three Provider registrations/updates
(11 spans each, through Console), login start (5), and callback completion (8).
Correlated request logs from Edge, Console and Identity are required, not merely
nonempty logs. Raw/URL-encoded synthetic secrets, PKCE verifiers, Basic credential
values and complete signed ID tokens are scanned in traces and service logs.
The fixture exposes test-only canaries; it is never enabled in deployment Compose.

Read-only adversarial review found evidence weaknesses in diagnostics, encoded
credential coverage and stable-subject assertions; all were addressed. The
**15 fixture/helper tests** include negative tests proving leakage and missing
log/trace ancestry fail without redisclosing credentials. The default Stage 3
suite passed, including the existing administrator lifecycle and workspace ACP
checks. Disposable containers, volumes and networks were cleaned by the parent.
C2-02 is accepted for this controlled HTTP profile. Cross-organization access,
session expiry, remaining ACP revocation semantics and C2-05 still need their
own batches; no whole-C2, vendor IdP UI or browser UI acceptance is claimed.

Final admission for this batch: `make fmt-check` and `make lint` passed
(Go lint: 0 issues; both Rust Clippy targets: no warnings; Node lint/typechecks
passed), all six Edge Gateway test packages passed with `-race -p=1`, and the
15 identity fixture/helper tests passed serially. Gateway's session contract
and the changed documentation were synchronized; no threshold was relaxed.

C2 HTTP access batch (2026-09-08): `make e2e-identity-access` adds a separate,
disposable profile instead of accumulating attempts against the existing login
limit. Private Identity RPC prepares two organizations; all access assertions
use Edge with real service databases. No direct SQL changes are used. Its four
scenario groups prove:

1. Same email can belong to distinct Users in separate organizations; one User
   can be admin in A and member in B without reusing A's role or forged scope.
2. SCIM foreign User/Group reads and deletes are denied; owner-side full
   snapshots, versions and members remain unchanged. Cross-organization Group
   membership references and unauthorized token revocation are rejected.
3. A User's password change affects new login in both organizations, not a
   different User with the same email. Existing sessions remain valid under
   the current contract. Logout revokes only its presented token.
4. Membership disable blocks only that organization's access; restoring it
   permits still-valid old tokens. Global User disable denies new login in both
   organizations and permanently revokes their old tokens, without affecting
   the distinct same-email User.

This batch reproduced and fixed an Edge error classification defect: Identity
timeouts/transport/server failures were reported as invalid sessions, clearing
cookies. They now fail closed with 503 and no cookie mutation. Real Docker
outage/restart checks prove the original cookie recovers. After restart, the
existing TTL setting issues new sessions with five-second lifetimes, while old
tokens keep their original stored deadlines. The client waits past the issued
`expires_at`, replays the cookie against three protected paths, verifies both
session and CSRF cookies are cleared, and proves an expired password command
cannot mutate credentials. A fresh login still succeeds. This is actual token
expiration, not browser eviction, a changed clock or a fabricated database row.

Three Gateway-rooted Jaeger chains contain **23 spans**: password change via
Console (10), User disable via Console (9), and expired-token resolution (4).
They include the owning Identity repository operation and exclude synthetic
credential canaries. The Identity outage naturally has no successful downstream
repository span and is not presented as such.

Read-only review strengthened disabled-new-login, unaffected-User, complete
resource-snapshot and both-cookie assertions. **18 reusable helper tests** pass,
including negative evidence cases. Temporary resources are removed after the
profile; no intermediate logs or database artifacts are committed.

Final admission: `make fmt-check`, `make lint` (Go: 0 issues; both Clippy targets
and Node lint/typechecks passed), all six Gateway test packages with
`go test -race -p=1`, all 18 fixture/helper tests, contract JSON and shell syntax
checks passed. The dedicated identity-access Compose profile passed; this run
does not claim a fresh default Stage 3 lifecycle or ACP fault-profile execution.

### Next Identity Consumer Boundaries

The HTTP access review also identified two boundaries that must not be silently
declared accepted by its passing tests:

1. **Admin Console (closed for in-page handling):** the blanket password-path
   401 exemption is removed. Contract revision 33 distinguishes
   `invalid_current_password` from Gateway session rejection; malformed/unknown
   401s also notify the session owner. Notifications belong to the requesting
   page session and cannot invalidate a later in-page login. This does not
   prevent the browser from applying an older response's `Set-Cookie` headers,
   synchronize separate tabs, or prove revocation after Gateway admission.
   Changing one's password deliberately preserves issued Identity tokens.
2. **SCIM revoke scope:** Identity authorizes against the token's owning
   organization. The new tests prove an administrator without authority there
   cannot revoke its token. They do not impose a stronger current-browser-
   organization boundary on a User who administers both organizations. Any
   stricter rule needs an explicit Identity/Console contract decision first.

### Console Password And Session Consumer Batch

Only Admin Console implementation changed; Identity and Edge authority rules
remain unchanged. Documentation and error contract preceded failing BFF/API
tests, then implementation. Two read-only reviews checked error provenance and
notification races; their executable regression cases are retained in the
owning service, not separate review artifacts.

| Evidence | Result |
| --- | --- |
| Console Go tests, including race detection | 5 test packages passed |
| Console pure unit tests | 81 passed |
| Console component/API/App tests, one worker | 139 passed |
| Identity fixture/helper tests | 18 passed |
| Real Identity HTTP access/expiry profile | Passed; 3 Gateway-rooted causal traces, 23 spans |
| Default Stage 3 Docker regression | Identity/SCIM/OIDC, administrator lifecycle, Agent workspace ACP and Jaeger passed |

The HTTP profile asserts the password endpoint's exact rejection codes and
cookie behavior before and after natural token expiry, then proves rejected
expiry did not change the password. App tests verify retained form input on
credential rejection, actual return to login on session rejection, and late
JSON/malformed/unreadable responses after a new login. Session start and end
notification invalidation are independently tested. These are reusable
component tests, not a claim of fresh live-browser acceptance.

Admission passed: `make fmt-check`, `make lint` (Go: 0 issues; both Rust Clippy
targets and Node checks), contract JSON/shell syntax checks, and the rebuilt
Console production image. Both disposable Compose profiles clean their own
containers, volumes and networks. Existing retained development instances are
not replaced. C2-01/04 remain open for the separately scoped Agent/ACP access
and already-upgraded connection boundaries above.

### Gateway ACP Browser Session Batch

Gateway contract revision 8 and implementation now retain the original browser
token only at Edge and revalidate each complete client message. Both ACP
versions remain opaque; no ACP/Identity service implementation changed. Invalid
sessions close with 1008, dependency failures with 1013. Bounded buffering and
connection admission accompany the relay. Two read-only reviews identified and
then confirmed fixes for shutdown isolation and waiting for hijacked handlers.

| Final Evidence (2026-09-08) | Result |
| --- | --- |
| Gateway tests, `-race -p=1` | 7 packages passed, including shutdown orchestration |
| Identity integration fixture/helper tests | 18 passed |
| `make fmt-check` / `make lint` | Passed; Go 0 issues, both Rust Clippy targets and Node checks passed |
| Rebuilt Gateway / default Stage 3 Docker regression | Passed; local/OIDC/SCIM, lifecycle, Workspace ACP and Jaeger |
| Real v1/v2 existing-connection logout | Both prompts rejected with 1008; new login recovers the same empty Session |
| Additional Identity Jaeger evidence | 2 Gateway-rooted repository parent chains; 52 spans observed at acceptance |

Reusable relay tests cover mismatched identity, explicit inactivity, authority
failure/timeout, fragmented and pipelined messages, opaque binary/empty payloads,
resource limits and socket cleanup. Lifecycle tests cover signal/listener-error
paths, HTTP context preservation and waiting for handler completion; they are
not a claim of SIGTERM-under-load exporter delivery testing. The disposable
Docker suite cleans its containers, volumes and networks; retained development
instances are untouched.

At the end of this Gateway implementation batch, C2-04 still required real
post-upgrade expiry, Identity outage/recovery and already-admitted Run evidence;
the integration batch below closes that gap. There is no idle revocation poll, automatic
Run cancellation, or atomic transaction between Identity validation and ACP
Run creation. Browser UX for transport rejection is a separate Agent UI batch.

### ACP Session Fault Integration Batch

C2-04 accepted on 2026-09-08. `make e2e-acp-session` adds a separate disposable
profile using official v1/v2 SDKs, real Gateway/Identity/ACP/Runtime services,
PostgreSQL and Jaeger. The coordinator alone injects Docker faults. A local
model fixture controls execution barriers; no external Provider is required.

| Final Evidence | Result |
| --- | --- |
| Post-upgrade Identity outage and natural expiry | 4 prompts rejected with 1013/1008; ACP session/Run/message/Tool snapshots unchanged |
| Identity recovery | Original long-lived cookie reconnects; short tokens expire at their issued deadlines without DB/clock modification |
| Already-running work after browser logout/disconnect | 2 original Runs complete, preserve admission identity and release admission; 2 subsequent authenticated Runs complete |
| Real Runtime effects and replay | Successful structured Bash results contain exactly one ordered append per Run; load/resume changes neither execution history nor model-call count |
| Gateway-rooted Jaeger evidence | 8 causal traces, 490 spans observed; rejection checks and execution/Runtime/model ancestry verified; current credentials absent |
| Existing default Stage 3 + ACP closeout regression | Identity/SCIM/OIDC, lifecycle, workspace ACP, isolation and all 6 SIGKILL/restart scenarios passed |
| Reusable fixture tests | 42 passed serially; include negative tests for false Tool success, duplicate effects, missing trace ancestry and encoded credential leakage |

Independent read-only review tightened Tool evidence and dynamic secret scanning.
The older closeout profile now correctly expects owner deactivation to reject at
Gateway before ACP creates even a failed Run intent. Only reusable tests and
compact final results are retained, not intermediate logs or database dumps.
Both disposable profiles cleaned their own resources; retained development
instances were untouched. Service implementation and deployment contracts did
not change; the existing accepted images were reused with the updated fixtures.

Admission: `make fmt-check`, `make lint`, all affected fixture tests, shell syntax
and changed documentation checks passed. C2-01's cross-organization Agent/ACP
entry and C2-05's Identity journal business-effect decision remain open. Browser
rejection UX and outages inside an active Run are not accepted by this batch.

### Agent Organization Access Batch

C2-01 accepted on 2026-09-08. `make e2e-agent-access` exercises two organizations
through the real Gateway with one shared Agent owner and distinct organization
roles. A read-only review found that four lifecycle commands checked source
state before organization scope, exposing foreign Agent state through 409 versus
404 responses. Service-owned fix `a1f68d0` orders scope checks first; its
state/command matrix passed after failing against the original implementation.

| Final Evidence | Result |
| --- | --- |
| Agent Controller tests, `-race -p=1` | 13 packages passed |
| Agent/catalog/admin boundaries | 36 denied requests; foreign lifecycle/reference access, forged scope and member/admin boundaries verified |
| ACP v1/v2 organization and Session boundaries | 6 denied upgrades, 20 denied Session commands, no foreign history, durable mutations or model calls |
| Shared User with separate Memberships | 2 revocations reject existing B connections; A remains usable; restoring B replays its own history |
| Authorized execution and replay | 4 completed Runs; organization-specific credentials/model/context verified; version-correct private history replayed without another model call |
| Gateway-rooted Jaeger evidence | 12 causal traces, 631 spans observed; Console/Controller and ACP/model ancestry verified, current credentials absent |
| Reusable fixture tests | 50 passed serially; negative cases cover v1/v2 message shape/order/IDs, error payloads, revocation notifications and context checkpoint changes |
| Default Stage 3 Docker regression | Identity/SCIM/OIDC, authorized lifecycle, Workspace ACP and Jaeger passed |
| Admission | `make fmt-check`, `make lint` (Go 0 issues, both Rust Clippy targets and Node checks), shell syntax and changed documentation links passed |

Replay assertions allow exactly the target Session's new client MCP revision
and pointer/timestamp update; all prior revisions, foreign Sessions, Runs, Tools,
messages and context checkpoints remain unchanged. Full ordered wire history
must match persisted messages. This records the actual resume contract rather
than exempting an entire table. The model is a deterministic local protocol
fixture, not an external Provider; this is not fresh browser acceptance.
Independent read-only review drove the retained replay, denial-payload,
notification and checkpoint negative cases; only the coordinator ran tests.
C2-05's implementation remains pending, and C2 as a whole is not
yet accepted. Disposable test resources are cleaned; retained instances remain
untouched.

### C2-05: Identity Effects Versus Agent Lifecycle

Status: automatic Agent disable with retained data is required; implementation
is split into service-owned batches. The table records the pre-consumer baseline. Do not
mark C2 complete solely because access-isolation tests pass.

| Change | Current effect | Not implied |
| --- | --- | --- |
| User inactive | Identity rejects affected principals and revokes that User's tokens; fresh Agent admissions fail | Runtime shutdown, background-process termination or delegated-credential revocation |
| Membership inactive or SCIM DELETE | Current organization access is denied; another active organization of the same User is unaffected | Agent disable/delete, workspace removal, permanent loss of the stable User's old Agent/history |
| Membership restored/reprovisioned | If User/organization and the Agent's own binding/lifecycle are usable, current owner resolution succeeds without rebuilding | Old SCIM-tombstoned Membership tokens becoming valid; implicit enable of an explicitly disabled Agent |
| Role/profile/group change | Identity owns current profile and administrative permissions; an active member retains their own Agent usage | Owner reassignment, executable revision changes or group-driven Agent policy; no such policy is implemented |
| Identity unavailable | New access and fresh Run admission fail closed | Lifecycle state changes or a distributed revocation transaction |
| Previously committed admission | Exact retries retain the snapshot; credential resolution uses admission scope/state/deadline, while settlement does not recheck Identity | No execution after deactivation: ACP recovery of `admitting` work may start the first execution later |

The original whitepaper, section 8.1, describes employee departure as Agent
freeze, delegated-credential recovery and retained audit. The original IdP
sequence, section 12, explicitly connects SCIM inactivity to those effects.
Those product goals cannot be dismissed merely because current access checks
do not need a journal consumer. The current platform has no independent
delegated-credential lifecycle; a shared Model Profile credential must not be
globally revoked to offboard one owner.

The confirmed choice is **automatic Agent disable while retaining data**.
Define the Identity delivery contract first, then implement the
Identity producer, Agent Controller consumer, and integration as separate
service-owned batches. Agent Controller must retain authoritative Identity
checks regardless of delivery delay. Re-enabling Identity must not silently
enable a manually disabled Agent; idempotency and recovery belong to the
selected workflow, not a generic event bus.

Automatic disable is not emergency termination: the existing command drains
Run occupancy and can fail at its drain deadline. If immediate interruption or
strong credential revocation is required, define those effects explicitly
instead of routing an Identity event to `disable` and calling it complete.
SCIM reprovisioning also needs an explicit choice between stable-User continuity
and a new manual reauthorization requirement. Current semantics use continuity
with a fresh login after a tombstone; same email alone never transfers identity.

Reusable [Controller regression cases](../services/agent-controller/internal/application/run_identity_test.go)
cover active -> inactive/absent/unavailable -> restored resolution without
replacing an otherwise valid Agent binding, retained independent Agent denial,
and the distinction between committed admission retry, fresh admission and
terminal settlement. They test current contract semantics, not delivery or
automatic offboarding. C2-01/04 retain their previously recorded Gateway/E2E
evidence; no new Docker or live-provider result is asserted by this assessment.

Verification (2026-09-08): six focused cases passed with `-count=1`; Controller
`go test -race -p=1 ./services/agent-controller/...`, `make fmt-check`, `make lint`
(Go 0 issues, both Rust Clippy targets and Node checks), and changed-document
link checks passed. Production behavior is unchanged; database-specific and
Docker profiles were not rerun. The read-only reviewer is closed.

#### C2-05 Delivery: Identity Producer

Identity now commits `principal_revocations` atomically with local/global
deactivation and SCIM inactive/delete. The private bounded RPC returns a
commit-ordered replayable stream, scoped by stable User and optional
Organization, with only source trace context and no credentials/profile data.
The service documentation and machine contract describe retention and recovery.

Final service verification (2026-09-08): all 15 Identity Go packages passed
`go test -race -p=1 ./services/identity-service/... -count=1` with real isolated
PostgreSQL. Regression cases cover local/SCIM/global scope, unchanged/restored
identities, SCIM HTTP -> revocation RPC, pagination/replay, commit ordering,
sequence allocation only after acquiring the writer lock, rollback gaps, and
feed failure rolling back all four mutations including SCIM group edges and
timestamps. A synthetic trigger failure is asserted explicitly, so unrelated
validation failures cannot manufacture a passing rollback test.

Admission: `make fmt-check`, `make lint` (Go 0 issues, both Rust Clippy
all-target checks, Node lint/type checks), Identity route/contract tests and 18
local document-link checks passed. The dedicated PostgreSQL test container,
networks and volume were removed; retained development instances were untouched.

Read-only review found no confirmed producer implementation defect; its two
coverage findings (lock-before-allocation and non-global rollback) are now
covered. Reviewers are closed. No cross-service Agent-disable or new Jaeger
acceptance is claimed by these service-owned tests.

The following Controller batch delivers durable consumption, creation/enable
authorization boundaries, and disable-failure convergence. Scoped
Gateway/Runtime/Jaeger integration remains a separate batch. Identity restoration
must not undo consumed offboarding. C2-05 remains open until integration passes.

#### C2-05 Delivery: Controller Consumer

The [service design](../services/agent-controller/docs/identity-offboarding.md)
defines a narrow Identity RPC consumer, per-owner revocation watermarks, and an
atomic local receipt/admission boundary. Global User events match all owned
Agents; Membership events match only that organization. New admissions are
fenced while admitted work retains its snapshot and completion contract.

The existing Disable recovery worker handles network fencing and Runtime stop.
An unavailable/uncertain Runtime remains visibly pending, never falsely reported
as disabled. Terminal known failures retain the fence and retry after cooldown.
Identity restoration alone cannot Enable; explicit Enable requires fresh active
owner authorization. No Agent/workspace/audit data or shared provider credential
is deleted. Migration 4 touches only the Controller schema.

Service regressions cover ordered/invalid feed pages, duplicate receipt, scoped
and global fences, late/concurrent Create, fresh admission versus replay/finish,
receipt rollback, consumer restart, source outage with local pending work,
busy candidate fairness, failed Disable cooldown/retry, explicit Enable, source
trace propagation, and global/per-Agent event replay/watch. Read-only review
identified event-type whitelist and compensation recheck gaps; both now have
regression coverage. No new full-platform Docker or Jaeger acceptance is claimed.

Final service verification (2026-09-08): all 13 Controller Go packages passed
`go test -race -coverprofile=.cache/agent-controller-offboarding.cover -p=1
./services/agent-controller/... -count=1` with the real isolated PostgreSQL
profile. Total statement coverage is 69.5%; application 75.7%, Identity client
87.0%, and PostgreSQL repository 66.8%. `make fmt-check` and `make lint` passed
(Go 0 issues, both Rust Clippy all-target checks, Node lint/type checks).
Repeated acceptance exposed fixed-ID fixture leakage in the existing HTTP/DB
tests; each now resets only the Controller schema in an explicitly named test
database. The final full profile passed without rebuilding the database first.
Reviewers are closed, and this batch's dedicated PostgreSQL container, networks,
and volume have been removed. Existing development instances were not changed.

#### C2-05 Delivery: Docker Integration

Final acceptance (2026-09-08), reproducible with `make e2e-agent-access`:

| Business assertion | Final result |
| --- | --- |
| Membership inactive, ACP v1/v2 | Only B's Agent/Runtime disabled; A stays usable; inactive Enable rejected |
| Global User inactive | Both owned Agents disabled, another owner unaffected; event created while Controller stopped is consumed after restart |
| Identity restoration | No automatic Enable; explicit Enable retains workspace sentinel and permits fresh ACP/model requests |
| SCIM delete/reprovision | B disabled, same User's A Agent still usable; stable User/new Membership; prior nonempty Session replays after explicit Enable |
| Durable data | Existing ACP Session/Run/message/checkpoint records preserved; prior Agent events retained; model credentials still usable |
| Final counts | 9 completed Runs; 5 automatic Disables; 36 rejected admin actions, 8 rejected upgrades, 20 rejected foreign Session commands |
| Jaeger | 4 source traces, 20 linked Disable phase checks; 19 access/model traces with 1,115 spans |

Source trace IDs for the final disposable run:

| Scenario | Gateway trace ID |
| --- | --- |
| Membership v1 | `9ff0185fd940f166a56006fdfe234cb9` |
| Membership v2 | `ec48c8b301c2f2ac0124c21b53df205e` |
| Global/offline consumer | `97bcfa10d74010316efbed604142999e` |
| SCIM deletion | `a32c4ba9f81b9bc28140010110f37ff9` |

The oracle follows exact parent and `FOLLOWS_FROM` IDs from Gateway/Identity
receipt and matching Agent scheduling to all four worker phases. It requires
Egress attachment PUT and Runtime Disable POST under the correct phase;
an unrelated Inspect span cannot pass. This stronger check exposed lost
`Request.Pattern` in Runtime Controller's deadline wrapper, fixed in `652c469`
with five routing regression cases and full service race tests.

The [reusable suite](../scripts/identity-closeout/README.md) uses real internal
services, one isolated PostgreSQL instance with service-owned databases, official
ACP/MCP SDKs, and a deterministic local model/HTTPS IdP. It does not claim a real
external Provider or fresh browser UI acceptance. Mid-Disable crash injection,
unavailable Runtime recovery and emergency cancellation are not accepted here;
their fences and pending semantics remain explicit, not fabricated success.
All temporary containers, volumes and networks were removed, including dynamic
Runtimes/workspaces. Jaeger links are therefore ephemeral; only these compact
final metrics are retained. C2-05 is accepted, not the entire C2/C6 milestone.

All 42 fixture tests passed, including real child-process stderr/exit assertions
for bootstrap, cleanup and asynchronous Pool errors. Read-only adversarial
review led to the cross-organization SCIM control, nonempty history, fresh Run,
exact mutation-route and failure-output checks; reviewers are closed.
Final admission also passed `make fmt-check`, `make lint`, shell syntax and
changed-document local-link checks. Runtime Controller's full service race
profile passed; real PostgreSQL integration is covered by the Docker run above.

### ACP Cost Integration Increment (2026-09-10)

F10's Controller, Console/BFF, ACP and Agent UI batches are now followed by a
passing disposable Docker integration profile. The final 52 model calls cover
all three protocol entrances, immutable admission pricing (including a revision
published while a request is running), returned model options, restart/fork
accounting and identity isolation. Thirty Jaeger traces validate Gateway-rooted
execution and pricing paths. Test-owned resources were removed; retained
development instances were not replaced.

Final metrics, executable tests and limits are maintained once in
[F10 deployed integration](../services/agent-acp-service/docs/protocol-conformance.md#session-cost-f10-deployed-integration-2026-09-10).
This increments C1/C3/C6 evidence; it does not auto-check their remaining
requirements or replace C4 deployed-browser and C5 operations acceptance.
F07 remains explicitly deferred. The next closeout batch should reconcile C1's
interface matrix against the accumulated executable evidence before filling
remaining Docker business-workflow and operational gaps.
