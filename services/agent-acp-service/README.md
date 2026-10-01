# Agent ACP Service

Runtime Skills are available as `/skill:system:<name> <task>` and
`/skill:personal:<name> <task>`. ACP discovers current metadata, advertises it on
initialize and Session setup, and refreshes after Runs and learning notices.
Selection is draft completion; invocation loads the selected SKILL.md into
transient user context under the normal Run budget. See the
[Skill command contract](../../contracts/agent-acp/skill-commands.md).

Agent ACP Service is Antnest's replaceable Agent compute service. It exposes
stable ACP v1 and the draft ACP v2 protocol over separate endpoints, owns
durable conversation and Run execution state, calls the model, and invokes MCP
Tools. It does not construct Agents or Runtimes.

## Resource identifiers

New Session, Run, message, MCP revision, checkpoint and Tool attempt records
follow the [platform resource ID contract](../../contracts/resource-identifiers.md).
Random IDs carry their resource kind; fork/recovery IDs use stable namespaced
hashes. Forks retain bulk SQL copying and rewrite message payload references to
the copied IDs. Existing records and externally supplied protocol IDs are opaque
and unchanged. This does not alter connection IDs or model Tool-call IDs.

## Status

The 2026-09-26 dependency refresh upgrades ACP SDK to 1.5.0, MCP to 2.1.0
and the Node OpenTelemetry family to 0.222.0 / 2.11.0. The v2 prompt acceptance
response now returns the persisted user message ID required by this SDK; the
same ID is used in the live user-message event. The learning batch now advertises
and uses experimental v1 SDK notices with negotiated platform metadata.
Upgrade gates and consumer rollout are tracked in the
[dependency refresh](../../docs/dependency-refresh-20260926.md).

The Skill learning L3 batch has durable completed-Run scan, bounded enqueue and
atomic task-claim primitives. Its cursor stops at an earlier nonterminal Run;
a full queue leaves the source eligible. Frozen policy and source decision
commit with the cursor advance. Claiming enforces one running review globally,
15 seconds of Agent idle time and a 10-minute per-Agent cooldown. On startup,
the exclusive worker owner pauses abandoned claims without erasing budget or
claim identity; same-Agent work remains blocked until the unknown effect is
observed. Local adapters now cover Runtime effect observation, review,
maintenance requests and an atomic applied-change/managed-identity ledger. They
are assembled into a conditional worker that starts after recovery and stops before
worker-lock release when both Controller URL and maintenance signing key are configured. Draft candidates are
reproduced from settled review decisions and recorded evidence before storage.
The local apply coordinator orders prepare, check, fresh policy/Runtime
admission, conditional commit and durable change recording. A checked candidate
reads Skill inventory from the current execution binding with an execution-ID
fence and cancellation signal, rather than the source Run's Runtime snapshot. It
can retry after a settled `blocked` result with a new durable request ID;
unknown effects are observed before any further dispatch. An owner-scoped,
bounded change-list route now reads committed changes with sealed, signed
directional cursors; deleted source Sessions are redacted. A bounded SDK notice
publisher reads committed changes, wakes after commit and sends through associated
ACP v1 Sessions. The first delivery has no undo or detail/diff route. The isolated
full stack validates automatic creation/update, foreground priority, unknown-effect
recovery, notices and later real Run use. Ordinary deployments must configure
the Controller URL, signer and matching Runtime verifier before learning starts. See the
[L0 contract](../../contracts/skill-learning/learning-api.md).
Foreground Run admission has a maintenance preemption gate. The assembled
learning worker uses it when configured; applicable functional gates now pass,
including both real Docker browser flows. Human experience acceptance remains separate.
The local task guard now closes its gate lease only after reading the durable
maintenance ledger. Unresolved Runtime intents or a failed ledger read leave
foreground admission fenced for recovery. A separate recovery lease can enter
an unsafe Agent to observe old effects and clear the fence only after durable
settlement.
Task outcomes can now pause a running claim with an actionable reason, marking
unreturned model reservations unknown in the same transaction. Resume keeps the
same claim and spent budget, and requires unchanged policy, an idle Agent and
settled model/Runtime effects. A Runtime `cancel` closes its generation and
therefore blocks same-claim resume. A local transaction can now hand an
unapplied candidate to a new claim/generation after cancellation, settlement,
idle/cooldown and policy checks; it clears the old Runtime check basis while
preserving candidate bytes and spent model budget. The assembled worker orders
these transitions before new scans and claims when configured.
The worker can enumerate paused claims in bounded keyset pages with the current
candidate ID/state and a durable cancelled-generation fact. This recovery
inventory now has a local coordinator that observes an earlier commit before
resuming or handing off a claim under one foreground lease. A failed task does
not stop recovery of later Agents. It is connected to the assembled worker,
which now runs conditionally.
The local task processor joins review, automatic apply and durable outcomes:
applied changes complete through the change ledger, blocked or unknown effects
pause, and settled conflicts/rejections fail the immutable candidate and task
in one transaction. The configured worker invokes this processor.

