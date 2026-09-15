# ACP Execution Configuration RPC

Status: draft for the reviewed design; production consumers are not switched.
This is an internal control API, not an ACP extension. External ACP versions and
payloads are unchanged. Existing foundation code is not integration acceptance.
The owning design is [the execution boundary plan](../../docs/controller-acp-execution-boundary-plan.md).

## Transport And Identity

The internal base path is `/rpc/agent-acp`. Requests and responses use JSON over
HTTP. Only Controller may publish execution configurations. Gateway must not
expose these routes. No per-Run ticket, signature, or credential lookup exists.

Gateway overwrites these internal headers after authenticating the caller:

- `X-Antnest-Organization-Id`
- `X-Antnest-Principal-Id`
- `X-Antnest-Agent-Id`

The first two values come from verified identity; the third comes from the
Agent route. ACP binds HTTP/WebSocket connections to the tuple and checks
Session ownership locally. The old opaque Agent access subject is not a fallback.
All identifiers are opaque, nonempty strings, at most 200 characters.
Configuration, settlement and audit JSON use this same rule without imposing
an identifier naming convention. Generated schemas follow the owning domain
definitions; transport header validation is not part of those domain schemas.
Adapters must not silently normalize identifiers. Runtime MCP rejects an execution
ID that its HTTP header cannot carry unchanged, before connecting or dispatching.
A storage failure (including a value PostgreSQL cannot represent) does not publish
the new snapshot or return a successful apply acknowledgement.
The trusted-header envelope requires one unambiguous HTTP field value: no
leading/trailing whitespace, comma-joined values or control characters. HTTP
header validity is a transport constraint, not a namespace grammar; printable
values such as `principal+service@example.org` and `agent/department:1` are
preserved exactly. Node header validation rejects values the transport cannot
represent; no trimming, case folding or identity normalization is applied.

## Apply Execution Snapshot

`POST /rpc/agent-acp/apply-execution-snapshot`

This entry accepts `application/json` (optional charset). The body limit is
independent from ACP prompt size, initially 16 MiB and configurable by ACP.
Unsupported methods return 405, oversized bodies 413 and unsupported media or
content encoding 415; rejected requests cannot publish a partial snapshot.
Invalid JSON uses the same non-secret 400 envelope as invalid configuration.

The body is one complete organization snapshot. A monotonically increasing,
JavaScript-safe integer `revision` orders all changes to that organization's
execution configuration. It is not a credential version or Runtime generation.
Controller reads the complete snapshot in one consistent database view and
increments its revision atomically with changes affecting this projection.

The snapshot contains `organization_id`, `revision`, `providers`, `models`, and
`agents`. IDs are unique within each collection in the organization. Model and
Agent references must resolve within the snapshot. An empty snapshot revokes
current access and new execution; it does not purge history.

- Provider: `connection_id`, `provider_key`, `request_protocol`, `base_url`,
  `enabled`, and `credential_revision` plus typed `credential` when enabled.
  Initially only `deepseek`, `openai_chat_completions`, and `api_key` are supported.
  The credential contains `method` and `secret`. A disabled provider may also
  carry the revision/credential pair to rotate authentication of existing
  holders; Controller sends available current material. ACP never creates a
  disabled client solely for this payload and never permits new acquisition.
  Absence of updated material does not promise that a retained credential still
  works at the Provider. Secrets remain volatile and disappear after final release.
- Model: `model_profile_id`, `connection_id`, `display_name`, `enabled`, model API
  ID, token limits, content capabilities, optional temperature and USD pricing.
  The model has no separate historical revision and carries no credentials.
- Agent: `agent_id`, allowed `principal_ids`, `access_revision`, `accepting_runs`,
  nullable `unavailable_reason`, nullable lifecycle `operation_id`,
  `default_model_profile_id`, default authorization, Agent execution settings,
  nullable `agent_spec_revision`, `execution_revision`, and `runtime` binding.
  An accepting Agent requires a current Runtime and execution revisions. A
  disabled/not-yet-built Agent can carry a null binding and revisions.
- Runtime identity is the pair `runtime_revision` and `runtime_execution_id`;
  `mcp_endpoint` is the address, not identity. Publishing the same binding does
  not prove that uncertain commands stopped. Platform replacement confirms
  removal of the old binding before the new one is published as executable.

ACP rejects malformed, unsupported, duplicate, or dangling configuration as a
whole. It must never interpret validation or transport failure as an empty
snapshot. Provider absence stops new acquisition for that connection; model
absence removes that model from new selections, not other models sharing its
connection. Existing client references are revoked immediately, not drained. Agent absence denies ordinary access, while
historical organization ownership remains in Sessions.

