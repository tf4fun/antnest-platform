# Skill learning shared contract v1

This document is the shared contract for automatic Skill learning: Agent-level
learning policy, automatic review and candidate generation, idle activation of
applied changes, result notices, and later Run use. It spans Antnest Runtime,
Runtime Controller, Agent Controller, Agent ACP Service and Agent UI. Version 1
excludes undo, change-detail diffs, retained rollback versions and explicit
adoption of existing Skills. Optional manual saving (`apply_basis=user_action`)
is defined in the schema but not implemented.

The [design](../../docs/skill-learning-design.md),
[notification design](../../docs/skill-learning-notifications-design.md),
[machine-readable values](learning-api.schema.json), and
[contract tests](../../tests/integration/skill-learning/contracts.test.mjs)
form one boundary. Schema additions to the existing
[RuntimeSpec](../runtime/runtime-spec.schema.json),
[ACP Bridge](../agent-acp/workspace-bridge.schema.json) and
[workspace View](../agent-ui/workspace-api.schema.json) define consumer fields.
Organization, Agent and principal IDs follow existing opaque service/Identity
ID syntax rather than requiring generated `org_`, `agent_` or `user_` prefixes.
Syntactic acceptance never establishes ownership; every read and mutation
checks the stored organization, owner and current authorization.

## 1. Ownership and activation

Agent Controller owns one Agent-level learning policy and its independent
revision. A new Agent defaults to `automatic`, with
`scope.auto_generated_personal=true`, no adopted or pinned paths, and the
limits below. Agents without a stored policy receive the same initial policy.
`off` stops new review admission and invalidates uncommitted automatic
apply bases. Existing Skills remain readable. Policy changes do not require a
Runtime rebuild. Existing user Skills are not automatically adopted. The
reserved `adopted_paths` field is always empty; explicit adoption is not
implemented.
`pinned_paths` prevent automatic
updates, including a future Skill created at that canonical path. A pin never
grants maintenance authority, so Controller validates its exact path syntax and
owner authorization without asking ACP to attest that the path currently exists.
ACP excludes pinned managed packages from review context. If a settled model
proposal nevertheless names a path pinned by the task's frozen policy, ACP
records a skipped task only after verifying that exact proposal and pin in its
durable records; it creates no candidate, applied change or success notice.
A pin introduced after task claim changes the policy revision, so the old claim
cannot use its prior apply basis.
Template system Skills remain immutable and outside this policy.
The server-owned `activation_cut_at` is part of the read/result policy and its
revision, never a mutation input. The lazy default uses the Agent's persisted
creation time, so an ACP outage cannot silently exclude Runs completed before
the first policy read. A transition from `off` to `automatic` atomically sets a
new cut; other mutations retain it. ACP resets its scan cursor only when the
cut changes and never reviews Runs created during an `off` interval.

ACP receives the policy only through Controller's trusted Agent projection or
a scoped read; an ACP request cannot select another organization, Agent, owner,
policy revision or model authorization. Controller exposes a revision-checked
policy mutation and owner-scoped read. Effective model authorization and
provider credentials continue to follow Controller's existing ownership.
ACP charges completed maintenance model calls to the Agent/owner/organization,
distinguished from foreground usage. Owner or model authorization loss pauses
new maintenance without converting the source Run to failure.

The policy's v1 per-Agent ceilings are 20 reviews/day, 320,000 model input
tokens/day and 80,000 output tokens/day. Owner/organization limits can only
lower these caps. A default `automatic` Agent does not require a per-change
click; `apply_basis=policy` records the exact policy revision, path, target
digest and supporting evidence IDs. Optional manual saving would use
`apply_basis=user_action` with an authenticated action and exact confirmation;
it is not implemented. A model-produced `user_action_id`,
confirmation, role or policy revision is never authority.

## 2. Automatic trigger, evidence and budget

