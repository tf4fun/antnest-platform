# Agent ACP Service Skills

This document describes the Skill features that Agent ACP Service owns: Runtime
Skill commands, the automatic Skill learning worker, dynamic Skill sources and
the `find_skill` / `load_skill` model tools. Cross-service design lives in the
[Skill learning design](../../../docs/skill-learning-design.md), the
[Skill Registry design](../../../docs/skill-registry-minimal-design.md) and the
[learning notifications design](../../../docs/skill-learning-notifications-design.md).

## Runtime Skill Commands

Runtime Skills are available as `/skill:system:<name> <task>` and
`/skill:personal:<name> <task>`. ACP discovers current Skill metadata,
advertises it on `initialize` and Session setup, and refreshes it after Runs
and learning notices. Selecting a command only completes the draft. Invoking it
loads the selected `SKILL.md` into transient user context under the normal Run
budget. See the [Skill command contract](../../../contracts/agent-acp/skill-commands.md).

## Automatic Skill Learning

The learning worker reviews completed Runs and can create or update one
ACP-managed personal Skill per task. The service-level contract is the
[learning API](../../../contracts/skill-learning/learning-api.md).

### Enablement

The worker starts only when both `ANTNEST_ACP_SKILL_LEARNING_CONTROLLER_URL`
and the maintenance signing pair (`ANTNEST_ACP_SKILL_MAINTENANCE_SIGNING_KID`
and `ANTNEST_ACP_SKILL_MAINTENANCE_SIGNING_KEY`) are configured. Setting the
Controller URL alone does not enable learning. The signing key is canonical
base64 Ed25519 PKCS8 DER, and its public key must be in the target Runtime's
frozen verifier set before maintenance is enabled. The worker starts after
startup recovery and stops before the worker lock is released.

### Scanning and Claiming

- A durable cursor scans completed Runs. It stops at an earlier nonterminal
  Run. A full queue leaves the source eligible. The frozen policy and the
  source decision commit together with the cursor advance.
- Scan cuts and cursor timestamps travel to and from PostgreSQL as timestamp
  text. Converting them through JavaScript `Date` would lose microseconds and
  could replay a decided Run or skip a Run just before reactivation.
- Review cues are a real Tool-round threshold (up to three distinct model rounds
  whose proposed Tool IDs have real attempts in the Run) and correction phrases
  in the Run's own user message, counted only when the previous completed Run in
  that Session read a Skill. Rejected preflight proposals and duplicate response
  IDs do not count. A correction is only a review cue; it never authorizes a
  Skill change. Failed Runs are skipped.
- The Controller policy reader validates the owner-scoped response and keeps the
  server-owned activation cut at microsecond precision. It fails closed on access
  loss, malformed or oversized responses and transient failures.
- Claiming enforces one running review globally, 15 seconds of Agent idle time
  and a 10-minute per-Agent cooldown. Claim admission reads the current owner
  policy and validates it again inside the claim transaction. A disabled or
  changed policy cancels the pending task without consuming a review attempt; a
  Controller read failure leaves it pending.
- Per-Agent daily budget admission counts every claim generation and model-call
  reservation in the UTC calendar day across tasks. Settled actual usage replaces
  the reservation.

### Evidence and Review

- The source reader returns owner-scoped, bounded user text and Tool
  observations from completed Runs. Observed attempt state is labeled separately
  from untrusted Tool output. PostgreSQL truncates text before returning it.
- A claimed task persists one immutable, idempotent evidence snapshot. Changed
  selected content conflicts on replay.
- The immutable review prompt and strict output parser produce only a bounded
  `skip` or a single-Skill proposal with per-rule citations. Evidence is
  serialized as labeled data; Tool output is never promoted to a user instruction.
- The citation guard reloads the snapshot, checks its digest and requires each
  proposed rule to cite an in-task user or observed-execution item. Tool output
  alone cannot support automatic application. These checks do not prove that a
  model-synthesized rule is semantically correct for every future task.
- Review uses no tools, allows one bounded format repair and stops on unknown
  usage. A model-call ledger reserves each request before dispatch, returns
  `dispatch=false` on replay and records actual usage idempotently. Current
  model-profile authority rejects disabled or drifted Agent, model or Provider
  configuration before reservation and after dispatch.
- Inference stops waiting when its cancellation signal fires, even if an adapter
  ignores cancellation. Late responses cannot persist proposals; missing final
  usage keeps the reservation unknown. Model usage uncertainty does not hold the
  Runtime slot.

### Candidates and Application

- The candidate builder renders a one-file `SKILL.md` from cited rules only; the
  model's free-form instructions are not packaged. It produces deterministic ZIP
  and Registry manifest digests. Tasks freeze `package_rules_version=1`.