The same L3 persistence adapter can count up to three distinct model rounds
whose proposed Tool IDs have real attempts in that completed Run. Rejected
preflight proposals and duplicate response IDs do not inflate this review cue.
The L3 scan coordinator now combines the Controller policy cut, persisted
terminal-Run page, real Tool-round threshold and correction phrases from the
Run's own stored user message only after the preceding completed Run in that
Session successfully read a Skill. Failed Runs are skipped, while full queues and
source-read failures leave the durable cursor in place. A correction is only a
review cue; it cannot authorize a Skill change. The configured worker schedules
the coordinator and connects the review executor.
The Controller policy read adapter validates the owner-scoped response and
preserves the server-owned activation cut at microsecond precision. It fails
closed on access loss, malformed or oversized responses and transient failures.
The adapter is connected to the assembled scan coordinator. Its optional,
validated endpoint is configured with
`ANTNEST_ACP_SKILL_LEARNING_CONTROLLER_URL`; setting it alone does not enable
learning.
For development diagnosis, set `ANTNEST_ACP_SKILL_LEARNING_DEBUG_AGENT_ID` to
one Agent ID in the ACP deployment. Its newly scanned completed Runs enter
learning without the experience cue or ten-minute cooldown; after the usual
idle grace, the same review worker uses immutable prompt version 2 to require a
minimal proposal instead of `skip`. All authorization, policy, budgets,
foreground priority and candidate/installation checks still apply. Unexpected
model skips are diagnosed as `debug_skip` and receive at most one repair call.
The mode is frozen on the task, including paused recovery, and visible as
`antnest.learning.debug` and `antnest.learning.review_prompt_version` in Trace.
Remove the setting to return new tasks to ordinary version 1 selection. This
does not rerun old source decisions or reset paid model calls. The switch is
unset by default and adds no model tool or UI task-management surface.
The L3 source reader now returns owner-scoped, bounded user text and Tool
observations from completed Runs. It labels observed attempt state separately
from untrusted Tool output, and PostgreSQL truncates the text before returning
it to Node. Claimed tasks can persist one immutable, idempotent snapshot of
the selected evidence; changed selected content conflicts on replay. These
records are review input, not an application decision. The candidate citation
guard reloads the recorded snapshot, checks its digest and requires each
proposed rule to cite an in-task user or observed-execution item; Tool output
alone cannot support automatic application. Citation and candidate-package
admission have service and Docker evidence; they do not prove that every
model-synthesized rule is semantically correct for all future tasks.
The immutable v1 review prompt and strict output parser now produce only a
bounded skip or single-Skill proposal with per-rule citations. Evidence is
serialized as labeled data, and untrusted Tool output is never promoted to a
user instruction. This parser does not itself prove semantic support or apply a
candidate; the configured review/apply worker supplies the remaining stages.
A local candidate builder renders a one-file `SKILL.md` from cited rules only;
the model's free-form instructions are not packaged. It produces deterministic
ZIP and Registry manifest digests and has passed persisted candidate admission,
Runtime installation and Registry package acceptance in the isolated full stack.
L3 task persistence now uses the L0 `pending` state and freezes
`package_rules_version=1`. A separate model-call ledger reserves each request
before dispatch, returns `dispatch=false` for replay, and records actual usage
idempotently. A final parsed review decision can be persisted atomically with
usage and read on replay. The local review runner reads the claimed completed
Run's scope-checked snapshot, acquires a current Provider client, uses no tools,
allows one bounded format repair and stops on unknown usage. Current model-profile
authority now rejects disabled or drifted Agent/model/Provider configuration
before reservation and after dispatch. The configured worker schedules it;
cross-service review and application functional acceptance now passes. Evidence
and limits are recorded in the [learning audit](../../docs/skill-learning-acceptance-audit-20260930.md).
Learning diagnostics now group review, model calls, result validation and application
under `skill_learning.task`. Task spans identify the Agent, claimed task, generation
and `antnest.learning.source_run.id`; background learning remains distinct from the
completed foreground Run. Model calls use `model.purpose=skill_learning`. Rejected
results record bounded failure categories and schema paths/codes, plus response size,
stop reason and usage, without logging prompts, Skill contents or credentials.
Review spans include evidence coverage/truncation. Runtime Skill maintenance HTTP
uses the existing traced fetch boundary to propagate the task context.
Intentional model skips and foreground preemption are not marked as task failures.
These diagnostics cannot recover outputs discarded before they were introduced.
Unexpected review/application errors persist `paused / runtime_unavailable`
before propagating to the caller's diagnostics, including when dispatch comes
from paused recovery. A failed resumed task therefore releases the durable
global review slot; its existing model receipts and cost reservations remain intact.
The [live investigation](../../docs/skill-learning-debug-20260930.md) records the
normal-service reproduction, retry defects and downstream Trace coverage limits.
The minimal blocked-learning reader and PostgreSQL projection are implemented
behind Agent access checks. Only current paused blockers are selected, and
source identities are filtered through current Session ownership. Two reader
unit tests and the 35-test maintenance ledger/component suite pass. The GET
`/rpc/agent-acp/workspace/agents/{agentId}/learning-status` route is wired;
five HTTP tests, type checking and lint pass. It requires trusted identity,
rejects query parameters and returns unavailable reads as errors rather than
an empty status. Agent UI consumption and real Gateway/UI/ACP HTTP and browser
acceptance now pass; diagnostics are read only when the learning-results panel opens.
Tool-free learning inference now stops waiting when its cancellation signal
fires, including when an adapter ignores cancellation. Late responses/errors
cannot persist proposals; missing final usage keeps the reservation unknown.
Model usage uncertainty does not hold the Runtime slot. The 1008-test unit
suite, type checking/lint and isolated Docker foreground-preemption flow pass.
Runtime file effects still require bounded cancellation and observation.

