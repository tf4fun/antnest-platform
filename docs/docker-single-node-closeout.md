# Docker Single-Node Closeout

> Status: execution plan; acceptance remains open
>
> Updated: 2026-09-08
>
> Inspection baseline: `c989f20`

## 1. Stage Boundary

The next delivery is a complete single-node product, not another service split.
Close three business flows through the real Edge Gateway:

1. Identity: provision a person, authenticate, use the authorized application,
   and revoke access correctly.
2. Agent management: configure a model and Template, create and operate an
   isolated Agent, and observe a definitive lifecycle outcome.
3. Agent usage: enter Agent UI, converse through ACP, use Runtime Tools, cancel,
   and recover conversation state after reconnecting.

ACP protocol support is the first implementation priority. Identity integration
is the second. Documentation, operations, and Gateway-rooted Jaeger evidence
are delivery requirements, not work left for a later production stage.

This plan controls the remaining work. Earlier accepted stages remain evidence
for their specific cases, not proof that every flow below has been accepted.
Service documents and `contracts/` remain the authorities for service behavior.

### Deferred explicitly

| Work | Decision in this stage |
| --- | --- |
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

| Area | Existing implementation/evidence | Remaining closeout work |
| --- | --- | --- |
| ACP | official SDK `1.4.0`, stable `/v1/acp`, draft `/v2/acp`, shared application core, capability and wire tests | explicit Streamable-HTTP-only MCP profile; wire plus persistence evidence for reconnect, isolation, cancellation, and revision changes |
| Identity | local login, OIDC, SCIM, membership checks, transactional local journal, Console administration | prove the complete Gateway flows and effective deactivation across existing connections; identify any necessary downstream lifecycle synchronization |
| Agent management | async lifecycle operations, immutable revisions, Docker Runtime, Egress, durable events | close remaining UI/owner-service error and recovery paths against the three-flow acceptance matrix |
| Agent UI | production Edge-to-ACP v1 path, messages, attachments, Tool activity, cancel and replay | prove restored input availability, no duplicate execution on reconnect, and consistent visibility of authoritative outcomes |
| Observability | service OTLP, Stage 3 admission/linked lifecycle-worker traces, Gateway-rooted managed MCP create/chat/rebuild evidence | one reproducible report covering Gateway-origin identity, lifecycle, and ACP/Runtime execution; verify causality, not just service-name presence |
| Operations | Compose builds, private logical databases, disposable test cleanup | clean bootstrap runbook, restore exercise, failure diagnostics, idle CPU investigation, final resource accounting |

Important distinctions from inspection:

- The ACP protocol matrix explicitly identifies stdio MCP as a stable-v1
  baseline incompatibility. This stage deliberately supports only Streamable
  HTTP MCP and does not claim complete v1 conformance. Optional unadvertised
  protocol capabilities are not gaps.
- `scripts/stage3-workspace-client.mjs` tests v1 prompt and load on the same
  connection. That is not reconnect or process-restart evidence.
- Agent Controller already checks Identity at Run admission. The absence of
  cross-service Identity event delivery does not by itself prove an access
  control defect. Do not add an event bus to solve a check that already exists.
- Stage 3 Jaeger assertions cover lifecycle admission/worker phases and managed
  MCP execution. They do not yet produce the required identity, management,
  and usage three-flow verification report.
- Idle container CPU spikes remain an unconfirmed diagnosis, not a solved issue.

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

- [ ] **C1-01** Reconcile stable v1 and draft v2 separately against the pinned
  official SDK schemas. Enumerate baseline requirements, advertised options,
  unsupported options, exact external routes, and their executable tests.
- [x] **C1-02** Close the Streamable-HTTP-only MCP product boundary with explicit
  wire rejection tests for stdio and legacy SSE input. Platform Runtime MCP
  remains configuration-owned; client MCP remains Session-owned. Runtime-owned
  stdio hosting is delivered through the separate service batches in
  [Runtime Context And Managed MCP](runtime-context-and-managed-mcp.md), not by
  launching client-selected commands in ACP Service. Preserve the
  documented v1 baseline incompatibility instead of claiming full conformance.
  Accepted at the service wire/persistence boundary by
  `test/e2e/acp-mcp-input.postgres.test.ts` (six cases, both versions, all setup
  methods, mixed valid/invalid inputs, closed Sessions and encrypted revisions).
- [ ] **C1-03** Exercise both versions over real WebSockets and PostgreSQL:
  new, prompt, user/assistant/Tool history, version-specific completion,
  reconnect, load/resume, list, and the advertised lifecycle operations.
- [ ] **C1-04** Prove cross-user/Agent isolation, access revision invalidation,
  semantic cancel, and honest error/capability behavior at the wire boundary.
- [ ] **C1-05** Verify service restart recovery and explicit Agent rebuild:
  durable history survives, replay never invokes model/Tools, Run A keeps its
  captured Runtime, and Run B receives the published replacement. Interrupted
  in-flight Tool effects remain distinct from replaying completed history.
- [ ] **C1-06** Propagate Gateway-origin request context through ACP admission,
  model requests, and Runtime MCP. Preserve standard ACP payloads; do not add
  private Agent-routing fields to the protocol.

**Milestone C1:** the declared HTTP-only ACP profile has no unacknowledged
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

- [ ] **C3-01** Verify empty instance -> model -> Template -> active owner ->
  Agent -> ready Runtime, using only the administrator's Gateway entrypoints.