The successful result contains `organization_id` and `applied_revision`. It
means local non-secret persistence and live publication completed. Revocation
also invalidates pending approvals/output subscriptions at the local authority
boundary. It does not mean every previously started execution has finished or
that startup interruption cleanup has finished. Execution requires both local
startup cleanup/protection restoration and current configuration application.
Transport availability is separate: an authenticated protocol connection can
receive configuration-unavailable errors without a blanket handshake 503.

Older snapshots return the actual newer live-applied revision without overwriting
state. A stored revision alone cannot authorize this response after restart;
stale input then fails until the current configuration is applied. Equal
revisions must describe identical configurations; they may
rehydrate volatile credentials after startup. They cannot clear execution
protection. Credential changes require a changed credential/configuration
revision. Secret-bearing RPC payloads are not logged or traced. Lifecycle
activities build and send these payloads internally; Workflow/Activity inputs,
results and Temporal history carry only identifiers and non-secret acknowledgements.

Validation/preparation/storage failure does not publish the next configuration.
Failure during publication after storage closes the affected organization's
entry and returns no success ACK; equal or newer input retries publication.
It does not roll back already invalidated approvals to the old permission.

The configuration/authorization boundary protects only short local checks,
bounded database commits, execution ownership registration and publication.
It must not await a model/MCP call, user approval, whole Run or settlement.
Revocation closes entry and invalidates pending actions inside that boundary;
actual cancellation is awaited outside it. An earlier registration is not
permanent dispatch authority: tool dispatch rechecks current authorization.

Connection routing (`provider_key`, `request_protocol`, `base_url`) is immutable
after creation. Credential rotation changes only authentication. Changing the
destination means creating a different connection, not mixing new credentials
with an old Run's fixed endpoint. Provider/model retirement in this batch means
disable, not physical deletion; historical records and references survive.

## Settle Agent

`POST /rpc/agent-acp/settle-agent`

Input: `organization_id`, `agent_id`, `minimum_revision`, `operation_id`, `mode`
(`wait` or `cancel`) and `deadline_at` (UTC RFC3339 timestamp). Controller passes
the existing lifecycle operation's fixed settlement deadline on every retry,
not a new timeout measured from each request. This is not a Run deadline or a
Run reservation. Expiry ends the wait without proving execution stopped, and an
already-expired request must not issue cancellation. ACP must have applied at least the minimum revision, with
the same Agent still closed under the same operation. A newer organization
revision may acknowledge an older close, but a different lifecycle operation
may not. Stale cancellation must not affect a subsequent execution boundary.
Malformed input returns 400; a stale or changed operation returns 409
`agent_operation_conflict`, including changes while waiting. Uninitialized
configuration, shutdown or evidence storage failure returns 503
`settlement_unavailable`. None of these error envelopes contains an outcome.

The result contains `applied_revision` and `outcome`, which is one of:

- `settled`: local dispatch has ended and Runtime foreground calls were never
  sent or the existing contract proves that the call stopped. Historical side effects need not be
  known or successful; Provider-side computation is not guaranteed to stop.
- `runtime_barrier_required`: no local execution or future dispatch remains,
  but stopping an old Runtime command cannot be proven. The existing explicit
  rebuild/disable/delete may isolate that environment before accepting new work.
- `not_settled`: the operation still matches, but local execution may still
  dispatch or waiting expired. Controller must not replace Runtime resources.

No Run IDs, tool outcomes, admission deadlines, or client reference counts are
returned to Controller. Runtime protection is durable in ACP and is cleared
only for the old binding after its replacement, never by equal-snapshot replay.
Ordinary drain closure follows current policy/operation identity and is not a
second durable commit/rollback state. RPC retries respect the same lifecycle
operation's total deadline rather than extending waiting indefinitely.

A returned MCP error alone is not stopping evidence. Managed MCP
`outcome_unknown` may mean cancellation was merely sent;
`child_process_containment_unproven` explicitly leaves stopping unproven.
Ambiguous managed outcomes retain protection even when an HTTP/MCP response
arrived. Classify effects and stopping separately from structured contracts,
not message text. No new remote completion-query protocol is required. Persist
protection together with terminal cleanup, or conservatively restore it from
durable unfinished-call records; a crash must not open the same binding.

Stopping evidence is limited to never-dispatched calls or an existing contract's
explicit foreground-completion guarantee after local dispatch has ended.
Cancellation acknowledgements, disconnects, ambiguous managed outcomes and
unproven containment do not meet that guarantee. Intentionally retained
background processes are not an instruction to clean up every container process.