An optional protected Ed25519 signing identity is validated at ACP startup
through `ANTNEST_ACP_SKILL_MAINTENANCE_SIGNING_KID` and
`ANTNEST_ACP_SKILL_MAINTENANCE_SIGNING_KEY` (canonical base64 PKCS8 DER); both
must be set together. The corresponding public key must be in the target
Runtime's frozen verifier set before maintenance is enabled.
The local Runtime maintenance client signs the exact request body and validates
bounded receipts for `prepare`, `check`, `commit`, `observe`, `cancel`
and `release`. Network loss and server errors remain unknown effects; the
client does not blindly retry file effects. Its transport requires a durable
intent reservation before each HTTP dispatch. Only an unknown read-only
`observe` can be queried again with the same exact request identity. An unknown
`release` may also replay its exact identity using Runtime's durable cleanup
receipt; commit is never redispatched. After replacement worker ownership is
acquired, abandoned pending releases become unknown for this replay.
The worker performs at most one settled-candidate cleanup per pass under the
existing foreground maintenance guard. It retains bytes needed by unresolved
effects and defers cleanup when the Runtime is closed to Runs.
Validated success receipts settle the matching intent; deterministic 4xx
rejections settle as rejections, while transport loss, retryable responses and
invalid receipts remain unknown. These outcomes survive process restart.
The client is connected to the configured worker. Its recovery path selects a
single unresolved commit,
reuses any settled observation, and otherwise issues one deterministic
observation request against the original execution or an accepted replacement
Runtime that retains the workspace. An uncertain observation remains pending
until the next worker pass rechecks it; unavailable bindings remain fenced and
no original mutation is resent.
A PostgreSQL maintenance-intent ledger now records request identity, execution
binding, exact body digest and bounded facts before a first dispatch. Replay
of the same effect intent returns a non-dispatch receipt; changed inputs
conflict. An unknown `observe` intent alone may dispatch the identical
read-only request again and settles only on `applied` or `conflict`.
Unknown intents remain queryable after worker restart and can be settled with
a matching Runtime receipt even after the task pauses. The configured worker
uses this ledger for dispatch and effect recovery. Lost commit effects
can also be settled from a separately recorded matching `observe` result;
the ledger preserves that observation as provenance instead of fabricating an
original Runtime receipt. An `unknown` observation leaves the effect open.
One candidate per task can now be stored with its complete ZIP bytes, exact
artifact/content digests, managed path, base digest and recorded evidence IDs.
The store validates canonical bytes on write and read, and rejects a different
candidate on replay. It is not yet the authorization or semantic-approval gate
for applying that package.
The automatic apply admission now rejects stale/off policy, pinned or
unregistered updates, system-name collisions, incomplete Runtime inventories
and changed execution bindings. A checked candidate can durably freeze its
policy apply basis only after a matching settled Runtime `check` receipt; an
absent or mismatched receipt leaves it in `draft`. The managed-identity table
is reserved but no applied change or notice is committed from this path yet.
Startup marks unfinished model calls unknown alongside abandoned
task claims; it does not reset the claim or budget. Per-Agent daily budget
admission now counts every claim generation and model-call reservation in the
UTC calendar day, across tasks; settled actual usage replaces the reservation.
The model-call admission component reads the current Controller policy before
each new reservation and rejects disabled or changed policy. It is not yet
wired into the running worker. Claim admission now previews an eligible pending
task, reads the current owner policy, and validates it again inside the claim
transaction before increasing the generation. Disabled or changed policies
cancel the pending task without consuming a review attempt; Controller read
failures leave it pending. Worker scheduling, provider execution and recovery
of unknown calls remain pending.
Scan cuts and cursor timestamps travel to/from PostgreSQL as timestamp text;
converting them through JavaScript `Date` would discard microseconds and could
replay a decided Run or include a Run just before reactivation.

