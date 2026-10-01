# Current Implementation And Acceptance

Skill Registry's first release is accepted for the current clean development
deployment. There is no legacy business data to migrate. Old shared-volume
migration, protected off-host legacy export and exceptional legacy-source
restoration are removed from compiled services, current contracts and runnable
acceptance entrypoints. The [2026-10-01 release cleanup](legacy-skill-release-cleanup-20261001.md)
records the source, image and fresh-schema boundary. The
[acceptance audit](skill-registry-acceptance-audit-20260928.md) records the evidence
and limits; the [minimal design](skill-registry-minimal-design.md) defines the
implemented hosting, frozen Template references and read-only Runtime delivery.

On 2026-10-01 the user defined the next [Skill propagation
design](evolver-technical-analysis.md#112-用户确定的四步产品流程): automatically
project metadata and dynamic source references for applied Agent Skills into
Registry, search and fetch source content for temporary use within a Run, let
authorized users promote selected packages into Registry-owned immutable system
Skill versions, then deliver presets through Template revisions and explicit
rebuilds. Projection stores no complete package and follows the source Agent's
content and lifecycle. Full package custody and independent version lifecycle
belong to Registry only after promotion. The [Registry/source contract](../contracts/skill-registry/discovery-api.md)
and Registry D1 are now implemented: metadata-only ordered mappings,
current-source inspection/search/load and atomic promotion pass service,
real HTTP/PostgreSQL/race and isolated Docker gates. The
[delivery report](skill-discovery-registry-delivery-20261001.md) records the
explicit source fixture and cleanup. [ACP D2](skill-discovery-acp-delivery-20261001.md)
now delivers automatic metadata projection, durable reconciliation/retry/removal
and protected current-source reads, with unit/contract/HTTP/PostgreSQL and real
learning Docker evidence. [ACP D3](skill-discovery-tools-delivery-20261001.md)
adds actual model find/load tools, durable Run-derived authorization and budgets,
verified package text, and source/digest Trace evidence. Full unit/PostgreSQL,
real HTTP and dual-Agent deterministic Docker gates pass. [Runtime D4](skill-discovery-runtime-delivery-20261001.md)
now implements the [private temporary wire contract](../contracts/runtime/temporary-skills.md):
real Run-bound files, normal read/foreground Bash use, strict replay/quota and
release/startup/shutdown cleanup pass unit, Linux executor and named-volume HTTP
gates. [ACP D4A](skill-discovery-temporary-consumer-delivery-20261001.md) now consumes
real files with durable scopes, foreground/learning/lifecycle admission guards,
and completion/cancellation/restart cleanup. Its unit, contract, real HTTP,
PostgreSQL and isolated dual-Agent Docker gates pass, including exported Native
install/release traces and actual read/Bash use. [Console D6](skill-discovery-console-delivery-20261001.md)
now provides owner-scoped source search, verified package preview and explicit
create/append promotion, with unit/contract/HTTP/build and desktop/mobile Docker
gates. Registry terminal cursors are normalized for the current-head UI.
[DI1 full propagation](skill-propagation-integration-delivery-20261001.md) now passes
the actual automatic-learning/source/temporary-use → real Console promotion →
frozen Template/create/rebuild/Run Docker workflow. It proves two distinct
versions, existing-preset use during Registry outage, independent formal bytes
after source invalidation and six completed preset Runs. All test resources are
removed and the pre-existing stopped deployment is preserved. The first release
above retains its delivered scope; this is scoped integration evidence, not a
whole-repository current-HEAD admission.

The [normal-deployment batch](skill-deployment-delivery-20261001.md) additionally
connects the existing private signer, public verifier set and shared source bearer
in standard Compose. Six configuration/build-plan tests and the full disposable DI1
workflow pass without test-only authentication overrides. The
[operator guide](skill-deployment.md) records opt-in configuration and explicit
rebuild requirements; no credentials or stopped acceptance deployment were changed.

[DI2 source lifecycle](skill-source-lifecycle-delivery-20261001.md) now passes real
Controller Disable/Enable/Delete: disabled source reads return 503, a new Runtime
restores the unchanged sequence/digest, and deletion rejects old refs with 404
before the producer's sequence-3 tombstone is delivered. Formal v1/v2 and installed
presets remain independent; eight preset Runs and their Trace parents pass. This
adds root integration evidence without changing service business implementations.

[D1A caller-aware Registry search](skill-discovery-caller-registry-delivery-20261001.md)
adds trusted requesting-Agent context and excludes its personal projections before
candidate limits/inspection, keeping formal versions eligible. Registry unit,
contract, real HTTP/PostgreSQL/race and isolated deployment gates pass.
[D3A ACP caller derivation](skill-discovery-caller-acp-delivery-20261001.md)
sends this identity from persisted Run authority; 1136 unit tests, 174 contract/HTTP
components, 322 PostgreSQL tests and static checks pass. The complete foreground
fix is now admitted by [DI3](skill-discovery-caller-integration-delivery-20261001.md):
the real active Run finds and loads its promoted formal head and another Agent
source, with durable receipts, retained local Skills and normal peer deletion.
An earlier DI3 attempt passed active-Run search plus formal/peer loads and
durable receipts, but its complete Trace gate exposed missing Registry HTTP
context propagation. [D1T](skill-registry-trace-delivery-20261001.md) repairs that owning
service with native SERVER/CLIENT spans and bounded SDK shutdown. Unit, HTTP/OTLP
components and isolated Docker gates pass. Ordinary Compose trace wiring and DI3
now also pass: 307-span caller Trace, all direct source parents, zero own-source
observations and complete cleanup. Only previously accepted clock warnings remain.

The closing evidence audit also found that interpreter scripts supplied through
stdin could exit successfully without running because the verification runner
deliberately closes child stdin. The affected source, Trace and cleanup audits
were rerun using explicit code arguments and supersede the empty executions in
the admission indexes. The runner now rejects explicit Node/Python stdin script
modes before creating evidence. Its 30 serial command/suite/dependency/manifest
tests pass, including interruption and child-process cleanup. This changes shared
verification tooling, not the Skill workflow or its admitted service code.

The [human propagation acceptance](skill-propagation-human-acceptance-20261001.md)
now has a separately named deployment at `http://127.0.0.1:18090/login`, restored
on the same retained images and volumes after the system restart. The Chrome
extension is connected. Actual page operations with `deepseek-flash` complete
normal automatic Skill creation/update, another Agent's find/load and document
use, explicit formal v1/v2 promotion, frozen Template revisions, creation on v1
and explicit rebuild on v2. Nine foreground Runs end normally. Three creation
and one rebuild receipts pass, as do their Trace parents and both applied
learning tasks. Docker readback confirms physical per-Agent read-only Skill
volumes: B uses v2 after rebuild; C retains v1. No debug or credential
decryption/replay was used. B's own automatic review was inconclusive and applied
no personal Skill; it did not block its later rebuild or foreground Run. The
single-file real-model scenario does not replace the separate multi-file Docker
evidence. Browser screenshots and private admission records are retained, and
the environment remains available for the user's experience review. The earlier
browser-unavailable and empty-catalog observations remain historical records,
not current blockers or a human acceptance verdict.

The [2026-09-30 Runtime tool usability delivery](runtime-tool-usability-20260930.md)
fixes the file-argument mismatch exposed by the real DeepSeek demo. Public file
tools now accept string paths, reads use optional 1-based line pagination, and
Bash requires only its command with workspace/deadline defaults. Runtime and ACP
local gates plus the isolated four-tool → learning create/update → notice/recovery
→ subsequent-read Docker flow pass. The development acceptance Agent has been
normally rebuilt on Template revision 2 with the admitted Runtime/ACP images;
its existing workspace, learned/system Skill contents and restored result remain
intact. The original paid demo retains its historical failure outcome.

The [Stage 4 plan](stage-4-services.md) contains exactly three services:
`skill-registry`, `channel-manager` and `task-scheduler`. Only Skill Registry is
implemented. Channel Manager and Task Scheduler retain their planned ownership;
they have no implementation or detailed shared contracts. The independent
[Skill learning design](skill-learning-design.md) now has an
[L0 shared contract](../contracts/skill-learning/learning-api.md). On
2026-09-29 its product direction changed to automatic post-Run generation and
updates of managed personal Skills, with policy-based idle activation and
result notices. Manual saving is optional; undo, diff inspection and retained
old versions are outside the first delivery after the 2026-09-29 scope correction. The
[Hermes source review](hermes-skill-learning-research-20260929.md) records the
reference and earlier design inputs. L0 fixes the initial policy, budgets,
maintenance requests, verifier keys, SDK notice metadata and recovery values,
with cross-service contract tests. Runtime L1 local gates have passed: its
separate signed maintenance endpoint, private UID 1000 executor, bounded key
verification, candidate prepare/check, conditional commit, post-effect
observation, cancellation, writer-state blocking, 256 MiB hidden-storage cap and
idempotent release are covered by Rust, contract, executor and disposable Docker
named-volume tests. Deterministic executor tests cover recovery after directory
exchange, detach and deletion but before final receipts.
An additional Linux unit regression changes the active package immediately
after atomic installation: commit returns an unknown effect and observation
reports a conflict, so no applied result is emitted. The rebuilt Runtime image
and named-volume Docker maintenance gate pass. A separate full-stack gate now
covers lifecycle interruption after installation and before the receipt.
Runtime's disposable Docker HTTP gate also accepts signatures from both
preconfigured verifier keys on the same idempotent prepare request and rejects
an unknown kid. It now rebuilds Runtime on the retained workspace with only
the second verifier: the removed old key gets HTTP 401 on a fresh request,
while the retained key can prepare it. A disposable full-stack case then creates a Skill with the
first ACP signer, recreates only ACP with the second signer and verifies the
same Runtime container updates the Skill and serves it to a later Run. The same
full-stack test then reconfigures RC with only the second key, explicitly rebuilds
the Agent, confirms a new Runtime bootstrap contains only that key, and verifies
HTTP 401 for the old signature while the retained signature is accepted. A
subsequent real Run in the original Session reads both learned rules after the
rebuild. The manual leak-isolation and offline old-backup drill has also passed;
its limits are recorded below. This completes the
Runtime-owned boundary, not the learning workflow. RC L1R also passed its Go
unit and isolated PostgreSQL component gates: it validates and normalizes a
bounded public-key bootstrap, freezes that set with accepted lifecycle
operations, persists it atomically, and replays the frozen deployment identity
after configuration changes. Controller L2 has passing Go and isolated
PostgreSQL gates for the automatic-by-default policy, independent revision,
owner-scoped GET/PUT and atomic request-ID replay. The server-owned policy
activation cut now survives lazy creation, `off` → `automatic` and receipt
replay; ACP resets its scan cursor when that cut advances and retains PostgreSQL
microsecond precision across cursor writes. Owner-authorized canonical pins
now persist without an ACP path lookup because they only remove automatic
write authority. Explicit adoption of user-owned Skills is outside the first
automatic-learning delivery: Controller rejects nonempty `adopted_paths`, ACP
does not register these packages, and no package snapshot protocol is needed.
Controller's isolated PostgreSQL/Temporal suite passes 655 tests for this
batch, and ACP's PostgreSQL suite passes 304 tests including a durable pinned
proposal skip. A disposable full-stack case creates a Skill, owner-pins its
path, completes another real foreground Run, and verifies the later model
proposal is skipped without a second change or success notice. The ACP full
unit suite passes 992 tests.
ACP L3 now has a PostgreSQL migration and locally tested
completed-Run scan/queue/claim primitives: terminal-order barriers, durable skip,
idempotent enqueue and frozen policy preserve the scan cursor under queue
saturation; claims enforce one active review, Agent idle time and cooldown.
An exclusive worker on startup pauses abandoned claims while preserving budget
and blocks same-Agent work. The configured worker observes and resumes unknown
effects; explicit adoption is outside the first delivery. LI1's current automatic
workflow and applicable fault/browser gates have since passed.
An isolated Docker happy-path gate now passes completed Run → automatic personal
Skill creation → a later eligible Run updating the Skill → a subsequent real Run
reading both rules. A notice-capable ACP v1 client receives live SDK notices for
both changes, and Agent View independently restores both results. Each source Run performs three
Tool rounds to meet the review cue. The fixture advances only its disposable
database's first review timestamp past the frozen ten-minute cooldown. This
proves the basic cross-service workflow. Subsequent isolated fault and
live-notice cases are described below; the applicable competition and browser
gates have since passed. After removing the out-of-scope package snapshot
path, the isolated Controller PostgreSQL/Temporal gate and this automatic
Docker flow passed again on 2026-09-30. The L0 policy contract and ACP parser
both reject nonempty `adopted_paths` in the first delivery.
An isolated Docker foreground-preemption gate also passes: while the review
model request is held open, a new foreground prompt completes, cancels that
request, leaves the learning task paused as `foreground_preempted`, and records
zero Skill changes. This covers the model-wait preemption case. A second
disposable Docker race holds the real Runtime commit receipt after Skill
installation: foreground admission cancels maintenance, waits until the receipt
is released, then completes with one Skill change and one commit intent. A
third Docker race pauses Runtime after atomic Skill installation and before its
receipt. The first foreground request is correctly fenced with
`runtime_barrier_required`; once Runtime completes, ACP reissues only its
unknown read-only observation, records exactly one change and one commit, and
a later foreground retry completes. This uncovered and fixed a same-execution
recovery loop that previously left both commit and observe `unknown` forever.
Browser presentation now passes both real-stack Playwright gates described below.
The [2026-09-30 learning closeout audit](skill-learning-acceptance-audit-20260930.md)
records the completed L0–L4/LI1 functional gates, source navigation and on-demand
diagnostic guidance, plus the limits of key-leak/old-backup evidence. The feature
can enter human experience acceptance. On 2026-09-30 the user changed the
development workflow: follow existing styles, prioritize functionality and run
regression without a style-approval gate; visual refinements follow during human acceptance.
The shared learning contract now defines a minimal owner-scoped
`learning-status` projection with at most one current paused blocker, bounded
reason codes and access-filtered source identities. Fifteen contract tests
pass. Agent UI's consumer and completed integration gates are described below;
no task-management or stop/kill interface is added.
ACP's access-checked status reader and owner-scoped PostgreSQL projection now
include the wired GET HTTP endpoint. Source Session deletion suppresses source
IDs and terminal tasks have no blocker. Producer gates pass: 1005 unit tests
across 108 files, 310 PostgreSQL tests across 35 files, 15 contract tests,
type checking and lint. The isolated PostgreSQL environment was cleaned up
(`acp-1790707757-6878`). UI backend consumption has since passed its local gates;
applicable frontend and business integration have since passed as described below.
Agent UI's learning-status consumer now validates bounded owner-scoped data,
passes it through Agent View/delta, and distinguishes unavailable reads from
an authoritative empty blocker. Ordinary Views, SSE refreshes and runtime
sweeps no longer query status. Only `GET /agents/A/view?learningStatus=1`
requests the diagnostic, with five-second coalescing/backoff. Node's 253 tests,
13 HTTP-client tests, the official SDK HTTP component test and type checking
pass. Frontend tests were authored before implementation; all 144 component
tests now pass, including on-demand diagnostics and cancellation on close/switch.
The real Gateway/UI/ACP HTTP status projection now also passes in the isolated
Docker model-recovery case (`antnest-lifecycle-c0386f4f.model-recovery.json`).
Ordinary View starts without a diagnostic; an explicit request returns the
access-filtered prior source and bounded reason. The old review remains visible
after recovery while a new source still learns and serves a later read. This
does not itself test frontend interaction; the separate component and real-stack
browser gates below now cover that behavior.
The 2026-09-30 foreground-priority review found that tool-free model inference
could still delay foreground admission if an adapter ignored cancellation.
ACP now stops awaiting that response, discards late success/error, keeps
unreported model cost unknown, and does not treat model cost as Runtime
occupancy. Its 1008 unit tests, type checking, lint and isolated Docker
foreground-preemption flow pass (`antnest-lifecycle-05fe7d09.preempt.json`);
the project has no remaining containers. Runtime file effects still require
bounded cancellation/observation. The updated product decision keeps ordinary
learning deferral quiet and shows diagnostics only inside the learning-results
entry. The UI polling has been removed; the on-demand presentation passes its
component and real-stack browser gates. No permanent blocker banner
is delivered.
The real browser gates under root `tests/e2e/skill-learning/` now pass.
`make e2e-skill-learning-browser` sends real create/update/read prompts through
the rendered composer and checks result delivery, source navigation, reload
and mobile history. `make e2e-skill-learning-diagnostics-browser` attaches the
browser to the failed-review/recovery flow and checks on-demand diagnostics and
the recovered result. Their private evidence is `antnest-lifecycle-b641ef81.json`
and `antnest-lifecycle-f86da5cd.model-recovery-browser.json`. Production client/SSR
build, type checking, 144 frontend components and the five existing browser
integration tests also pass. The runner closes Playwright before Docker cleanup,
including interruption paths. `browser-functional-resource-cleanup.json` confirms
zero owned containers, networks, volumes and Playwright child processes.
An isolated Docker model-recovery gate now passes with current ACP and UI
images (`antnest-lifecycle-cef1dc9b.model-recovery.json`). After a review 503,
an ordinary foreground Run completes while review remains unavailable. Once
the fixture provider recovers, a new three-tool-round source automatically
creates a Skill, sends its live SDK notice and serves a later real read. The
original source remains completed; the old task, unknown call and reserved
cost are unchanged and no old request is replayed. The fixture advances only
its disposable first-attempt timestamp past the ten-minute cooldown. Production
recovery and budget logic are unchanged. No project containers, networks or
volumes remain. The shared fixture's normal create/update/live notice/recovery
and later-read flow also passes (`antnest-lifecycle-5e806686.json`). Resource
checks for both projects are saved in `model-recovery-resource-cleanup.json`.
This closes the provider-recovery acceptance gap; the diagnostic frontend and
browser behavior has separately passed. Diagnostic copy describes a prior
unfinished review and no longer promises to replay an unknown model request;
the layout is unchanged and its type check passes.
The manual key-compromise recovery drill now passes its isolated Docker gate
(`antnest-lifecycle-706dabfe.json`). It stops signing, confirms old Runtime trust
persists, disables that Runtime, restores the protected RC backup outside
lifecycle replay without altering frozen verifier/deployment records, then
Enables a new safe-key Runtime and verifies original learned Skill use. Both
Compose and dynamic Runtime containers were cleaned up. This backup has zero
unfinished lifecycle targets; the evidence does not claim automated revocation
or incident recovery of unfinished targets. The dump remains in protected,
Git/build-excluded verification storage, with its checksum and permissions
checked. Applicable frontend/Docker/browser functional gates have since passed;
human experience acceptance remains separate from this manual drill.
ACP's settled-candidate cleanup now passes its service and Docker gates.
Terminal-task selection includes earlier generations only after non-cleanup
effects settle; authorization uses the current task claim and storage identity
comes from the original preparation receipt. The existing maintenance guard
prevents dispatch during foreground ownership. Once dispatched, release keeps
its receipt transport alive during handoff, bounded by five seconds and worker
shutdown. Unknown responses replay the exact request using Runtime's durable
receipt; replacement-worker startup recovers pending releases under exclusive
ownership. No undo or retained versions are added.
The cleanup batch suite passes 1002 unit tests, 309 PostgreSQL tests and 14 shared
contract tests; lint and typecheck pass. The final Docker cleanup fault gate
passes real creation/update, a dropped successful release response, recovery,
and later Run use. Its private evidence is
`artifacts/verification/skill-learning/antnest-lifecycle-2742a8ab.json`: two
settled releases, zero candidate/release-stage directories, and a retained
active Skill. No containers remain under that disposable project's label.
The full PostgreSQL evidence is
`artifacts/verification/dependencies/acp-1790706285-4080.*`, with cleanup true;
final local/contract output is
`artifacts/verification/skill-learning/acp-cleanup-final-local.log`.
These gates close the identified cleanup gap; separate real-stack browser
acceptance has since passed as recorded above.

The following learning paragraphs retain intermediate service-owned checkpoints.
Their references to pending downstream gates describe those earlier checkpoints;
the 2026-09-30 audit above records the current completed functional scope.
An additional disposable Docker gate stops Agent UI while ACP updates the
Skill and a subsequent real Run reads it. After UI restart, Agent View restores
the creation and update as exactly two distinct results. This proves late
Bridge/View restoration across a UI outage, not SSE delivery ordering or
browser rendering.
The isolated Docker review-skip gate also passes: an otherwise eligible
completed Run reaches the model, which returns `skip`; the task settles as
skipped with one accounted model call, zero Skill changes and no Agent View
success notice. The foreground-preemption branch still passes after this
fixture addition.
An isolated Docker model-outage gate also passes: after a successful source
Run, the review provider returns 503; the learning task is paused with one
model call durably marked `unknown`, zero Skill changes and no success notice. The source Run
does not become a failure. The skip and preemption modes still pass after this
fixture addition.
An isolated normal ACP restart during a held review now passes: Controller
republishes execution configuration, the original Session accepts another
foreground Run, the interrupted model call stays `unknown` and is not resent,
and no Skill change is recorded. ACP now labels shutdown cancellation
`worker_lost`; a real foreground preemption still uses `foreground_preempted`.
Another isolated Docker gate changes Controller learning policy to `off` while
the review model request is held. ACP's bounded policy watch cancels that
in-flight request after observing the changed revision, marks its unreported
usage `unknown`, pauses the task as `policy_changed`, records zero Skill changes
and emits no success notice; the completed source Run is unaffected. Transient
policy-read failures do not establish a revocation, while apply admission still
fails closed before any commit.
Agent lifecycle publication now closes Skill maintenance admission, and ACP
settlement waits for bounded maintenance quiescence before reporting an Agent
settled. Unknown Runtime effects retain the existing Runtime barrier. An
isolated Docker Disable gate holds a review model request, disables the Agent,
and verifies that the model request is cancelled, the task pauses as
`lifecycle_closed`, its model call is `unknown`, and no Skill change or success
notice is produced. The same held-review gate now passes through Agent Rebuild:
the new Agent becomes ready, the old review is cancelled and cannot make a late
Skill change. Paused-task recovery may observe an old effect while the Agent
is closed, but now checks lifecycle admission before resuming any candidate.
Both Docker lifecycle gates revisit the paused task after a worker cycle and
confirm it stays paused. In-flight file-effect lifecycle races still need
Docker integration evidence for a commit still inside its file-system operation.
An isolated Docker gate now holds the completed real Runtime commit response
at the ACP boundary: the active Skill file already exists, Disable stays
running while the receipt is held, and only then completes with exactly one
applied task and one change. A paired Docker gate drops that same response:
ACP observes the real Runtime effect before stopping it, settles the original
commit as `observed_effect|applied`, and records exactly one commit attempt,
one observation and one change. ACP service tests also cover an in-flight file
effect: lifecycle settlement waits for its receipt and durable intent, while
a cancelled HTTP response becomes `unknown` and keeps the Runtime barrier.
An additional disposable Docker gate holds commit after ACP persists its intent
but before the request reaches Runtime. Disable completes with no Skill file or
change; the commit and one attempted observation remain `unknown`, preserving
the ambiguous transport outcome. This does not cover a pause inside Runtime's
atomic file operation. The same case enables the Agent again, verifies a new
Runtime container and ACP configuration, and completes an ordinary foreground
Run: the old execution's unknown ledger entries remain, but its local barrier
no longer blocks the replacement. The original held-response and lost-response
cases also pass with the shared test gate.
An additional test-only Runtime gate pauses after atomic Skill installation and
before its receipt. Disable leaves the old commit unknown; after Enable publishes
a replacement Runtime, ACP observes the retained workspace, settles the old
effect, records one change, and completes a foreground Run without a second
commit. The full ACP service unit suite passed 990 tests across 106 files;
the additional execution-specific observation regression passes locally and
typecheck passes. The disposable ACP PostgreSQL component suite passes 303 tests,
including cross-execution observation settlement.
Undo and change-diff experiments have been removed from the ACP and Runtime
production paths. ACP unit, PostgreSQL component, integration and L0 contract
checks pass. The Docker happy-path and fault cases below cover substantial
parts of the automatic business flow; browser and other remaining gates
still precede full learning acceptance. The
ACP worker starts only when its Controller URL and maintenance signing key are configured;
the development deployment has not enabled or accepted automatic learning.
ACP now exposes an owner-scoped change-list read on the trusted workspace
boundary. It uses committed rows, a sealed sequence, signed Agent/principal/
direction-bound cursors and a real `0` genesis. Deleted source Sessions and
their Run links are redacted at read time. HTTP, unit and PostgreSQL
tests cover the initial and incremental page. ACP v1 now negotiates SDK 1.5.0
notice capability and runs a bounded, owner-scoped committed-change publisher
for associated Sessions on both HTTP and WebSocket connections. Its unit and
SDK mapping tests cover the local delivery boundary, and the applied-change
transaction wakes it only after commit. Docker verifies durable Agent View
notice recovery for creation and update, and a notice-capable ACP v1 client
receives both live SDK notices. The same Docker flow now reconnects the ACP
client after both changes: Agent View still contains exactly two results and
the new SDK connection does not replay historical notices. ACP unit coverage
checks that a failed SDK send closes its connection and a replacement receives
only later changes. A disposable Docker test now rejects the first SDK notice
send after the change commits: the original connection closes without that
notice, Agent View recovers the committed result, and the replacement receives
only the subsequent update live.
Agent UI L4 now declares SDK notice support, receives applied learning notices
before Session replay filtering, deduplicates them per Agent owner, and restores
up to 20 committed changes from ACP on Agent View reads. The View/SSE DTO carries
these results without changing Session output watermarks. Its local server and
HTTP/SDK integration tests pass. A Bridge service test also confirms that a
stale bounded read cannot overwrite a live notice received while it was in flight.
FE now renders restored results in a topbar
history panel and announces newly applied changes once; component tests and
typecheck pass. The Node/FE projection now carries the committed record's
Agent, timestamp, Skill name and summary fields, matching the L0 schema rather
than deriving a smaller title/description item. Desktop and mobile style
previews were rendered; the current component and browser gates have since passed.
The FE now also keeps a per-Agent highest-seen learning sequence: a delayed
older notice enters history without replacing the fresh alert, while a batch
of out-of-order new notices announces only the newest result. All 139 Agent UI
component tests and typecheck passed at that checkpoint; current browser gates
also verify live results and restored history without old toast replay.
The Node Bridge Agent View projection now freezes its notice list before delta
comparison; otherwise both the old and new projections read the latest list
and a live notice produced no SSE event. A root HTTP/SSE integration test sends
sequence 2 before sequence 1 through an uncached Session, verifies both deltas
and deduplicated ordered history, and passes with the full 17-test Bridge
integration suite. The 247 server tests, 139 component tests and typecheck also
pass. The disposable automatic-flow E2E rebuilt both ACP and Agent UI images and
verified live SDK notices plus durable Agent View records using the current DTO.
Real-stack browser presentation has since passed; human experience acceptance
remains separate from the fixture-driven functional gate.
Learning history and fresh result alerts now include a source-conversation
link through the existing Workspace Session route. Normal clicks use the
current Workspace navigation; modified clicks retain native link behavior.
Four notice component tests and typecheck pass. Updated desktop/mobile
previews were displayed and approved. The 2026-09-30 user direction removes
style approval as a development regression gate. The installed Playwright
path has now verified actual source navigation on the real isolated stack;
the absence of controlled Chrome/iab tools does not block that path.
The ACP L3 Controller policy read adapter has local unit coverage for exact
activation-cut preservation, owner/scope validation and fail-closed error
handling. A conditionally scheduled scan coordinator combines that policy with
durable terminal-Run decisions. Its review cue uses real Tool rounds or
correction text from the Run's authenticated user message after a successful
Skill read in the immediately preceding completed Run of that Session;
database tests exclude Agent output and failed reads as evidence of this cue.
The Docker happy-path review and application flow passes; remaining LI1 fault
and competition gates are pending. An isolated full-stack negative case also
makes the model cite only real untrusted tool-output evidence twice: review
pauses as inconclusive after the single repair allowance, with zero Skill
changes and no success notice. The normal automatic create/update/later-Run
flow passes again with that shared model fixture. ACP can enumerate distinct
non-deleted Agent scopes in bounded keyset pages and run one serial
scan page across them, reporting per-scope failures without starving later
Agents. This sweep is attached to the configured worker loop.
A separate owner-scoped
source reader returns bounded user text, observed Tool-attempt facts and
untrusted Tool output with distinct labels; the database limits text before
returning it to Node. A claimed task can persist an immutable evidence
snapshot with stable IDs and replay conflict detection. The configured review
worker consumes this reader. A rule citation guard checks the
persisted snapshot's digest and rejects unknown references or rules supported
only by untrusted Tool output; semantic and package checks remain pending.
The first immutable ACP review prompt and strict skip/single-proposal parser now
keep evidence labels outside system instructions, bound model output and require
per-rule citations. The configured worker connects review to candidate
application; semantic support and package acceptance still need full
cross-service verification.
An explicit model `skip` can now settle the matching claimed task idempotently
from its persisted, settled review decision. The transaction refuses to skip
when a candidate or maintenance intent already exists; it does not emit a
change or notice. The configured review worker handles this decision.
A local one-file candidate builder renders new `SKILL.md` content only from cited
rule text, not the model's free-form instructions. For updates it preserves the
previously read one-file Skill and appends newly cited rules, then emits a bounded ZIP with canonical
artifact/content digests. Its unit tests and `unzip -t` smoke check pass;
Registry/Runtime package acceptance remain separate pending gates. The ACP
candidate store now requires the current claim's settled model proposal and
recorded evidence to reproduce the exact package bytes before it persists a
draft. A local review processor connects an existing candidate replay, model
skip settlement and proposal-to-candidate creation with the registered managed
base digest. ACP now gives the model bounded metadata for auto-generated managed
Skills and the verified current content of a small related subset. It rejects
an update when the target was not read or its content digest changed. The
candidate store reproduces an update from that exact base and checks the
registered digest in its transaction. ACP unit, 35-file/302-test isolated
PostgreSQL and 14-file/165-test integration suites pass; an isolated Docker
Run proves update and next-Run use. The configured serial worker schedules this processor.
The same Docker automatic-flow gate now submits the actual updated candidate
ZIP to the disposable Skill Registry: Registry accepts it under package rules
version 1, and its artifact and complete content digests match ACP's recorded
candidate. This verifies the current one-file generator's publishable format;
it does not add a personal-Skill publication product flow or verify multi-file
adopted packages.
ACP now validates an optional protected Ed25519 maintenance signing identity
and has a locally tested client for all six Runtime maintenance actions.
It signs the exact request body, requires a durable intent reservation before
HTTP dispatch, bounds receipt reads and refuses same-request redispatch.
Matching success receipts and deterministic 4xx rejections now settle the
intent; network loss, retryable responses and malformed receipts remain
unknown for recovery.
The configured worker connects the client to durable effect observation;
retention decisions and deployed end-to-end acceptance remain pending.
A local PostgreSQL intent ledger now persists exact request body digests and
execution bindings before first dispatch, prevents changed or blind replay,
and retains unknown effects for recovery. Its isolated migration/component
tests pass. The configured worker connects transport and ledger in one serial
path; the basic deployed effect workflow passes, while loss and restart recovery
remain pending.
ACP also has a local durable candidate store for one package per task. It
preserves ZIP bytes, content/artifact identities, base digest and evidence
references, with same-input replay and stored-byte validation. The Docker
happy-path gate now covers Runtime activation and subsequent file reading;
failure paths remain pending.
The local automatic apply admission now checks current Controller policy,
registered personal-path identity for updates, pinned/system collisions,
complete Runtime Skill inventory and execution binding. A matching settled
Runtime `check` receipt can freeze the candidate's policy apply basis in
PostgreSQL before commit; missing or mismatched checks leave it as `draft`.
The ACP Runtime information adapter can now read the current execution binding
directly with its execution-ID fence; candidate apply admission no longer needs
to reuse the completed source Run's historical Runtime snapshot for inventory.
A single-attempt coordinator in the configured worker orders Runtime prepare/check,
the persisted check basis, a fresh policy/Runtime/binding admission and
conditional commit; it records a change only for an applied receipt. Policy
changes or blocked foreground work do not become successful changes. This
coordinator now reuses a checked basis after a settled `blocked` response and
obtains a new durable commit request identity without repeating prepare/check.
Pending/unknown effects are not redispatched: a local recovery coordinator
observes them, then records only an applied outcome using the actual attempt
request ID. The configured worker schedules this recovery and paused-claim
resumption; full crash-recovery acceptance remains pending.
The applied-change transaction now requires a matching settled Runtime `commit`
effect (including observation-recovered effects), then atomically records the
immutable change, gap-free Agent sequence, managed-path identity and candidate
completion. It is locally covered by PostgreSQL tests and scheduled by the
configured worker. Public change reads and ACP notice delivery have local
tests; FE has local presentation tests, while browser and cross-service acceptance remain pending.
The effect ledger can now settle a lost commit from a separately
recorded matching Runtime observation, preserving the observation as the
recovery source. An unknown observation keeps the original effect unresolved.
The configured serial worker invokes this recovery path.
ACP foreground Run admission now owns a local learning-maintenance gate: it
reserves the Agent Run slot, aborts registered maintenance and waits for
quiescence before prompt preparation. A timed-out or unsafe effect fails closed
with `runtime_barrier_required` until observation clears the gate. The
configured worker uses the same gate; durable startup behavior still needs
cross-service acceptance before enabling learning in deployment.
A local task guard checks the durable Runtime intent ledger when its work stops;
pending intents or an unreadable ledger keep foreground admission fenced. The
configured worker uses this guard and Runtime cancellation path.
The recovery guard now has a separate lease that can enter an unsafe Agent
solely to observe old intents; it clears the foreground fence only after the
durable ledger is readable and all tracked generations are settled.
ACP task outcomes now pause a running claim without losing its generation,
budget or Runtime intent. Pending model reservations become `unknown` in the
same transaction; late usage may settle them. Resume preserves the claim and
requires the frozen policy, no unresolved model/Runtime effects and an idle
Agent. A Runtime `cancel` permanently closes that maintenance generation, so
same-claim resume is rejected. A local PostgreSQL handoff now moves an
unapplied candidate to a new claim/generation after cancellation and effect
settlement, invalidates the old Runtime check basis, and preserves the candidate
and spent model budget. It enforces idle/cooldown and current policy. The
configured worker selects paused tasks on startup; crash-recovery acceptance
is pending.
ACP can now list paused claims in bounded keyset pages, including candidate
identity/state and whether the current Runtime generation has a settled cancel
receipt. A local recovery coordinator first observes a prior commit, checks
unresolved intents, then resumes the same claim or hands an unapplied candidate
to a new generation under one foreground gate lease. It isolates a failed task
so later Agent tasks can still be examined. Its focused unit tests pass;
full crash-recovery evidence remains pending. The ACP service can assemble a
serial learning worker when both a Controller policy endpoint and Runtime
maintenance signing identity are configured. Startup runs that worker after
recovery and starts the locally tested change read and SDK notice publisher.
The development deployment has not enabled or accepted the complete path.
Settled commit conflicts and deterministic rejections can now atomically mark
the candidate `conflict`/`rejected` and its task `failed`; database tests cover
both outcomes without recording a successful change. A local task processor
connects review, automatic apply and durable pause/failure outcomes, including
foreground cancellation after a review skip. It is wired in the configured worker.
ACP recovery in the configured worker resolves the current owner-authorized
Runtime binding. It reuses a settled observation without redispatch, and may
observe an older commit through a replacement execution only after Controller
publishes that Runtime as accepting Runs. Its observation request identity
includes the new execution, so an old unknown observation cannot block the
replacement. Local unit, PostgreSQL and the atomic-install/Disable/Enable
Docker case pass; other full worker crash-recovery scenarios remain pending.
The L3 task table now matches L0's `pending` state and package-rule version.
Model calls have durable pre-dispatch reservations and idempotent actual-usage
settlement. A parsed review decision can now be settled in the same transaction
as actual usage and read after replay; the configured worker uses this path.
A local L3 review runner reads the claimed completed Run's
scope-checked snapshot, acquires a current Provider client, calls the model
without tools using that budget receipt, allows one bounded format repair, and
preserves calls with missing usage as unknown. Current model-profile authority
now checks the active Agent, selected model and Provider against the source
snapshot before reservation and after dispatch, settling known usage if access
changed. Worker restart marks unfinished calls unknown and prevents blind
redispatch. UTC-day Agent review and model-token admission counts across
tasks and persists retries. The model-call admission component
re-reads Controller policy and rejects disabled or changed revisions before
reservation. Claim admission likewise checks the current policy before and
inside its transaction. A disabled or changed policy cancels the pending task
without a review attempt; a Controller outage leaves it pending. Cross-service
provider review and unknown-call recovery acceptance remain pending.

The Registry-owned [API/schema](../contracts/skill-registry/registry-api.md)
and [service](../services/skill-registry/README.md) validate and store immutable
organization-scoped package versions. Unit, contract and isolated PostgreSQL
checks cover fixed bytes/digests, publication replay, concurrent revision CAS,
organization isolation and package limits. The shared `package-rules-v1.json`
cases run through Registry/RC Go validators and the actual Runtime Rust parser,
including parser-specific scalar types and forbidden merge keys. The old
`skill_instructions` field is permanently empty; ACP rejects nonempty input and
no longer appends Skill bodies to system prompts. Console's audit projection
also omits that body field.

Controller freezes exact Skill versions in Template revisions and AgentSpec.
It persists a preparation intent before create, rebuild or enable, and enters
the lifecycle only after RC returns a ready collection. RC owns downloads,
complete readback, resumable package checkpoints, per-Agent collection volumes,
reference transfer, mount validation and cleanup. Preparation retries retain
the source Agent's execution availability. Fenced rejection restores its network
and ACP admission; tests cover publication, restart, volume races and uncertain
Docker effects without silently mounting an empty replacement.

The [Admin Console Skills module](../services/admin-console/docs/skills.md)
provides upload/version lists, explicit Template selection, and creation,
rebuild and enable preparation progress with same-request retry. Its local
unit/component, user-approved desktop/mobile browser, authenticated login and
isolated Docker BFF checks pass. Stub-backed BFF checks are distinguished from
the separate real Controller/RC/ACP business gate.

The current evidence includes:

- `make e2e-stage3-skill-delivery`: rebuilt Registry, Controller, RC and Console
  images passed the disposable 12-service deployment on 2026-09-28. Publication
  of v1, frozen Template creation, Agent creation, real ACP Skill-reading Runs,
  publication of v2, explicit rebuild, Disable/Enable and Delete all passed.
  Workspace history is preserved and new publication does not change a running
  Agent. Runtime service-name and actual private-IPv4 access to Registry is denied;
  the tested Registry network has IPv6 disabled.
- `make integration-stage4-skill-prepare`: HTTP/PG/Docker preparation and
  Initialize consume the exact manifest and actual read-only mount. Real Runtime
  discovery and on-demand reads pass. Root and UID 1000 cannot write, delete,
  rename, chmod, create links inside the mount or write through a workspace link.
  The 2026-09-29 repeat explicitly enabled `ANTNEST_TEST_REAL_RUNTIME_IMAGE` and
  passed real executor discovery/read plus `write`/`edit` rejection. Its unique
  private log preserves those results even if a later optional profile replaces
  the shared JSON summary.
- `make integration-stage4-skill-slow-prepare` and
  `make integration-stage4-skill-restart-prepare`: five delayed packages finish
  in 126.654 and 143.292 seconds, beyond the 120-second mutation budget. A
  graceful RC restart preserves the first package checkpoint and avoids its
  redownload. Preparation has its own budget and shutdown settles its worker.
- RC PostgreSQL tests age a retained reference beyond the five-minute Drain
  window and consume it after reopening the repository. Docker gates separately
  cover fenced invalidation, Controller/RC restart, Initialize/Rebuild mount
  races, lost Docker responses, disabled-volume loss, unmounted target drift,
  Registry outage and offline same-set reuse. The reference test uses aged
  database state; it does not claim a five-minute wall-clock Drain run.
- `make e2e-stage4-skill-restore`: on 2026-09-28, eight databases and six persistent
  volumes were restored for two real Agents. Four ACP Runs, retained history,
  independent Skill volumes and Registry-offline Enable passed. Removing one
  disabled Agent's Skill volume while Registry remained offline blocked its
  Enable, while the unaffected peer still completed a Skill-reading Run.
- Service/unit/contract/component checks and the latest formatting, Go lint,
  Node lint/type checks and test-storage policy checks pass. Test sources stay
  in their service or root `tests/integration`/`tests/e2e`; durable private
  evidence stays in ignored `artifacts/verification`.

Business and applicable Trace topology gates pass. Original strict Trace
results retain the already reviewed clock warnings; no global clock/NTP project
is part of this delivery. Complete Prepare readback, startup mount/manifest
checks, read-only Runtime access and recovery validation cover the normal Skill
lifecycle. Continuous scanning for privileged host-side changes to an already
mounted volume is outside the agreed scope. These limits do not block the
current first release.

The pre-Stage-4 dependency refresh and full current-service automated regression
are complete on 2026-09-26. The [delivery and verification record](dependency-refresh-20260926.md)
records fresh service/unit/contract/component, database, image and 32 Docker
entry-point results, including the current command/layout browser checks.
Required business, applicable topology and privacy gates pass; original strict
Trace exits remain nonzero under the reviewed clock/SDK-timing boundary and
explicit negative/fault scopes. Human visual, real screen-reader and non-local
acceptance remain separate. The 24 retained containers, 290 volumes and 25
networks are unchanged; candidate images are built, the human environment has
not been redeployed. Earlier dated results
below retain their original versions and scope.

The 2026-09-26 [Stage 3 final acceptance](stage3-final-acceptance-20260926.md)
records the current single-node service candidate passing business and
applicable topology gates with the reviewed clock-warning exception. The
original strict Trace exits remain nonzero. The earlier
[pre-acceptance checkpoint](stage3-final-preacceptance-20260925.md) is retained
as history.

Human experience acceptance has started. The
[2026-09-26 Agent UI remediation record](../services/agent-ui/docs/human-acceptance-remediation-20260926.md)
tracks the implemented first-send Session flow, sidebar navigation and running
Tool/process spacing. Service tests, browser integration and the isolated C4
business checks passed. C4 strict Trace still exits nonzero only for the
previously reviewed clock-skew warnings; renewed human review remains.
The follow-up workspace navigation layout is now deployed for visual review:
the Antnest title is retained, with the current Agent name as its clickable
workspace subtitle; New conversation, search and scoped history follow below.
The renewed C4 regression now covers this follow-up layout, including workspace
context above conversation navigation and desktop/mobile behavior.
Workspace document selection now uses
`/workspace/{agentId}/sessions/{sessionId}` and `/workspace/{agentId}/` for a draft,
with matching Console links and Gateway login returns. Focused route checks and
the deployed browser preview and renewed C4 regression pass; human visual
approval remains pending. See the [navigation contract](../contracts/agent-ui/workspace-navigation.md).

The [resource ID unification](resource-identifiers-20260926.md) is implemented
and deployed: newly generated platform resources use
`<kind>_<32 lowercase hex digits>`, including `agent_` and `session_` in workspace
paths. Existing identities remain unchanged. ACP, Identity and Controller local
gates and disposable Docker business/topology checks pass; strict Trace retains
only the reviewed cross-process clock warnings and its original nonzero exit.
The focused browser first-send/reload check passes with a new `session_` ID.
The subsequent UI regression also passes; human style review remains pending.

The [Stage 4 command preparation](stage4-command-preparation-20260926.md)
extends the existing Agent UI service with 11 Node control commands and a shared
cross-channel semantic contract. Its Agent-level control catalogue is separate
from native Session ACP commands. Help/status/navigation work before Session
creation; busy controls preserve configuration CAS and targeted cancellation.
242 service tests, 16 official SDK/HTTP/SSE integration tests, the production
container regression and backend-only real-stack Docker acceptance pass. The
real stack covers all 11 commands, concurrent configuration CAS, targeted Stop,
fork, authorization and no model calls for controls; temporary resources are
cleaned. The refreshed candidate also passes real-stack browser command input,
two-page SSE/control synchronization, Session navigation and reload restoration
without extra model requests. Human visual approval remains separate. Channel
Manager and the other Stage 4 services have no implementation yet; this is not a
completed cross-channel workflow or final acceptance.
`session/fork` is an explicitly negotiated **UNSTABLE** SDK capability, not a
stable ACP v1 requirement. The 2026-09-26 recheck found SDK 1.5.0 (released
2026-09-21) while the earlier tests used pinned 1.4.0. The 1.5.0 service upgrade,
v1 schema audit, v2 acceptance-response consumer contracts and final Docker
regression all pass within the stated acceptance boundaries. Fork remains
unstable in the 1.5.0 schema.

Agent UI implementation checkpoint (2026-09-24): it runs as one Node full-stack development
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
originals have now also left cache: Controller 20260917/20260921 and Temporal 20260921. `lifecycle-contracts-final` passes 118 checks; `lifecycle-docker-final`
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
| Repository test layout, 2026-09-22                         | Root integration/E2E layout, recovered cache-only tooling, preserved Go/Rust test functions, service/database/Linux gates and representative Docker business checks pass                                                                                                                                                               | [Migration report](test-layout-migration.md); strict Stage 2/C4 timing failures retained, Python anonymous-volume cleanup repaired and rerun; exact environment restored, no deployment                                                                                                                                                                                                                                  |
| UI timeout and fixture failure follow-up, 2026-09-22       | UI initialization synchronization and bounded cleanup diagnostics; 1,242 shared checks, 69 UI unit and 128 component checks pass; three targeted Docker business/cleanup profiles and 244 topologies pass                                                                                                                              | [Follow-up report](timeout-failure-followup-20260922.md); strict timing failures retained, original deletion root cause unproven; interruption recovered and Session cost rerun with complete exit evidence; retained stopped environment and ten image IDs unchanged                                                                                                                                                    |
| Combined candidate regression, 2026-09-22                  | Service, database and fresh Linux build gates pass; 1,224 shared checks pass with five separately covered skips; all 32 integration entries pass business and applicable scoped topology                                                                                                                                               | [Final regression](final-candidate-regression-20260922.md); acceptance-only fixes, strict diagnostics remain failed, two recorded intermittencies; resource baseline and twelve retained containers unchanged, no deployment                                                                                                                                                                                             |
| Docker single-node baseline, 2026-09-11                    | 25 accepted; five C4 browser items explicitly deferred                                                                                                                                                                                                                                                                                 | [Report](docker-single-node-verification-report.md); historical candidate, not current-HEAD coverage                                                                                                                                                                                                                                                                                                                     |
| Controller/ACP integration, 2026-09-15                     | Nine Docker business scenarios, PostgreSQL/protocol and three Temporal recovery tests passed; trace structure errors zero                                                                                                                                                                                                              | [B5 record](controller-acp-execution-boundary-plan.md#103-可执行的小步交付); strict clock-warning failures retained                                                                                                                                                                                                                                                                                                      |
| ACP database tracing, 2026-09-15                           | Service gates and real-driver contracts passed; three real Gateway chats passed the database contract                                                                                                                                                                                                                                  | [Service report](../services/agent-acp-service/docs/observability.md#database-alignment-verification-2026-09-15); full browser profile not strictly passed                                                                                                                                                                                                                                                               |
| Workspace model selection, 2026-09-15                      | Two real model responses, selection retained after reload, no prompt replay, desktop/mobile menus passed                                                                                                                                                                                                                               | [Script](../tests/e2e/workspace-closeout/model-selection-browser.mjs); local result recorded at 20:38 +08:00                                                                                                                                                                                                                                                                                                             |
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

- F07 remains deferred. The 2026-09-26 dependency refresh upgraded Runtime to
  rmcp 3.4.1 and its existing SDK boundary regression again reproduced rejection
  of standard URL input without a legacy `elicitationId`. The 3.4.0 independent
  probe remains dated reproduction evidence. Runtime interaction, ACP, UI and
  deployment work for F07 stays deferred; no partial implementation was added.
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
- Skill Registry's current hosting, frozen Template references and read-only
  Runtime delivery pass the [first-release acceptance audit](skill-registry-acceptance-audit-20260928.md).
  Legacy migration/export is outside the clean-development scope. Channel Manager,
  Task Scheduler and the independent Skill learning proposal remain future work;
  their design or implementation requires a separately scoped batch. Kubernetes,
  horizontal scaling and high availability remain outside the Stage 4 plan.
- The declared ACP profile does not imply universal conformance or client MCP
  injection support. [Protocol conformance](../services/agent-acp-service/docs/protocol-conformance.md)
  remains authoritative for individual capabilities and exclusions.