ACP creates at most one maintenance task for
`(organization, agent, source_run_id, trigger=run_completed)`, after the Run's
`completed` state and output have committed. Failed, cancelled and unresolved
Runs never create successful-process candidates. A user-authored correction is
a **review cue**, not an authorization bypass; the message role comes from ACP's
persisted message record. Other review cues are at least three distinct model
rounds that actually used tools, or a correction after use of a Skill recorded
by the Run. Ordinary question/answer and state-only Turns skip review.
Review may still choose `skipped`: a cue never forces a new Skill.

Each candidate rule cites bounded evidence with one of the schema's source
kinds: `authenticated_user`, `observed_execution`, `untrusted_material` or
`model_inference`. Only the first two can support automatic application.
Exit code zero proves that a process exited successfully; it does not validate
the semantic claim in its output. External pages, files and tool text cannot
be promoted to a user correction through summarization. If provenance is
missing, source access has gone, or only untrusted/model evidence supports a
rule, the candidate stays unapplied. `package_rules_version=1` means the
[Registry package rules](../skill-registry/registry-api.md#package-rules-v1),
including its shared YAML/parser cases. `review_prompt_version=1` is the
standard immutable ACP review prompt. Neither is the Skill collection
`layout_version`.

The limits are: one global review worker, one review per Agent, at most
two model requests per task (one format repair), 16,000 total input and 4,000
total output tokens, 90 seconds total model time, and one Skill candidate per
review. After a completed source Run, wait for 15 seconds of Agent idle time;
successive attempts for that Agent have a 10-minute cooldown. Do not occupy
Runtime's single execution slot while the model is thinking. Actual calls and
tokens count even if the task is cancelled. The queue holds at most 100
unstarted tasks globally and two per Agent; excess sources remain eligible in
the persisted completion scan instead of being reported as failed.

Daily limits use the UTC calendar day of each review claim or model-call
reservation. A new claim generation consumes one review attempt even after
cancellation or worker loss; an idempotent replay does not. Reserve model
input/output capacity before dispatch and count unresolved calls
conservatively. Settlement replaces the reservation with actual usage, even
when the task was cancelled or paused. If actual usage exceeds an estimate,
record the real amount and deny further calls until the daily window has
capacity. Policy changes are rechecked before a new claim or model call;
neither a retry nor a new task may erase earlier usage.

The ACP worker scans persisted completed Runs from each Agent's policy
activation cut, in pages of at most 100, and advances its durable scan cursor
only after a source is enqueued, merged or recorded as skipped. On restart it
continues from this cursor, not an in-memory wake-up. Enqueue/replay cannot
reset a task's frozen prompt version, policy revision or consumed budget.
Existing Runs before policy activation are not retroactively reviewed. One
candidate per review and a 256 MiB temporary candidate cap per Agent bound
disk usage. ACP protects bytes needed for unresolved effects; Runtime enforces the
physical byte cap before adding hidden candidate bytes. For
admission, bytes means regular-file lengths under candidate and detached-release
trees, including receipts; directory metadata and filesystem
allocation overhead are outside this logical 256 MiB bound. A full
store blocks a new write until ACP releases settled entries; it never evicts
an entry merely because another candidate needs space. Cleanup never deletes
an in-flight candidate or bytes needed to resolve an unknown effect.
Runtime returns `409 skill_storage_full` before a new hidden write when the
256 MiB cap would be exceeded. Replaying an already present, matching item
remains possible; ACP can release a settled item and retry the original task.

`task.state` and `candidate.state` are separate. Paused work has a cause such
as policy disabled, foreground preemption, writer present, access revoked or
unknown effect; an actionable cause is not rewritten to generic success.

## 3. Runtime private maintenance boundary

Endpoint: `POST /internal/skill-maintenance/{action}`, where `action` is exactly
`prepare`, `check`, `commit`, `observe`, `cancel` or `release`. The endpoint is
separate from `/mcp`, never appears in `tools/list` or Runtime information,
and rejects missing/invalid credentials before it acquires the Execution Actor.
Ordinary `tools/call` rejects the reserved prefix `antnest_skill_maintenance_`
even if a managed MCP child advertises it. ACP's foreground Tool dispatcher
does not expose an HTTP route to this endpoint. `X-Antnest-Expected-Execution-ID`
is still required, but is only a consistency check.

`prepare` accepts exactly two multipart parts: `metadata` matching
`prepare_request` (≤4 KiB UTF-8 JSON) and `artifact` (≤8 MiB ZIP). The exact
multipart body, including boundary, is hashed for the ticket; decompressed
regular files cannot exceed 32 MiB. Its package is checked against Registry
v1 rules and placed as a real directory under
`/workspace/.antnest/skill-learning/`, outside Skill discovery. `check`
revalidates its complete file inventory/content, package name/path and source
candidate digest. Other actions accept one JSON object matching the named
schema definition, at most 16 KiB including whitespace. No action accepts
an arbitrary absolute destination or symlink. Candidate ID and request ID
are opaque identifiers, not file paths.

`commit` requires a previously checked candidate, exact target digest,
and `expected_base_digest`. ACP checks the registered managed path and current
policy/apply basis before it signs the request; Runtime checks the signed path
against its candidate record and actual filesystem state. Runtime never treats
a path or policy claim in unsigned request text as authority. Null base means
no activity directory may exist;
new creation uses `RENAME_NOREPLACE`. Replacement uses
`RENAME_EXCHANGE` for complete directories on the same workspace volume.
Runtime keeps its single execution slot through checking writer state,
conditional exchange, full readback digest and applicable sync. It never
changes the read-only `/skills` volume. The shared package digest is the
Registry canonical regular-file manifest digest, not a hash of just
`SKILL.md`. If the filesystem lacks the required atomic operation, fail with
`atomic_skill_replace_unsupported` and keep the old active package.

`observe` names the original effect request and expected resulting digest;
after a timeout, lost response or process restart, ACP observes before any
further mutation. If the target already matches, it settles the original effect and
must not exchange a second time. An unknown result stays unknown until
observation or manual resolution. `observe` is a read-only probe: an uncertain
transport result or an `outcome=unknown` response leaves its intent unknown
without a settled receipt. Once the prior invocation has ended or its worker
has lost ownership, ACP may issue the
same observation request ID, body and execution identity again. Runtime
re-evaluates the current effect; only an `applied` or `conflict` observation
settles that intent and becomes immutable. This exception does not permit
redispatching `commit` or another file-effect action. `cancel` closes a maintenance generation;
the foreground Run starts preparation only after in-flight Runtime maintenance
has settled or been cancelled and observed. The foreground barrier is bound to
the affected Runtime execution. After a completed lifecycle replacement
publishes a distinct executable Runtime, unresolved intents for the stopped
old execution remain in the ledger but do not fence the replacement's Run
slot. A configuration update that retains the same Runtime execution never
clears that barrier.
If lifecycle stopping interrupts a `commit` after an atomic directory install,
the replacement Runtime may observe that original request against the retained
workspace volume after Controller publishes it as accepting Runs. ACP keeps the
old intent and its original checked candidate/policy basis, uses a new
observation request ID bound to the replacement execution, and settles the
old commit only from a matching observed target digest. A prior unknown
observation stays in the ledger; it is neither retried against a different
execution nor treated as proof of failure. Observation may also report
conflict/unknown, in which case no applied change or success notice is created.

`release` is a separately signed, idempotent physical cleanup of one hidden
`candidate` directory. Its 64-hex storage key, managed package path and
expected digest must match the stored receipt.
`prepare` receipts expose the corresponding storage key. Runtime rejects active paths,
mismatched bytes and arbitrary paths; its single execution slot keeps release
from overlapping an active effect. ACP signs
`release` only after its durable ledger has settled or abandoned the candidate,
completed observation, and removed every pending recovery reference to
the item. The call is allowed after a generation was cancelled. Runtime records
the signed release intent before atomically detaching the directory and keeps
a durable completion receipt: replaying the same request cannot delete a new
directory with the same key. A missing item without that receipt is `unknown`,
not success. Deletion and readback run as UID/GID 1000 and do not affect the
active Skill directory. Runtime implements this physical boundary; ACP owns
cleanup after settlement.

ACP cleanup consumes the durable `prepare` receipt's `storage_key`, package
path and target digest; it must not derive the release digest from the old
bytes left in the candidate directory after an update. Runtime validates the
candidate receipt's target identity even when that directory contains the
exchanged base package. A completed task remains eligible for cleanup after
worker restart. Cleanup failure does not undo an applied change, emit another
success notice, or cause another commit. Terminal-task cleanup includes settled
preparations from earlier generations; it uses the current task claim for
authorization and the original preparation receipt for storage identity.
Unresolved commit/observation intents
keep the candidate ineligible for release. Cleanup is bounded background work,
not a prerequisite for foreground Run admission.
This does not bypass Runtime's single execution slot: while a release is
actually in flight or its slot ownership is unknown, the existing maintenance
barrier applies until bounded recovery settles it. A queued cleanup item alone
does not fence the Agent, and foreground ownership prevents cleanup dispatch.
After a release response is lost and its prior invocation has ended, ACP may
replay the identical release request ID, body and execution binding. Runtime's
durable release receipt makes this safe even after directory deletion. This
exception does not permit redispatching a commit or changing a cleanup target.
ACP bounds one release transport attempt to five seconds. Timeout leaves an
unknown intent for identical recovery rather than abandoning its storage or
holding the serial learning worker indefinitely.
Before dispatch, foreground cancellation prevents release. After dispatch,
foreground/lifecycle handoff waits for the bounded release receipt instead of
aborting its transport and manufacturing an unknown cleanup effect. Worker
shutdown and the five-second deadline still cancel that transport.

Runtime tracks live Bash tasks and descendants, managed MCP requests and
unsettled tool/info operations. Running foreground work, active managed
requests, live Bash descendants, or unknown writer ownership block commit.
An idle managed MCP process alone does not. A blocked candidate releases the
execution slot; a foreground Run can then ask the Agent to stop its own
background task through existing permissions. There is no new kill endpoint.
Only the Runtime executor running as UID/GID 1000 reads/writes candidate and
activity bytes. Managed MCP processes can still write autonomously, so the
post-swap digest is mandatory; mismatches return
`skill_content_changed_during_activation` with unknown/conflict semantics,
not success or an unconditional reverse exchange.

## 4. Credential and bootstrap

ACP signs one short-lived ticket per request using Ed25519. The HTTP
`Authorization` value is
`AntnestMaintenance <base64url(header)>.<base64url(payload)>.<base64url(signature)>`.
Header is strict JSON `{ "version": 1, "algorithm": "Ed25519", "kid": "..." }`;
payload is the `ticket` definition in the schema. The exact bytes signed are
UTF-8 `antnest-skill-maintenance-v1`, one LF byte (`0x0a`), then the two
encoded segments joined with `.`. JSON parsers reject duplicate/unknown keys, padded or
noncanonical base64url, oversized tickets and invalid Ed25519 signature.
The signing key is maintenance-only and never reaches the RuntimeSpec,
workspace, tools, model or browser. `body_sha256` hashes the exact raw request
body. Runtime compares signed action with URL action, ticket Agent/execution
with its bootstrap and current process, and request/job/generation with body.
Tickets expire no later than 60 seconds after issue; allow at most 30 seconds
of clock skew. Clock failure closes maintenance, not ordinary Run execution.
The same `(job_id,generation,action,request_id)` with changed body or target
is `request_conflict`; settled effect retries return or recover the original
receipt. The read-only unknown-`observe` exception above re-evaluates current
effect state with the identical request. A cancelled generation cannot commit
with a fresh ticket.

RC freezes the sorted `skill_maintenance_verifiers.keys` array inside each
accepted RuntimeSpec/deployment digest. Zero keys disable maintenance; at most
two keys are trusted. Every `kid` follows the shared
[RuntimeSpec identity rule](../runtime/runtime-spec.schema.json#/$defs/maintenanceKid)
and [fixtures](../runtime/maintenance-kid-fixtures.json), is unique, and is bound
to exact Ed25519 public bytes. The base64url field decodes to exactly 32 bytes. RC stores the complete
public-key snapshot atomically with operation acceptance and uses that snapshot
on replay and restart, never the latest RC config. ACP has one current signing
`kid`; it may switch to the preloaded next key only after checking all relevant
running and in-flight Runtime targets. Removing a trusted key requires an
explicit rebuild. Compromise requires stopping signing **and** isolating or
stopping affected Runtimes, then rebuilding them without the leaked key.
See the rotation procedure in the [learning design](../../docs/skill-learning-design.md).

## 5. Controller, ACP and UI reads

Agent Controller provides `GET /internal/agents/{agent_id}/skill-learning-policy` with exactly
`organization_id` and `principal_id` query keys, and
`PUT /internal/agents/{agent_id}/skill-learning-policy` with a
`policy_mutation_request` body. These are trusted internal routes; the caller
supplies its verified identity, while Controller checks it against the stored
Agent owner and organization. The path, rather than body, selects the Agent.
An owner-scoped read returns `policy`; mutation requires stable `request_id`
and `expected_revision`, returns the resulting `policy`, and replays the same
request ID with the same payload without another revision. A changed payload
for that ID or stale revision is 409. Cross-owner, deleted or unknown Agents do
not reveal policy contents. The operation rejects unknown/pinned/disallowed
paths and checks Agent access. ACP reads through an authenticated service call,
not from browser-provided scope. All policy changes are checked again just
before candidate commit. Disabling/revoking maintenance cancels uncommitted
work but does not erase its provenance or applied files.

ACP stores learning tasks, evidence, candidate facts, managed path identities,
apply bases, intents, outcomes and immutable changes in ACP persistence.

### Development debug learning

ACP may configure `ANTNEST_ACP_SKILL_LEARNING_DEBUG_AGENT_ID` with one Agent ID.
The ID retains the existing `optional()` normalization: leading and trailing
whitespace is removed, and empty or whitespace-only values mean unset. The
development gate is parsed without trimming or case conversion.
The ID requires `ANTNEST_ACP_ALLOW_DEVELOPMENT_SETTINGS=true`; an unset or false
gate rejects configuration before dependency startup. The gate defaults to
`false`, accepts only the exact strings `true` and `false`, and rejects every
other configured value, including empty or whitespace-only values. Each startup
with a configured debug Agent emits one `warn` event,
`Skill learning debug mode is active`, with `agent_id`; no such warning is emitted
without a debug Agent. Standard Compose passes neither setting from the host;
the Skill learning E2E override supplies both explicitly.

It is unset by default and is a development deployment setting, not Agent policy
or a model-callable command. Newly scanned completed Runs for that Agent enter
the existing learning queue without an experience cue. Their immutable
`review_prompt_version=2` requests a minimal evidence-supported proposal instead
of allowing the model to choose `skip`; version 1 retains normal automatic
selection. Version 2 also bypasses the ten-minute review cooldown. The existing
idle grace, foreground priority, access, automatic policy, queue, concurrency,
cost ceilings, citations, package and installation checks remain in force.
An unexpected model `skip` is a validation error, uses at most the existing
single repair call, and never becomes an applied Skill. Debug requests use
normal provider authorization and accounting. Trace records prompt version and
debug mode through the existing task/review/apply spans. No new learning engine,
task-management API or frontend contract is introduced. Restart or removal of
the deployment setting does not change a task's frozen prompt version; existing
source decisions and model receipts are not cleared or replayed by enabling it.

### Minimal blocked-learning projection

`GET /rpc/agent-acp/workspace/agents/{agentId}/learning-status` returns
`learning_status`, with the same trusted identity and owner/Agent access checks
as learning-changes. It accepts no task selection, commands or pagination.
Return at most one current paused blocker, ordered by task creation time and
task ID, or `blocked:null`. Only `writer_present`, `unknown_effect`,
`model_unavailable`, `runtime_unavailable` and `review_inconclusive` are shown;
foreground handoff, lifecycle closure, disabled policy and revoked access do
not become user-action alerts. Terminal tasks are excluded. `skillName`, when
available, comes from the validated candidate identity. Source IDs are omitted
unless the caller can still read that source Session/Run.

ACP owns the projection; Agent UI's Node service carries it through the
existing Agent View/SSE path. A failed read must not be converted to an
authoritative `blocked:null` or a success notice. FE displays the blocker as a
diagnostic inside the learning-results entry when the user opens it, not a
permanent workspace banner, infinite spinner or repeated toast. Ordinary
deferral does not require the user to stop background tasks to continue a
foreground Run; only a successful applied change generates the normal notice.
Read this diagnostic on demand; status changes alone do not require a separate
background polling loop. For `writer_present`,
explain that the user can ask the foreground Agent to stop its background task;
managed MCP configuration changes use the existing explicit rebuild flow.
Do not expose full process arguments, invent a process identity, or offer a
stop/kill button. Unavailability describes a paused review, not a live health
check. Do not promise to replay an unresolved model call; new completed sources
may be reviewed after recovery under the same idle, cooldown and budget limits.
An inconclusive review reports that no Skill was
applied. This is one status projection, not a learning-task management API.

Tool-free review inference must stop participating in foreground admission as
soon as it is cancelled, even if the model adapter has not yet returned. ACP
still sends the cancellation signal; any late response or error is discarded
and cannot create a proposal. If final usage is unavailable, retain the
reserved cost as unknown, do not refund it or redispatch that model call.
Unknown model cost does not prove the Runtime is busy. This cancellation rule
does not authorize detaching a Runtime file operation: that operation must
still be cancelled/observed before sharing its single execution slot.

### Applied learning records

Execution of review/candidate/commit is a separate low-priority maintenance
task, not an activity Run or fabricated assistant turn. Only applied changes
generate a success notice. Each change gets a unique `changeId` and committed
Agent sequence. Source Session/Run IDs are access-filtered.
The first read page has at most 20 items; an opaque cursor is advanced only
through a server-sealed committed sequence. Initial loading, gap recovery and
historical paging query
`GET /rpc/agent-acp/workspace/agents/{agentId}/learning-changes`.
Exactly one of `after` (incremental ascending) and `before` (older history
descending) may be supplied, with `limit` from 1 to 20; cursor values are at
most 4096 characters. With neither, return the latest 20 records. The response
is `change_page`. `sealedCursor` identifies the highest committed sequence
visible to that authorized read, never an allocated but uncommitted number;
`nextCursor` is the forward continuation point; `olderCursor` is the backward
continuation point or null when history is exhausted. The valid genesis cursor
is the literal `0`, including an Agent with no changes. An initial latest page
sets `nextCursor=sealedCursor` and gives an `olderCursor` when older records
exist. A gap read with `after` uses `nextCursor` for its next page, including
when the page was empty. A history read with `before` uses `olderCursor` for
its next page. Cursors are scoped to the authorized Agent/principal and
direction; expiry or scope mismatch returns `cursor_expired` or
`access_denied`, never an empty success page. Bridge never treats the maximum
notice sequence as a sealed cursor. Sequence assignment and change commit are
one transaction; rolled-back allocations cannot create a visible gap.

This contract reserves the public Node routes
`GET /agents/{agentId}/learning-changes`,
`GET /agents/{agentId}/skill-learning-policy`, and
`POST /agents/{agentId}/skill-learning-policy` under `/api/app/workspace/v1`.
They are not yet implemented by the Node Bridge or listed in
[`workspace-api.json`](../agent-ui/workspace-api.json); Node currently reads
learning changes internally for notice recovery. When implemented, Node
forwards the same strict DTOs after Gateway identity/CSRF validation and fresh
upstream authorization, and does not accept browser-selected organization or
actor IDs.

The live notification is SDK v1 `session/update` with
`update.sessionUpdate="notice"`, `severity="info"`, plain-text title/description
and `update._meta["antnest.dev/skill-learning"]` matching `notice_metadata`.
The metadata includes the committed `occurredAt`, `skillName`, and
`changeSummary` alongside change identity and source IDs. Bridge projects
these recorded facts; it does not substitute local receipt time for completion.
Node declares `clientCapabilities.session.notices={}` and
`_meta["antnest.dev/bridge"].learningNotices=1`; ACP confirms the latter in
`InitializeResponse._meta["antnest.dev/bridge"]`. ACP checks the standard
capability before sending; SDK 1.5.0 does not do this check for the app. The outer sessionId is a real associated **delivery**
Session, while `_meta.sourceSessionId` identifies the real learning source.
Prefer the source if associated; otherwise use one associated Session of that
Agent. If no Session is available, the durable change is recovered on later
association. Never invent a Session or fan out one change to all Sessions on
one connection. See the SDK verification notes in the
[notification design](../../docs/skill-learning-notifications-design.md).

Bridge handles notice before transcript delivery-mark or cached-Session
filtering. One `(organization,principal,agent)` owner deduplicates by changeId,
does bounded record sync after attach/reconnect/reset, and projects at most 20
recent records as optional `AgentView.systemNotices` with normal
snapshot/delta/reset. The field is present on every View. It neither
advances ACP `appendVersion`/`outputWatermark` nor changes Run stopReason.
FE merges duplicate notices and restores from View after browser reload;
initial history does not emit a toast per record. It renders Antnest system
items outside model messages and folded Tool process lists. A notice being
sent, rendered, closed or read is never approval.

## 6. Errors and required outcomes

Private errors use bounded JSON `{error:{code,message,retryable}}`, no
candidate bytes, prompt, command text, token or private key. Invalid request,
ticket or capability is 400/401/403 according to parsing/authentication;
stale execution, changed policy, base/target digest or request replay conflict
is 409. Unsupported atomic filesystem operation is a specific 409;
temporary Runtime unavailability is 503; capacity pressure is 429/503 and
does not settle an unaccepted mutation as failed. `unknown` requires observe,
not a blind new request. `blocked` keeps a candidate and releases the actor.
For `background_task_running` and `managed_call_in_flight`, the bounded
`blocked_subject_id` names the Bash process group (`bash:<pgid>`) or managed
server (`managed:<id>`). An unattributed process can use `unknown:<pid>`;
these identifiers are diagnostic, never authorization or a kill target.

| Input or interruption                                                           | Required result                                                                                         |
| ------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| Completed ordinary Q&A, failed/cancelled Run, tool output claiming to be a user | No automatic application; no fake user action                                                           |
| Completed eligible Run, no new reusable rule                                    | Recorded skip without notice or next review recursion                                                   |
| User correction plus untrusted external text                                    | Only the authenticated correction can support automatic rule scope                                      |
| Candidate from user-owned/system/pinned path or different Agent                 | Reject before maintenance commit                                                                        |
| New foreground Prompt during review model call                                  | Cancel review and settle maintenance calls before Run info; no foreground `agent_busy` caused by review |
| Bash dev server still alive                                                     | Candidate blocked with task identity; execution slot released, foreground can stop it                   |
| Runtime changed during prepare or signing-key rotation                          | Reject old execution ticket; RC resumes accepted operations from frozen key snapshot                    |
| Commit response lost after atomic swap                                          | Observe actual target digest; never swap a second time back to old bytes                                |
| Writer changes package during/after swap                                        | Conflict or unknown, no success notice and no blind rollback                                            |
| Node offline, source Session not subscribed, notice sent twice                  | Learning still completes; record sync restores one system item per change                               |

The [contract tests](../../tests/integration/skill-learning/contracts.test.mjs)
cover machine-readable values and links to existing Runtime/ACP/UI schemas.
Service unit and component tests live with each service; the
`make e2e-skill-learning-*` targets run the Docker E2E scenarios.