- [ ] **C3-02** Cover create, rebuild, disable, enable, and delete with durable
  operation status, actionable failure cause, event recovery, and UI feedback.
  Accepted `202` is never presented as a completed build.
- [ ] **C3-03** Verify immutable configuration and workspace behavior: revision
  publication does not silently rebuild existing Agents; explicit rebuild
  blocks new Runs; disable retains the workspace; delete follows the documented
  removal/retention contract.
- [ ] **C3-04** Exercise Egress policy changes and Runtime-start failures without
  introducing a new deployment platform, MCP proxy, or rollout mechanism.
- [ ] **C3-05** Check restart recovery of the single lifecycle worker and event
  replay from its authoritative cursor. Duplicate requests must not create a
  second Agent, Runtime, or lifecycle effect.

**Milestone C3:** each lifecycle command ends in a visible, authoritative
success or failure; the administrator can locate and correct ordinary Docker
configuration errors without reading a database or guessing hidden state.

### 4. Agent WebUI Usage Closure (C4)

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

### 5. Docker Operations And Maintainer Documentation (C5)

- [ ] **C5-01** Document and exercise clean image build, runtime image/tag
  availability, one-node startup, bootstrap accounts, secrets, ports, and
  readiness. Never commit test credentials or integration secrets.
- [ ] **C5-02** Exercise backup and restore of each service-owned database plus
  workspace data and required encryption keys. State the single-node quiescence
  procedure; do not imply cross-service atomic online backup exists.
- [ ] **C5-03** Diagnose the reported idle CPU spikes with bounded sampling,
  per-service attribution, and a regression check if code is at fault. Record
  sample duration, host/container environment, idle/busy baselines, and outcome.
- [ ] **C5-04** Verify shutdown, restart, incomplete-operation diagnosis, log
  access, Jaeger navigation, and cleanup for success/failure/interruption. Each
  test deletes only resources it created; retained acceptance stacks are named.
- [ ] **C5-05** Align root quickstart, service READMEs, contracts, business
  sequences, feature surfaces, and known limits with executable behavior.

**Milestone C5:** another maintainer can build, operate, diagnose, back up,
restore, and clean up the single-node instance using repository documentation.
The idle CPU concern has a measured disposition, not an assumed fix.

### 6. Integrated Acceptance And Jaeger Report (C6)

- [ ] **C6-01** Run repository admission and complete single-node regression
  serially on the final candidate, using one shared test PostgreSQL instance
  with private service databases. Record skipped cases separately.
- [ ] **C6-02** Execute every scenario in section 4, including the actual browser
  flows. Use controlled protocol peers for deterministic regression; report
  separately any real IdP/Provider checks and their limitations.
- [ ] **C6-03** Query Jaeger and validate the causal paths in section 5. A trace
  containing the expected service names is not sufficient evidence.
- [ ] **C6-04** Produce `docs/docker-single-node-verification-report.md` from
  actual final results. Include source revision, commands, final quantitative
  results, scenario IDs, trace links, known limits, and cleanup outcome.

**Milestone C6:** all in-scope scenarios pass, no unresolved correctness defect
breaks the three flows, and the Jaeger report independently demonstrates their
entry-to-owner/dependency causality. Deferred services remain deferred.

## 4. Business Acceptance Matrix

| ID | Entry and scenario | Required observable outcome |
| --- | --- | --- |
| ID-01 | Edge local login -> Console/Workspace -> logout | correct role/application, revoked session rejected |
| ID-02 | Edge OIDC start -> IdP -> Edge callback -> Identity | same provisioned subject, server-owned credential exchange |
| ID-03 | Edge SCIM User/Group changes -> Identity -> Agent admission | intended membership changes and disabled-user denial, no cross-organization mutation |
| MG-01 | Edge Console model/Template/Agent create | durable operation, ready Runtime, immutable executable lineage |
| MG-02 | Edge Console rebuild/disable/enable/delete | correct admission boundary, retained or removed workspace per command, visible outcome |
| USE-01 | Edge Agent UI ACP Session prompt -> model -> Runtime Tool -> reply | ordered visible activity and durable conversation, usable composer after completion |
| USE-02 | ACP v1/v2 cancel/reconnect/load or resume | version-correct terminal state, no duplicate model/Tool effects from replay |
| USE-03 | open Session across identity change or explicit rebuild | authorization rechecked, old Runtime not reused for a new Run |
| OPS-01 | fresh Docker deployment, restart, backup/restore, cleanup | documented recovery and no orphan test resources |

These IDs identify acceptance scenarios, not new persisted business entities.

## 5. Gateway-Rooted Observability Contract

Instrument the actual services in each path, not every service in every trace:

| Flow | Expected causal path |
| --- | --- |
| Local identity | Edge Gateway -> Identity RPC -> Identity PostgreSQL spans |
| OIDC | Edge start -> Identity -> IdP request spans; later Edge callback -> Identity -> IdP token/UserInfo and owned persistence |
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

Current progress: closeout reconciled against `c989f20`; C1-C6 are not yet
accepted. The reconciliation itself adds no execution evidence. Update
individual items with final evidence as work completes.

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
in another database. C5-03 idle CPU diagnosis remains open.

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
Unknown in-flight Tool effects, admission RPC response-loss windows, active-Run
rebuild, remaining Identity workflows and C5-03 CPU diagnosis remain open.
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