The [execution-boundary refactor](docs/execution-configuration.md) was closed by
the user's scoped acceptance decision on 2026-09-15.
Production composition now uses local access/configuration, logical Provider
clients and execution ownership; the old outbound Controller RPC client is removed.
Agent-level settlement, durable old Runtime protection, and workspace state
read/subscription routes are now locally wired. Administrative audit queries
read retained input, execution and permission records from ACP's own storage.
Gateway and Console consumers have completed their service-local migrations.
Nine Controller/ACP integration scenarios and trace topology checks passed.
Jaeger clock warnings are deferred as OBS-ACP-CLOCK; the strict script still exits
with failure, and no raw trace, warning or gate was modified. See the
[final results and explicit exception](../../docs/controller-acp-execution-boundary-plan.md#103-可执行的小步交付).
Agent UI was excluded from that refactor's protocol acceptance, which used the
official ACP SDK. Subsequent workspace/model-selection browser evidence is
tracked separately in [current status](../../docs/current-status.md).
The acceptance history below describes the earlier
deployed baseline, not acceptance of this refactor.

The declared platform-only ACP profile is accepted in C1 of the Docker
single-node closeout. ACP v1 is the compatibility baseline; ACP v2 is an
explicitly draft, side-by-side adapter. Client editor delegation, authentication,
and Provider administration remain outside this service's architecture.
Gateway/Runtime/Jaeger evidence covers the scoped protocol, isolation, recovery
and managed MCP workflows. This is not unrestricted protocol conformance:
client MCP injection is deliberately prohibited and F07 awaits SDK support.
Coverage boundaries remain distinguished in the
[protocol matrix](docs/protocol-conformance.md) and
[single-node closeout](../../docs/docker-single-node-closeout.md).
The [interface and Goose gap review](docs/protocol-gap-review.md) records the
seven baseline delivery/content/Session defects and their service-level fixes.
The service targets all applicable stable ACP capabilities, including optional
ones. Only explicit architecture incompatibilities and protocol-stability
deferrals can exclude work; clients choose their own presentation and usage
subset. Unadvertised functionality remains a backlog item, not an implicit
product choice. See the [scope decision](docs/protocol-gap-review.md#5-服务端完整性目标与补齐清单).
The [completion plan](docs/protocol-completion-plan.md) separates confirmed
implementation gaps, Goose-based reuse choices, confirmed organization-wide
model selection and Agent-default/Session-override authorization, and evidenced
exclusions. Non-architectural behavior reuses Goose patterns without changing
platform ownership or isolation. Historical batch notes record delivery order;
current capability and acceptance status comes from the protocol matrix.
The first completion batch adds real model text/thought streaming with durable
batched output, stable message identities in v1/v2, and nonduplicating replay
and context reconstruction. Runtime MCP progress now feeds bounded, durable
Tool previews in both ACP versions, including cancellation and replay. See
[Tool progress](docs/tool-progress.md) and the completion plan for service-level
evidence and the completed 12-path Gateway / Rust Runtime deployment integration.
F03 adds deterministic Tool kinds/titles, bounded structured `rawOutput` and
actual Runtime file observations, persisted for v1/v2 replay. Complete file
before/after becomes standard version-specific diff content without entering
model context. See [Tool presentation](docs/tool-presentation.md). The Runtime
producer and ACP consumer have service-owned coverage. The
[file-diff deployment profile](../../tests/e2e/acp-files/README.md) also passed 16
Gateway/Runtime scenarios, 16 execution traces and 16 side-effect-free replay
traces. F04 now adds the local `update_plan` tool, standard v1/v2 plan notifications,
atomic persistence, replay/fork and plan context recovery. See
[Structured plans](docs/structured-plan.md) for the service-owned batch and
[deployed plan acceptance](../../tests/e2e/acp-plan/README.md): twelve Gateway
scenarios, four execution traces covering twelve Runs, and eight independent
replay/denial traces passed. F05 now adds organization model selection, Session
mode overrides, full configuration responses/notifications, persistence and
Run-boundary application. See [Session configuration](docs/session-configuration.md).
The F05/F06 Gateway/Runtime/Jaeger integration is complete. F06 adds
bidirectional v1/v2 permission requests, Session-scoped once/always decisions,
durable approval facts, cancellation and client reconnection. Smart Approve
uses explicit rules, non-conflicting platform read-only hints and a bounded
LLM read-only judge for unannotated platform Tools. Uncertain judgments ask the
user; judgments share the Run budget and are never published as chat messages.
The deployed profile passed 26 v1/v2 scenarios with actual Runtime effects and
causal Jaeger validation. Agent UI supports the standard approval interaction
and Session model/mode selection. [Session model selection](docs/session-model-selection.md)
adds provider-grouped choices and capability-driven thinking effort, persisted
per Session and applied to the actual model request.
See [Tool permissions](docs/tool-permissions.md). F07 is deferred pending official
MCP SDK support. F08 provides a registry-backed `/help` command (`/帮助` alias),
standard command notifications and durable replies without calling a model or
Runtime. Its v1 HTTP and v1/v2 WebSocket Gateway deployment, history/isolation
and Jaeger validation passed. See [Slash commands](docs/slash-commands.md).
F09's ACP service batch adds native WAV/MP3 and PDF input, guarded by admitted
model capabilities, with validation and durable replay. Controller model
configuration, revision/admission propagation and capability declarations have
also passed service tests. Console/BFF configuration and projections, plus Agent UI
input/encoding/replay are verified. Gateway v1 HTTP and v1/v2 WebSocket deployment
acceptance, history/isolation, local model mismatch recovery and Jaeger ancestry
also passed with a deterministic Provider. Retained development instances were
not replaced; real recognition quality is not claimed. See
[Multimodal input](docs/multimodal-content.md). F10's ACP consumer implements
returned/estimated USD receipts, durable known-cost projection and standard
v1/v2 usage notifications. Controller price management and shared admission
snapshots, Console/BFF pricing edits and Agent UI usage consumption are now
verified. All three deployed protocol entrances, restart/fork accounting,
identity isolation and Gateway-rooted Jaeger paths also passed with a local
deterministic model. See
[Session cost](docs/session-cost.md) for the contract and accounting boundaries.
See the
[completion plan](docs/protocol-completion-plan.md) for the decision and boundaries.
This method inventory is not a claim of unrestricted protocol completeness.
The authoritative cross-service design is
[`../../docs/stage-2-agent-and-acp.md`](../../docs/stage-2-agent-and-acp.md);
this directory is the only implementation authority for Agent ACP Service.

## Owns

- ACP Sessions, replayable messages, and active connection bindings.
- Session model/mode overrides and their ordered configuration notifications.
- Run intents, immutable Run execution snapshots, and terminal facts.
- Context construction and bounded Session compaction checkpoints.
- Model invocation and the multi-request Tool loop.
- Tool attempts and retained Session MCP revision records.
- Pending Tool permissions and Session-only approval rules; Fork does not inherit them.
- Per-Run calls to the mandatory platform Runtime MCP endpoint.
- Applied personal learning sources, their metadata projection journal, and protected current-source reads.

## Does Not Own

- Agent identity, Agent configuration, Template, Provider catalog, or rebuilds.
- Runtime creation, Docker/Kubernetes resources, network policy, or Tunnel IP.
- Users, organizations, OIDC, SCIM, Channel bindings, or public authorization.
- Formal system Skill custody, Registry publication/version lifecycle, or Template references.
- Another service's database, volume, or bootstrap secret.

## Dynamic Skill sources (D2)

The [discovery/source contract](../../contracts/skill-registry/discovery-api.md)
restricts initial projection to confirmed applied, automatically generated,
ACP-managed personal packages. Each apply settles its metadata head in the same
transaction as the learning change and managed identity. Registry receives only
organization, source Agent/owner, name, description, sequence, digest and active
state. Content stays in its existing Agent-owned store and Runtime workspace.

Enable the producer/source pair with all of:

- `ANTNEST_ACP_SKILL_REGISTRY_URL`: a fixed HTTP(S) Registry origin.
- `ANTNEST_ACP_SKILL_REGISTRY_TOKEN`: the Registry private API bearer.
- `ANTNEST_ACP_SKILL_SOURCE_TOKEN`: a distinct source-reader bearer, at least 32 printable bytes.
- The existing Runtime maintenance signing configuration, for read-only observations.

All discovery settings are absent by default. The Registry's paired source URL
and source token must point to this ACP deployment. The shared development stack
keeps discovery opt-in. These settings also enable the D3 platform tools below.

The standard Compose stack derives the three discovery settings above and the
Registry's paired source settings from one `ANTNEST_SKILL_REGISTRY_SOURCE_TOKEN`.
See [normal deployment](../../docs/skill-deployment.md) for signing/public-verifier
configuration and explicit rebuild requirements for existing Runtimes.

One background worker delivers durable metadata heads. It retries with persisted
bounded backoff, periodically reconciles acknowledgements, and supplements missing
heads from confirmed managed sources; it never replays a learning model call.
Current access revocation or inactive managed state produces a higher-sequence
tombstone. Configuration not yet initialized defers delivery instead of deleting
the source. Registry outage does not fail a completed learning operation or Run.

Only `POST /internal/skill-sources/inspect` and
`POST /internal/skill-sources/artifact` accept the source bearer. Strict request
schemas, 8/4 KiB body limits, current owner access, exact source sequence and
digest checks apply. Both require an available, accepting source Agent Runtime;
busy/offline/unknown observation returns `source_unavailable`, never retained
candidate bytes as an offline substitute. Another owner cannot read a personal
source even if Agent permissions are expanded in future.

The existing signed Runtime `observe` operation verifies the complete directory
manifest, including extra files and modes. An artifact is returned only if this
current manifest equals the managed applied candidate's canonical package digest.
Changed/missing content invalidates the mapping. Unknown observations defer.
Source reads use the existing idle maintenance gate. A dispatched observation is
bounded to five seconds; foreground preemption discards delivery and awaits this
read's completion before admission. These reads never write a candidate, create a
Run or invoke a model. Access, Runtime binding and source identity are rechecked
after observation. HTTP and `skill.source.observe` spans retain bounded identities
and digests, with no package body or credential content.

The [D2 delivery report](../../docs/skill-discovery-acp-delivery-20261001.md)
records the producer/source evidence.

[DI2](../../docs/skill-source-lifecycle-delivery-20261001.md) additionally proves
normal source Disable/Enable/Delete through Controller. Disable returns 503
without changing the managed content identity; Enable verifies the preserved
workspace on a new Runtime; Delete rejects old refs with 404 and delivers the
ordered metadata tombstone. Promoted versions and installed presets remain
independent. This is root integration evidence; no service API was added.

## Dynamic Skill model tools (D3)

When discovery is configured, ACP adds `find_skill` and `load_skill` as platform
tools with `source=agent` and `sourceId=skill_registry`, outside Runtime MCP.
Runtime catalog collisions with these reserved model names fail explicitly.
Ordinary Session modes, allow/deny rules and ACP approval apply. The tools grant
no publication, Template mutation or persistent installation authority.

The [tool contract](../../contracts/agent-acp/skill-discovery-tools.md) binds each
call to the durable active Run, Session owner, organization, current Agent access
and exact Runtime execution. The model cannot supply those authorities. Access
is checked again after I/O. Persisted attempts enforce eight searches and four
loads per Run, including dispatched failures and interruption/recovery.

Foreground `find_skill` sends trusted `requesting_agent_id` from that persisted
Run authority. Registry excludes the caller's own personal mappings before its
candidate limit and source inspection, so an active Run cannot fail by trying to
acquire its own idle maintenance slot. Formal versions and other authorized
Agent sources remain eligible. The model cannot provide this field; local
Skills keep ordinary Runtime reads. Load and Console preview do not carry this
search context. The [D3A delivery](../../docs/skill-discovery-caller-acp-delivery-20261001.md)
records the consumer gates; the independent
[DI3 integration](../../docs/skill-discovery-caller-integration-delivery-20261001.md)
now passes real active-Run formal/peer loads, native source Trace parents and retained local Skills.

`find_skill` returns bounded current metadata. `load_skill` validates exact ZIP
headers and bytes, complete canonical file/execute-mode digest, size/entry limits,
safe paths and CRC before exposing UTF-8 `SKILL.md` text. Packages are not retained
as an ACP discovery cache. The [D4A consumer](../../contracts/agent-acp/skill-temporary-consumer.md)
installs multi-file packages as real current-Run files and returns a path only
after a strict signed receipt. Text-only packages keep `temporary_files=null`
and retain no ZIP bytes. Existing conversation/tool-result retention applies to text.

Search/text reads have `toolEffectState=none`. `load_skill` has
`readOnlyHint=false` and requires ordinary authorization; file writes preserve
their settled/unknown effects. ACP persists a Run-bound scope before install,
attempts release before terminal state, and guards foreground, learning and
lifecycle settlement while cleanup is pending. A serial recovery worker checks
ended scopes, including after discovery is disabled or ACP restarts. Registry errors stay distinct from an
empty search and are sanitized. `skill.discovery.search/load` Trace spans bind
Run and source/digest identities without queries, package bodies or credentials.

The [D3 delivery report](../../docs/skill-discovery-tools-delivery-20261001.md)
records unit/contract, real HTTP/PostgreSQL and actual dual-Agent model/Trace
evidence. The [D4A delivery](../../docs/skill-discovery-temporary-consumer-delivery-20261001.md)
passes its own unit/contract/HTTP/PostgreSQL and deployed file-use/cleanup gates.
User promotion UI is admitted in [Console D6](../../docs/skill-discovery-console-delivery-20261001.md).
The separate [DI1 integration](../../docs/skill-propagation-integration-delivery-20261001.md)
passes actual automatic sources, current-Run use, normal Console promotion and
frozen Template/create/rebuild/Run, including Registry outage and source invalidation.

## Interfaces

| Interface                        | Direction | Purpose                                                              |
| -------------------------------- | --------- | -------------------------------------------------------------------- |
| ACP v1 over WebSocket `/v1/acp`  | inbound   | Stable ACP Session and prompt protocol                               |
| ACP v1 Streamable HTTP `/v1/acp` | inbound   | Official experimental POST/GET/DELETE transport                      |
| ACP v2 over WebSocket `/v2/acp`  | inbound   | Draft ACP Session and prompt protocol                                |
| `GET /status`                    | inbound   | Liveness/readiness without business mutation                         |
| Execution snapshot RPC           | inbound   | Apply current organization configuration and volatile credentials    |
| Agent settlement RPC             | inbound   | Close execution for Controller lifecycle operations                  |
| Execution state get/watch RPC    | inbound   | Current workspace state without Controller Run state                 |
| Workspace execution/intent RPCs  | inbound   | Principal-scoped Bridge recovery receipts and Session watermarks     |
| Administrative audit RPCs        | inbound   | Organization-scoped retained Run/input/event queries                 |
| MCP `2026-07-28` HTTP            | outbound  | Platform Runtime Tool execution                                      |
| ACP `session/request_permission` | outbound  | User confirmation on the existing ACP connection                     |
| OpenAI-compatible model API      | outbound  | Stage 2 model adapter                                                |
| Private PostgreSQL               | owned     | Sessions, messages, checkpoints, Runs, Tool attempts and permissions |

The [execution configuration contract](../../contracts/agent-acp/execution-api.md)
defines Controller publication into ACP. Normal ACP usage has no reverse
Controller access/admission/credential/finish requests.
See [execution audit](docs/execution-audit.md) for management identity, retained
original input, independent message/permission cursors and tracing behavior.

Both versions retain WebSocket; `/v1/acp` additionally supports the official
experimental Streamable HTTP transport (POST/GET/DELETE). See the
[HTTP transport contract](docs/http-transport.md) for connection ownership,
recovery and Gateway integration. Each endpoint feeds the
matching official SDK surface: the stable package root for v1 and the
batch-capable experimental `WireStream` for v2. ACP success shapes are not
extended outside their standard schema; the optional `antnest.dev/bridge`
negotiation uses SDK-supported `_meta`. The unversioned `/acp` is deliberately absent so
protocol selection is never implicit.

The [workspace Bridge extension](../../contracts/agent-acp/workspace-bridge.md)
adds durable prompt intent IDs with Session append compare-and-swap, targeted Run
cancellation, scoped execution/intent observation, and sequenced replay/live
delivery marks. Standard ACP clients do not negotiate the extension and retain
their existing wire behavior. The two internal `GET /rpc/agent-acp/workspace/…`
routes require trusted organization, principal and Agent headers and repeat
authorization before reading; they are not browser endpoints. ACP remains the
execution and history authority when the future agent-ui Node Bridge reconnects.
The B1 producer's local evidence is 826 unit tests, 159 integration tests, 248
PostgreSQL/E2E tests, contract validation, and a production-container readiness
and protected-route smoke test. Node, Gateway and browser consumption remain
separate service batches.

### ACP Capability Matrix

| Surface   | Implemented                                                                                                                                                                                                                                                                                                                                                                                   | Not implemented; scope classified separately                                                                                   |
| --------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| v1 stable | `initialize`, `session/new`, `session/load`, `session/list`, `session/resume`, `session/close`, `session/delete`, `session/prompt`, `session/cancel`, `session/set_config_option`, `session/set_mode`, reverse `session/request_permission`, replayable message/thought/Tool/usage/plan updates, command catalog, session-info and config/mode notifications; SDK-experimental `session/fork` | Client filesystem and terminal delegation, authentication, Provider administration, elicitation, NES, document synchronization |
| v2 draft  | `initialize`, `session/new`, `session/list`, `session/resume`, `session/close`, `session/delete`, `session/fork`, `session/prompt`, `session/cancel`, `session/set_config_option`, reverse `session/request_permission`, replayable message/thought/Tool/usage/state/session-info/plan updates, command catalog and config notifications                                                      | Authentication, Provider administration, message-tunneled MCP, elicitation, NES, document synchronization                      |

The executable coverage contract is maintained in
[`docs/protocol-conformance.md`](docs/protocol-conformance.md). Stable ACP v1
requires client stdio MCP support. Antnest deliberately accepts only
`mcpServers: []` on both ACP versions. Every nonempty list (HTTP, stdio, SSE,
MCP-over-ACP) fails explicitly with `client_mcp_not_allowed`; no client MCP
capability is advertised. Only platform Runtime MCP tools are available.
Platform-configured stdio children are hosted inside Runtime, not on the
shared ACP host. See [Runtime context](docs/runtime-context.md).
This restricted profile must not be described as generic full v1 conformance.
Client injection as a whole is deferred from the current closeout. Future
administrator opt-in and the client transport are separate decisions; see
[MCP trust and injection boundary](docs/client-mcp-policy.md).

This matrix describes current behavior, not the final server capability target.
Methods are advertised only when their semantics are implemented. Platform
authentication and Provider authority remain in their owning services; authorized
Session options can be exposed without transferring that authority. Client-owned
filesystem/terminal delegation remains outside the Runtime execution model.
Other stable capabilities require implementation even if today's UI does not
use them; unsupported surfaces are not stubbed with false success responses.

## Runtime Rebuild Integration

Controller owns Runtime lifecycle and publishes only its confirmed current
binding through execution configuration. ACP fixes the Runtime identity in each
accepted Run; it never changes a running Tool loop's endpoint. Configuration
application is distinct from Runtime readiness or Agent settlement.
`POST /rpc/agent-acp/settle-agent` checks the closed lifecycle operation, waits
outside configuration publication and reports local quiescence plus durable
stopping evidence. New prompts cannot reuse a protected Runtime revision.
Skill-maintenance barriers are tied to the Runtime execution that produced the
unknown effect. A confirmed replacement with a different execution ID can
accept foreground Runs while the old ledger entry remains unresolved; a
configuration update retaining the same Runtime cannot clear its barrier.
Controller lifecycle calls and confirmed replacement remain B2/B5 integration.

## Connection Identity

Gateway supplies a trusted organization/principal/Agent tuple in internal headers.
It authenticates external users and must strip spoofed identity headers. ACP
authorizes resource methods against the locally applied current organization
snapshot; no opaque subject or outbound identity lookup remains. It advertises no
ACP `authMethods` because authentication completed at the transport boundary.

## Local Commands

Unit tests remain in `test/`. PostgreSQL and protocol integration tests live in
[`tests/integration/agent-acp-service`](../../tests/integration/agent-acp-service),
and Docker/Stage 2 acceptance lives in
[`tests/e2e/agent-acp-service`](../../tests/e2e/agent-acp-service).
Their runners reuse this service's locked dependencies; no separate root test
installation is required. `test:integration` runs official ACP/MCP protocol peers,
HTTP/WebSocket/SSE boundaries and HTTP trace propagation. `test:postgres`
selects the real PostgreSQL cases, and
`test:audit:v1` remains the opt-in SDK audit. The execution contract generator
stays in `scripts/`.

```bash
npm ci
npm run format:check
npm run lint
npm run typecheck
node --import tsx scripts/execution-contract.mjs --check
npm test
npm run test:integration
npm run test:postgres
```

The [SDK audit and regression report](docs/acp-v1-sdk-audit.md) lists all 42 SDK
methods and gives commands for the isolated v1 audit and production-image Docker
regressions. The audit requires its own disposable database ending in `_audit`.

Run these commands from this service directory. If execution contract definitions
change, regenerate the shared schemas with
`node --import tsx scripts/execution-contract.mjs --write`, then review the diff
and run the check plus contract tests. Schema generation does not replace runtime
authorization or semantic reference validation.

Build the production image from the repository root:

```bash
docker compose --profile stage2 build agent-acp-service
```

The Compose service participates in both `stage2` and `stage3`. The new execution
boundary requires coordinated consumer/configuration-publisher updates before
deployment; the existing Compose stack is not yet this refactor's acceptance.
ACP has no outbound Controller URL. Service-local component tests use synthetic
configuration publication; complete platform evidence follows the later batches.

See [`docs/architecture.md`](docs/architecture.md) for the domain and module
map, and [`docs/operations.md`](docs/operations.md) for configuration,
readiness, telemetry, secrets, and failure recovery.

The [observability implementation](docs/observability.md) documents HTTP/ACP
parentage, safe diagnostic projections and unresolved SDK correlation limits.
Readiness checks local initialization/worker ownership and private PostgreSQL
only; it does not probe Controller or aggregate downstream health.