A replacement binding may clear old protection only when Controller's existing
replacement flow has confirmed isolation of the old environment. A health
observation, changed endpoint or changed execution ID alone is not sufficient.
This is a publication precondition verified by lifecycle tests, not a new proof
ticket, Runtime RPC or per-Run Controller state.

The ACP execution application owns accepted-but-not-started requests and their
cleanup. Protocol response failure cannot orphan an accepted request, and a
late transport callback cannot create a replacement execution slot after settle.

Runtime creation completion remains independent from readiness observation and
ACP configuration application. Configuration ACK must not be made a condition
for completing an already-created Runtime target operation.

Run execution has a separate ACP-owned `deadline_at`, fixed at local acceptance
using the service execution timeout (initial default: 30 minutes). It replaces
the old admission deadline without recreating Controller approval. Snapshot
replay, reconnect and retries do not extend it. Approval commits recheck actual
time after acquiring database locks. Expiration triggers local cancellation
and truthful terminal cleanup, not a guarantee that a remote command stopped.
It is not the lifecycle operation's settlement deadline and is not an input
to Controller-owned Run management.

## Read-only Workspace Execution State

The existing workspace state functionality moves from Controller to ACP.
`get-agent-execution-state` returns the current view; `watch-agent-execution-state`
streams current-view changes. They are internal read-only routes under
`/rpc/agent-acp`, not custom ACP protocol methods or admission APIs. The exact
query/stream envelopes must be frozen and tested in B0 before consumer wiring.

The frozen request is `POST` with an empty JSON object and the trusted identity
headers above. An Agent cannot be selected or an identity overridden in the
body. `get-agent-execution-state` returns one JSON state;
`watch-agent-execution-state` returns `text/event-stream` with `workspace_state`
events. Each event is the complete current view, without replay IDs or a journal.
After headers are sent, an unavailable state source emits a non-secret
`workspace_error` envelope and closes; before streaming, it returns HTTP 503.
No stream contents are recorded in telemetry. Reconnect starts a new snapshot.
State writes and terminal flushes are bounded by the service's configurable
delivery timeout. A blocked client is disconnected; terminal frames are best
effort, not a condition for revocation. Idle subscriptions do not expire on this
delivery timeout. The sender does not retry frames or maintain a replay journal.

The state contains `agent_id`, `access_allowed`, `availability`
(`ready`, `busy`, `offline`), nullable `active_session_id`, nullable
`configuration_revision`, and nullable `unavailable_reason` (`access_denied`,
`agent_unavailable`, `runtime_barrier_required`). Busy includes accepted work
that has not started. It remains busy when new execution is disabled; the owner
may still locate and cancel its active Session. Other permitted principals see
busy but no Session identifier. Ready is Agent-level availability, not a promise
that an individual Session's selected model remains valid.

Missing/revoked access returns only a sanitized offline state: no active Session
or configuration revision. This does not reveal whether the Agent exists.
A live subscription attempts this final state and closes on revocation, even if
access is immediately regranted. Cold configuration, storage failure and service
stop are errors, never fabricated ready/idle states. Reads and streams recheck
access before handing state to the synchronous transport enqueue operation.

`configuration_revision` is an opaque digest of non-secret Agent settings,
Runtime binding and the organization model catalog. It excludes busy state,
permission membership, lifecycle operation/status, organization revision and
credential revisions. It is a comparison token, not an increasing sequence or
execution permission. It survives identical publication and process restart;
unrelated Agent changes and credential rotation do not reset Session settings.
Catalog changes remain relevant because Sessions may select any organization
model. Gateway/Agent UI migrate the old numeric `agent_revision` consumer in
B3/B4U; no Controller execution-state fallback is retained.

Gateway authenticates and forwards the trusted organization/principal/Agent
tuple. The view derives locally from current access/configuration and Agent
execution ownership; it exposes the active Session only to its authorized
owner. Controller retains Agent names and management metadata, but no longer
JOINs Run admissions or aggregates execution state. ACP does not need a second
state table or a new queue for this projection.

Configuration-change identity is separate from busy/idle changes and unrelated
Agents' snapshot revisions. The existing workspace consumer must not reset its
configuration on every Run transition. Reading failure or unsynchronized
configuration must not become a false idle/ready state. Revocation clears
Session disclosure and invalidates the old subscription. Reconnect reads the
current view rather than requiring replay of every intermediate change.

Contract regression covers a Run on connection A, locating and cancelling it
from reconnected connection B of the same principal, terminal idle restoration,
and cross-principal/organization rejection. Preserve the existing UI contract
where possible; any required consumer adjustment is a bounded Agent UI batch,
not grounds to retain Controller Run state or skip this behavior.