- One candidate per task is stored with its ZIP bytes, artifact and content
  digests, managed path, base digest and evidence IDs. The store validates
  canonical bytes on write and read and rejects a different candidate on replay.
- Apply admission rejects stale or disabled policy, pinned or unregistered
  updates, system-name collisions, incomplete Runtime inventories and changed
  execution bindings. A candidate freezes its apply basis only after a matching
  settled Runtime `check` receipt.
- The apply coordinator orders `prepare`, `check`, fresh policy and Runtime
  admission, conditional `commit` and durable change recording. A checked
  candidate reads Skill inventory from the current execution binding with an
  execution-ID fence, not from the source Run's Runtime snapshot.
- Applied changes complete through the change ledger. Blocked or unknown effects
  pause the task. Settled conflicts and rejections fail the immutable candidate
  and task in one transaction.

### Runtime Maintenance Client

The client signs the exact request body and validates bounded receipts for
`prepare`, `check`, `commit`, `observe`, `cancel` and `release`.

- A PostgreSQL intent ledger records request identity, execution binding, body
  digest and bounded facts before the first dispatch. Replaying the same intent
  returns a non-dispatch receipt; changed inputs conflict.
- Network loss, server errors, retryable responses and invalid receipts remain
  unknown effects. Deterministic 4xx rejections settle as rejections. Outcomes
  survive restart.
- File effects are never blindly retried. Only an unknown read-only `observe`
  can be sent again with the same request identity, and an unknown `release`
  can replay its identity against Runtime's durable cleanup receipt. `commit` is
  never redispatched.
- A lost `commit` can settle from a separately recorded matching `observe`
  result. The ledger keeps that observation as provenance instead of fabricating
  a Runtime receipt. An `unknown` observation leaves the effect open.
- The worker performs at most one settled-candidate cleanup per pass under the
  foreground maintenance guard, keeps bytes needed by unresolved effects and
  defers cleanup while the Runtime is closed to Runs.

### Foreground Priority and Recovery

- Foreground Run admission has a maintenance preemption gate. The task guard
  closes its gate lease only after reading the durable maintenance ledger.
  Unresolved Runtime intents or a failed ledger read keep foreground admission
  fenced. A separate recovery lease can observe old effects and clears the fence
  only after durable settlement.
- Maintenance barriers belong to the Runtime execution that produced the unknown
  effect. A confirmed replacement with a different execution ID can accept
  foreground Runs while the old ledger entry remains unresolved.
- On startup the exclusive worker owner pauses abandoned claims and marks
  unfinished model calls unknown, without erasing budget or claim identity.
  Same-Agent work stays blocked until the unknown effect is observed.
- A task outcome can pause a claim with an actionable reason. Resume keeps the
  claim and spent budget and requires unchanged policy, an idle Agent and settled
  model and Runtime effects. A Runtime `cancel` closes its generation and blocks
  same-claim resume; a later transaction can hand the unapplied candidate to a
  new claim generation while preserving candidate bytes and spent budget.
- Recovery enumerates paused claims in bounded keyset pages and observes an
  earlier commit before resuming or handing off a claim. A failed task does not
  stop recovery of other Agents. Unexpected review or application errors persist
  `paused / runtime_unavailable` and release the global review slot.

### Changes, Notices and Status

- An owner-scoped, bounded change-list route reads committed changes with sealed,
  signed directional cursors. Deleted source Sessions are redacted. There is no
  undo or diff route.
- A notice publisher reads committed changes, wakes after commit and sends
  experimental SDK notices through associated ACP v1 Sessions that negotiated
  them. See the [notifications design](../../../docs/skill-learning-notifications-design.md).
- `GET /rpc/agent-acp/workspace/agents/{agentId}/learning-status` returns current
  paused blockers behind Agent access checks. It requires trusted identity,
  rejects query parameters and returns unavailable reads as errors rather than an
  empty status.

### Diagnostics

Review, model calls, result validation and application are grouped under the
`skill_learning.task` span with the Agent, task, generation and
`antnest.learning.source_run.id`. Model calls use `model.purpose=skill_learning`.
Rejected results record bounded failure categories and schema paths, response
size, stop reason and usage, without prompts, Skill contents or credentials.
Intentional skips and foreground preemption are not task failures.

`ANTNEST_ACP_SKILL_LEARNING_DEBUG_AGENT_ID` is a development setting. A configured
Agent ID requires `ANTNEST_ACP_ALLOW_DEVELOPMENT_SETTINGS=true`; otherwise
configuration fails before opening the database or network. The gate defaults
to `false` and accepts exactly `true` or `false`, without trimming or case
conversion. Every startup with a debug Agent emits one warning,
`Skill learning debug mode is active`, with `agent_id`; no warning is emitted
when no debug Agent is configured. Standard Compose does not pass either setting
from the host environment. Only the Skill learning E2E override supplies them.

