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

### Delivery status

This revision ([#201](https://github.com/tf4fun/antnest-platform/issues/201))
replaces the earlier `prepare`/`check`/`commit`/`observe`/`cancel`/`release`
maintenance transaction with one atomic `install` and a read-only `digest`.
Antnest Runtime serves only `install` and `digest`; a signed request for any
earlier action is `404 unknown_action`. Agent ACP Service and the cross-service
Skill learning E2E suites use the new actions. Runtime Controller, Agent
Controller and Agent UI need no wire change.

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
Existing Runs before policy activation are not retroactively reviewed. A
review produces at most one candidate. ACP stores the candidate artifact
(at most 8 MiB) in its own persistence until the task is terminal; Runtime has
no learning candidate store, release step or storage-full state. Runtime holds
at most one install staging tree, only for the duration of one `install` call
(Section 3).

Review input comes only from ACP persistence: the source Session messages and
Run records, and ACP's stored artifact of the last applied package for each
managed path. Review never reads the Runtime workspace, Runtime information or
Runtime Skill files, so it never takes the Runtime execution slot. A managed
package edited in the workspace after its last applied change is detected by
the `install` base check, not by a review read.

`task.state` and `candidate.state` are separate. Paused work has a cause such
as policy disabled, foreground preemption, writer present, access revoked or
unknown effect; an actionable cause is not rewritten to generic success.

## 3. Runtime private maintenance boundary

Learning is read-only until one Runtime call, `install`, atomically creates or
replaces one managed personal Skill. Everything before that call happens in
ACP and can be cancelled at any time. Runtime keeps no learning transaction
state between calls.

Endpoint: `POST /internal/skill-maintenance/{action}`, where `action` is exactly
`install` or `digest`. The endpoint is separate from `/mcp`, never appears in
`tools/list` or Runtime information, and rejects missing/invalid credentials
before it acquires the Execution Actor. Ordinary `tools/call` rejects the
reserved prefix `antnest_skill_maintenance_` even if a managed MCP child
advertises it. ACP's foreground Tool dispatcher does not expose an HTTP route
to this endpoint. `X-Antnest-Expected-Execution-ID` is still required, but is
only a consistency check.

### Install

`install` accepts exactly two multipart parts: `metadata` matching
`install_request` (≤4 KiB UTF-8 JSON) and `artifact` (≤8 MiB ZIP). The exact
multipart body, including boundary, is hashed for the ticket; decompressed
regular files cannot exceed 32 MiB. No field accepts an arbitrary absolute
destination or symlink; the request ID is an opaque identifier, not a path.
ACP checks the registered managed path and current policy/apply basis before
it signs the request; Runtime checks the signed path against its own
filesystem state and never treats unsigned text as authority.

Within one call, holding the Execution Actor slot, Runtime:

1. Checks writer state. A running Bash background group, an in-flight managed
   MCP call or unknown writer ownership returns `blocked` with the bounded
   subject identity and releases the slot.
2. Removes any staging tree left by an earlier interrupted install, then
   extracts the artifact into a fresh staging tree under
   `/workspace/.antnest/skill-learning/`, on the same volume and outside Skill
   discovery. It validates the complete Registry v1 package rules and requires
   the canonical manifest digest to equal `target_digest`.
3. Reads the active package at `package_path` and decides by digest:
   - active digest equals `target_digest`: the effect is already present.
     Runtime syncs the active directory and its parent and returns `applied`
     without another rename;
   - `expected_base_digest` is null and no active directory exists, or the
     active digest equals `expected_base_digest`: continue;
   - `expected_base_digest` is null and an active directory exists: `conflict`
     with `target_exists`;
   - any other active state: `conflict` with `base_changed`.
4. Installs with one rename: `RENAME_NOREPLACE` for a new package,
   `RENAME_EXCHANGE` of complete directories for an update. Renaming files one
   by one, or deleting and then moving, is never an install.
5. Reads back the complete active inventory and digest and runs the applicable
   directory syncs. A match returns `applied`. A mismatch returns `conflict`
   with `content_changed_during_activation`; Runtime never exchanges back.
6. Removes the staging tree, which after an exchange holds the old package.
   Version 1 keeps no old versions.

The shared package digest is the Registry canonical regular-file manifest
digest, not a hash of just `SKILL.md`. Runtime never changes the read-only
`/skills` volume. If the filesystem lacks the required atomic rename, Runtime
fails with `atomic_skill_replace_unsupported` and keeps the old active package.

`install` is idempotent by content: the decision in step 3 depends only on the
active bytes, the signed base and the signed target. ACP may resend the
identical request body with a fresh ticket, for the same or a later Runtime
execution, after any lost response, preemption, Runtime restart or lifecycle
replacement. A resend either finds the target already present or performs the
same conditional install. No `observe`, `cancel` or `release` call exists, and
Runtime keeps no per-request receipt, generation marker or candidate record.

### Foreground preemption

Learning never waits for foreground work and foreground work never waits for
learning. A maintenance call that finds the execution slot taken returns
`blocked` with `foreground_running` immediately. A foreground MCP request, a
temporary-Skill request or Runtime drain that finds the slot held by a
maintenance call preempts it: Runtime terminates the maintenance executor and
hands the slot to the foreground request within 2 seconds, or returns the
existing retryable `runtime_busy` if the slot is not free by then.

Termination is safe at any point. Before the rename, nothing in the active
Skill directory has changed and the staging tree is removed by the next
install or by Runtime startup. The rename itself is one atomic system call.
After the rename, the active package already holds the target, and the next
install of the same request settles it as `applied`. The preempted call
returns `preempted` with `observed_digest:null`, which means only that this
call did not settle; it does not claim whether the rename happened. ACP treats
a lost response the same way.

### Digest

`digest` is a read-only query of the canonical digest of one managed package
path, used by dynamic Skill discovery before it serves a source package. Its
JSON body matches `digest_request` (≤16 KiB). It returns `observed` with the
active digest, or `observed_digest:null` when no package exists at that path.
It is preempted like `install` and never blocks on writers. Learning itself
does not call `digest`.

### Writers and processes

Runtime tracks live Bash tasks and descendants, managed MCP requests and
unsettled tool/info operations. Running foreground work, active managed
requests, live Bash descendants, or unknown writer ownership block install.
An idle managed MCP process alone does not. A blocked install releases the
execution slot; a foreground Run can then ask the Agent to stop its own
background task through existing permissions. There is no new kill endpoint.
Only the Runtime executor running as UID/GID 1000 reads/writes staging and
active bytes. Managed MCP processes can still write autonomously, so the
post-rename digest is mandatory.

### ACP obligations

ACP dispatches `install` only while the Agent has no active Run, no pending
foreground admission and no pending temporary-Skill scope. This check is
best-effort; Runtime preemption resolves the race. ACP never holds a
foreground gate, `runtime_barrier_required` state or lifecycle barrier because
of learning. Foreground admission, Drain, disable and rebuild never wait for,
cancel-and-observe, or settle a learning call. Foreground admission aborts an
in-flight install request without waiting for its result. An in-flight install
request is abandoned when its lifecycle closes; the task keeps its candidate
and resends the identical install when the Agent is next idle on a published
Runtime. In the rare race where a Run is admitted just after an install was
sent, the install may complete between two Runtime calls of that Run; Runtime
still never runs them concurrently, and the Run's read records identify the
Skill version it read.

ACP settles the task only from a receipt: `applied` records the change and
sends the notice once; `conflict` invalidates the candidate and pauses
maintenance of that path; `blocked` and `preempted` keep the candidate for the
next idle window. A changed policy, revoked access or invalidated apply basis
stops resends. The review model call, which never touches Runtime, is not
cancelled by foreground admission.

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
Runtime keeps no request ledger: replaying a ticket within its lifetime
re-runs the same digest-conditioned `install` or read-only `digest`, which is
safe by construction. ACP owns request identity. It never reuses a request ID
for a different body, and it stops signing for a task once the task is
terminal, its policy basis is invalid or its claim generation is superseded.

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
before install. Disabling/revoking maintenance cancels uninstalled
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

Tool-free review inference never participates in foreground admission. When
ACP cancels it (policy off, access revoked, worker shutdown), any late
response or error is discarded and cannot create a proposal. If final usage is
unavailable, retain the reserved cost as unknown, do not refund it or
redispatch that model call. Unknown model cost does not prove the Runtime is
busy.

### Applied learning records

Execution of review, candidate and install is a separate low-priority maintenance
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
does not settle an unaccepted mutation as failed. `blocked`, `preempted` and
a lost response keep the candidate and release the actor; ACP resends the
identical install later.
For `background_task_running` and `managed_call_in_flight`, the bounded
`blocked_subject_id` names the Bash process group (`bash:<pgid>`) or managed
server (`managed:<id>`). An unattributed process can use `unknown:<pid>`;
these identifiers are diagnostic, never authorization or a kill target.

| Input or interruption                                                           | Required result                                                                                         |
| ------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| Completed ordinary Q&A, failed/cancelled Run, tool output claiming to be a user | No automatic application; no fake user action                                                           |
| Completed eligible Run, no new reusable rule                                    | Recorded skip without notice or next review recursion                                                   |
| User correction plus untrusted external text                                    | Only the authenticated correction can support automatic rule scope                                      |
| Candidate from user-owned/system/pinned path or different Agent                 | Reject before install                                                                                   |
| New foreground Prompt during review model call                                  | Run starts at once; review continues off Runtime; no foreground `agent_busy` caused by review           |
| New foreground call during install                                              | Runtime preempts install and serves the call within 2 seconds; ACP resends install when idle            |
| Disable, Drain or rebuild during review or install                              | Lifecycle proceeds without waiting; no learning `runtime_barrier_required`; candidate kept              |
| Bash dev server still alive                                                     | Install blocked with task identity; execution slot released, foreground can stop it                    |
| Runtime changed during install or signing-key rotation                          | Reject old execution ticket; ACP resends with a fresh ticket; RC resumes from frozen key snapshot       |
| Install response lost or preempted after the rename                             | Resend settles as `applied` from the active digest; never renames a second time                         |
| Writer changes package during/after the rename                                  | `conflict`, no success notice and no blind rollback                                                     |
| Node offline, source Session not subscribed, notice sent twice                  | Learning still completes; record sync restores one system item per change                               |

The [contract tests](../../tests/integration/skill-learning/contracts.test.mjs)
cover machine-readable values and links to existing Runtime/ACP/UI schemas.
Service unit and component tests live with each service; the
`make e2e-skill-learning-*` targets run the Docker E2E scenarios.