The Controller Agent list and Gateway workspace bootstrap contain authorized
management metadata, not `AgentAccessSubject` or Controller-derived execution
availability. Controller revision 29 / Gateway revision 12 include lifecycle,
activation and Runtime state for the chooser. These are deployment observations,
not ACP admission. Before ACP state arrives, execution remains unknown/connecting;
management state cannot unlock input. Gateway does not fan out per-Agent ACP
queries for bootstrap. First load and reconnect parse these management facts
independently of the selected Agent's execution observation.

## Read-only Execution Audit

The minimum internal JSON-over-HTTP POST queries under `/rpc/agent-acp` are
`list-execution-audits`, `get-execution-audit`, and `list-execution-events`.
They query existing Run/Session/event data; list responses use ACP-owned cursors.
Verified administrative organization/actor/role context comes from Gateway and
the trusted BFF, never self-asserted query parameters. Queries do not activate
Sessions, impersonate owners, dispatch tools, or modify execution results.
Historical organization ownership survives removal of the live Agent projection.
Controller lifecycle/configuration events keep their separate APIs and cursors.
Physical audit purge is deferred, not implied by these read-only contracts.

The shared schemas beside this document define the three requests and their
results. Lists default to 50 items, maximum 100; creation filters use UTC,
up to microsecond precision, and `[created_from, created_until)` semantics.
Runs sort descending by `(created_at, run_id)`. Event queries select either
`stream: "execution"` (default, Session sequence ascending) or
`stream: "permissions"` (creation/tool-call ID ascending). These are independent
pagination streams, not a combined event journal. Cursors bind to organization,
query filters, Run and stream as applicable; every page is separately authorized.

The trusted management headers are `X-Antnest-User-ID`,
`X-Antnest-Organization-ID`, `X-Antnest-Membership-ID`, `X-Antnest-System-Role`
and `X-Antnest-Organization-Role`. The caller must be a current system or
organization administrator and is restricted to the selected verified
organization. Missing/malformed context is 401, an ordinary user is 403;
unknown and out-of-scope Runs both return 404. The body cannot select identity.
These are management queries, not owner Session API replacements.

`runs.input_prompt` retains the original trigger even when a persisted Run is
rejected or cancelled before acceptance. Such input does not become conversation
context. Detail includes the non-secret execution snapshot, terminal facts and
per-model-request usage measurements, never cumulative Session cost as Run cost.
Execution payloads and permission requests are decoded from their existing
storage representations. No Provider credential lookup or current Agent
configuration is needed for these historical reads.

## Errors And Persistence

Internal errors use `{code, message, retryable}`. Validation is HTTP 400,
configuration/operation conflicts HTTP 409, and storage/service unavailability
HTTP 503. ACP external transports map local execution/access errors through
the official SDK rather than forwarding the internal HTTP envelope.

Secret-exclusion acceptance enables production RPC payload capture and uses
synthetic credential markers on success, validation rejection and dependency
failure. Controller/ACP logs, traces, ACP persisted data and Temporal history
must contain none of those markers. A non-secret RPC is the positive capture
control; testing only with capture disabled is insufficient.

ACP stores only the non-secret snapshot and its persisted revision. That stored
revision is not proof of live publication in the current process. Provider
credentials are volatile; restart keeps execution closed until startup cleanup
and the current snapshot application are complete. Session creation persists immutable `organization_id`, inherited by
fork. Run and audit ownership derives from Session even after Agent removal.

Default model and explicit Session selection resolve against the same current
catalog. Run acceptance fixes the selected model parameters, Provider binding,
and Runtime configuration, not its authentication. Session authorization can
override defaults but not organization, Agent, Session, or model ownership.

## Delivery Status

ACP configuration ingress and normal local execution are wired in the worktree.
The Controller producer, lifecycle collaboration, Gateway header migration,
read-only management consumers and Docker integration are pending. Contract and
single-service PostgreSQL tests do not establish cross-service readiness.
Existing Controller Run APIs are removed when their consumers switch; they are
not supported as a long-term alternative.

The foundation schema accepts paired authentication updates for disabled
connections; the local client implementation can update existing holders.
Stopping evidence, its scoped persistent query, prompt protection and the
Agent-settlement HTTP route are wired in B1. Their shared request/result schemas
and local tests are not Controller lifecycle or deployment acceptance.
Workspace state get/watch routes are also wired locally; Gateway and UI state
consumers still require their own migration batches.
Administrative audit routes and request/response schemas are locally wired,
including production startup/restart tests against private PostgreSQL. Actual
Gateway/Console identity forwarding and retained-history presentation are still
B3/B4/B5 work, not established by the service-local tests.