For the named Agent, newly scanned Runs skip the experience cue and cooldown, and review
uses prompt version 2, which requires a minimal proposal instead of `skip`.
Authorization, policy, budgets, foreground priority and candidate checks still
apply. The mode is frozen per task and visible as `antnest.learning.debug` and
`antnest.learning.review_prompt_version` in traces. It is unset by default and
must not be set in production.

## Dynamic Skill Sources

The [discovery and source contract](../../../contracts/skill-registry/discovery-api.md)
limits projection to applied, automatically generated, ACP-managed personal
packages. Each apply settles its metadata head in the same transaction as the
learning change and managed identity. Registry receives only organization,
source Agent and owner, name, description, sequence, digest and active state.
Content stays in the Agent-owned store and Runtime workspace.

Discovery is enabled only when `ANTNEST_ACP_SKILL_REGISTRY_URL`,
`ANTNEST_ACP_SKILL_REGISTRY_TOKEN` and `ANTNEST_ACP_SKILL_SOURCE_TOKEN` are all
set together with the maintenance signing configuration. The two tokens must be
distinct printable values of at least 32 bytes, and the Registry URL must be an
origin. The Registry's paired source URL and token must point at this ACP
deployment. The standard Compose stack derives all of them from
`ANTNEST_SKILL_REGISTRY_SOURCE_TOKEN`; see [Skill deployment](../../../docs/skill-deployment.md).

- One background worker delivers durable metadata heads with persisted bounded
  backoff, reconciles acknowledgements and fills missing heads from confirmed
  managed sources. It never replays a learning model call. Revoked access or
  inactive managed state produces a higher-sequence tombstone. A Registry outage
  never fails a completed learning operation or Run.
- `POST /internal/skill-sources/inspect` and `POST /internal/skill-sources/artifact`
  accept only the source bearer. They apply strict schemas, 8 KiB and 4 KiB body
  limits, current owner access and exact sequence and digest checks. Both need an
  available source Agent Runtime; otherwise they return `source_unavailable`.
  Retained candidate bytes are never served as an offline substitute.
- The signed Runtime `observe` operation verifies the complete directory
  manifest, including extra files and modes. An artifact is returned only when it
  equals the managed candidate's canonical package digest. Observation runs under
  the idle maintenance gate, is bounded to five seconds, and never writes a
  candidate, creates a Run or calls a model. Foreground preemption discards the
  delivery. Access, binding and identity are checked again afterwards.
- Disabling an Agent makes its sources return 503 without changing the managed
  content identity. Enabling verifies the preserved workspace on the new Runtime.
  Deleting rejects old references with 404 and delivers the tombstone.

## Skill Discovery Tools

When discovery is configured, ACP adds `find_skill` and `load_skill` as platform
tools with `source=agent` and `sourceId=skill_registry`, outside Runtime MCP. A
Runtime tool that collides with these names fails explicitly. See the
[tool contract](../../../contracts/agent-acp/skill-discovery-tools.md) and the
[temporary Skill consumer contract](../../../contracts/agent-acp/skill-temporary-consumer.md).

- Each call is bound to the active Run, Session owner, organization, current Agent
  access and exact Runtime execution; the model cannot supply them. Access is
  checked again after I/O. Each Run allows eight searches and four loads,
  counting dispatched failures and recovered attempts.
- `find_skill` sends a trusted `requesting_agent_id`, so Registry excludes the
  caller's own personal mappings and an active Run never waits on its own idle
  maintenance slot. Formal versions and other authorized Agent sources remain
  eligible.
- `load_skill` validates exact ZIP headers and bytes, the canonical file and
  execute-mode digest, size and entry limits, safe paths and CRC before exposing
  UTF-8 `SKILL.md` text. Multi-file packages are installed as current-Run files
  and return a path only after a strict signed receipt. Text-only packages keep
  `temporary_files=null`. ACP keeps no discovery cache.
- Search and text reads have `toolEffectState=none`. `load_skill` has
  `readOnlyHint=false` and requires ordinary authorization. ACP persists a
  Run-bound scope before install, attempts release before the Run ends, and a
  serial recovery worker cleans up ended scopes after restart.
- Registry errors are sanitized and stay distinct from an empty search. The
  `skill.discovery.search` and `skill.discovery.load` spans carry Run, source and
  digest identities without queries, package bodies or credentials.
