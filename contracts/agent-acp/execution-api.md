# ACP Execution Configuration RPC

This document defines the internal Agent ACP Service RPC routes that Agent
Controller uses to publish execution configuration and settle Agents, that
Agent UI uses to read workspace execution state, and that Admin Console uses to
read execution audit history. This is an internal control API, not an ACP
extension. External ACP versions and payloads are unchanged.

The sealed warm-admission requirements below define the #50 shared contract.
ACP implements persistence and startup restoration in its owning-service batch;
cross-service restart and admission acceptance remains a separate integration
batch. This amendment adds no RPC or snapshot wire fields.

## Transport And Identity

The internal base path is `/rpc/agent-acp`. Requests and responses use JSON over
HTTP. The [ACP authentication contract](service-authentication.md) and
[platform profile](../platform/service-authentication.md) define mandatory
workload authentication, exact route allowlists and Identity-signed CCTs.
`ANTNEST_ACP_CONTROL_LISTEN` (default `:8081`) serves only Controller publication,
settlement and minimal health. The workspace listener `ANTNEST_ACP_LISTEN`
(default `:8080`) returns 404 for publication and settlement regardless of
credentials, method or query; Gateway must not expose either operation.
Missing/invalid Controller workload returns 401 `service_unauthenticated`,
with the token challenge; a verified wrong service returns 403
`caller_not_allowed`. There is no per-Run credential lookup or legacy control
token. State get/watch remain on the workspace listener for Agent UI.

Workspace identity is derived from verified CCT `org`, `sub` and `agt`; HTTP,
WebSocket and Session ownership are bound to that tuple. Raw `X-Antnest-*`
fields never select authority. Opaque identifiers preserve punctuation and
Unicode without trimming or case normalization. Domain JSON retains its own
schemas; the signed carrier avoids encoding those identities as individual
HTTP fields. Runtime MCP still rejects an execution ID that its fence header
cannot carry unchanged before dispatch. A storage representation failure does
not publish or acknowledge a new snapshot.

Private ACP HTTP transport retirement uses that same immutable tuple. A valid
DELETE acknowledges completed SDK transport cleanup, including a bounded record
when the server closed first; it does not alter execution configuration, Session
history or Run state. Its authentication, failure and capacity rules are defined
in [private HTTP transport retirement](service-authentication.md#private-http-transport-retirement).

## Apply Execution Snapshot

`POST /rpc/agent-acp/apply-execution-snapshot`

This control entry accepts one `application/json` field with only optional
UTF-8 charset. The body limit is
independent from ACP prompt size, initially 16 MiB and configurable by ACP.
Unsupported control methods have no caller grant and are rejected at admission;
oversized bodies return 413 and unsupported media or content encoding 415.
Strict UTF-8, duplicate members, extra documents and case aliases return 400
before effects; rejected requests cannot publish a partial snapshot.

The body is one complete organization snapshot. A monotonically increasing,
JavaScript-safe integer `revision` orders all changes to that organization's
execution configuration. It is not a credential version or Runtime generation.
Controller reads the complete snapshot in one consistent database view and
increments its revision atomically with changes affecting this projection.

The snapshot contains `organization_id`, `revision`, `providers`, `models`, and
`agents`. IDs are unique within each collection in the organization. Model and
Agent references must resolve within the snapshot. An empty snapshot revokes
current access and new execution; it does not purge history.

The optional organization-level `organization_budget` contains a policy
`revision`, `unknown_cost`, `run_caps`, and separate `daily`/`monthly` soft and
hard microdollar caps. Each Agent may include `run_budget` with input/output
token and microdollar limits. All limits are nonnegative safe integers; omitted
limits and explicit zero are distinct. See the
[shared policy contract](../agent-controller/model-call-policy.md) for field
shapes, ownership and the remaining enforcement/consumer acceptance.

- Provider: `connection_id`, `provider_key`, `request_protocol`, `base_url`,
  `enabled`, and `credential_revision` plus typed `credential` when enabled.
  Supported provider keys are `deepseek` and `openrouter`; both use
  `openai_chat_completions` and `api_key`. The credential contains `method` and
  `secret`. The schema also permits the pair on a disabled Provider, but that
  material does not keep its holders usable: applying disable revokes existing
  clients and aborts their requests. Re-enable creates fresh clients, never
  revives revoked handles. Secrets may be retained only in ACP's sealed private
  configuration for warm admission; they are never stored in Runs.
- Model: `model_profile_id`, `connection_id`, `display_name`, `enabled`, model API
  ID, token limits, content capabilities, optional temperature and USD pricing.
  Optional boolean `supports_tools` declares Tool capability for runtime fallback;
  omission is unknown and does not change existing primary-model behavior.
  The model has no separate historical revision and carries no credentials.
- Agent: `agent_id`, allowed `principal_ids`, `access_revision`, `accepting_runs`,
  nullable `unavailable_reason`, nullable lifecycle `operation_id`,
  `default_model_profile_id`, optional ordered `fallback_model_profile_ids`
  (at most 31), optional `model_retry: {max, base_ms, cap_ms}` and
  `failover: "never" | "before_output"`, default authorization, Agent execution settings,
  nullable `agent_spec_revision`, `execution_revision`, and `runtime` binding.
  An accepting Agent requires a current Runtime and execution revisions. A
  disabled/not-yet-built Agent can carry a null binding and revisions.
- Runtime identity is the pair `runtime_revision` and `runtime_execution_id`;
  `mcp_endpoint` is the address, not identity. Publishing the same binding does
  not prove that uncertain commands stopped. Platform replacement confirms
  removal of the old binding before the new one is published as executable.

Omitted retry/failover fields preserve zero retries and no runtime failover;
they do not activate delivery defaults. Controller has not yet materialized and
published the planned defaults of two retries and `before_output` for existing
or newly created Agents. The [model-call policy contract](../agent-controller/model-call-policy.md)
retains the full delivery requirements. ACP's explicit-policy implementation
does not establish final fallback delivery: Controller defaults, spending
ledgers/caps, Console controls and final Docker integration
acceptance remain pending under #52.

At Run admission, ACP resolves the effective primary using the current Session
override and existing model-availability rules, then freezes the ordered
fallback candidates from that same publication. The plan contains complete
parameters, media/Tool capabilities, exact thinking effort, prices and Provider
identities, never credentials. `before_output` can advance only after the
current candidate's retry allowance is exhausted before output; `never` disables
that runtime switch without removing selection-time handling of an unavailable
default. Runtime candidates must accept the original input, Tools, thinking and
context; ACP skips incapable candidates instead of changing the input. The
existing context estimate is not a hard token or monetary budget guarantee.
Each attempt consumes the same Run model-request counter and original deadline.

The [instance connection profile](../runtime/instance-connection.md) refines the
private Runtime handoff for #30. Each accepting Agent's `runtime` additionally
requires `connection_id` and `credential: {caller: "agent-acp-service", token}`.
Controller obtains it only from RC's authenticated private resolver, compares
Agent/revision/execution/endpoint against the persisted binding, and relays it
on this dedicated control route. The token uses the canonical platform file
profile; it is neither a public reference nor a Run snapshot field.

A closed Agent's `runtime` has no `credential`. It may retain the old
revision/execution/endpoint and an already-known connection ID as fence-only
metadata, or be null for unbuilt/removed compute. Controller does not call the
resolver for closed Agents; a Runtime outage cannot block revocation, Drain or
settlement. Closure grants no new connection and does not clear old protection.
Already accepted operations retain only their original authority under the
existing stopping and settlement rules. A closed public snapshot cannot
reconstruct credentials or authorize new execution after ACP restart. Re-opening
requires fresh authenticated resolution and publication; warm admission cannot
fall back to an older executable snapshot through closure.

ACP removes Runtime credentials before public persistence, audit and Run
construction. Its separate sealed private configuration may retain current
authority under the warm-admission rules below. It installs only the trusted
instance's volatile sender file and rejects different token bytes for an
existing connection identity. Schema conformance is shared through
[runtime-publication-fixtures.json](runtime-publication-fixtures.json).
Controller and ACP adopt this contract in separate owning-service batches;
freezing it does not claim that the consumers or cross-service workflow are complete.

ACP rejects malformed, unsupported, duplicate, or dangling configuration as a
whole. It must never interpret validation or transport failure as an empty
snapshot. Provider absence stops new acquisition for that connection; model
absence removes that model from new selections, not other models sharing its
connection. Existing client references are revoked immediately, not drained. Agent absence denies ordinary access, while
historical organization ownership remains in Sessions.

The successful result contains `organization_id` and `applied_revision`. It
means local public and sealed private persistence and live publication completed.
Revocation also invalidates pending approvals/output subscriptions at the local
authority boundary. It does not mean every previously started execution has
finished or that startup interruption cleanup has finished. Execution requires
both local startup cleanup/protection restoration and successful restoration or
application of the current configuration.
Transport availability is separate: an authenticated protocol connection can
receive configuration-unavailable errors without a blanket handshake 503.

Prompt preparation checks the current published access before preempting Skill
learning or cleaning temporary Skills. Durable Run acceptance still performs
its own ordered authorization; the preparation check cannot grant later access.
When revocation overlaps lifecycle cancellation during preparation, the request
retains `access_denied`, including when access is subsequently restored. The
original cancellation signal and cleanup join are preserved. This classification
does not replace unrelated preparation failures, shutdown reasons, or failures
after durable acceptance has begun.

Older snapshots return the actual newer live-applied revision without overwriting
state. A stored revision alone cannot authorize this response after restart;
stale input then fails until the current configuration is successfully restored
or applied. Equal revisions must describe identical public configurations. When
sealed private material already exists, equal-revision publication also checks
that its private credential identities and bytes are unchanged; it cannot
replace them. Neither restoration nor replay clears execution protection.
Credential changes require a changed credential/configuration revision.
Secret-bearing RPC payloads are not logged or traced. Lifecycle
activities build and send these payloads internally; Workflow/Activity inputs,
results and Temporal history carry only identifiers and non-secret acknowledgements.

Validation/preparation/storage failure does not publish the next configuration.
Failure during publication after storage closes the affected organization's
entry and returns no success ACK; equal or newer input retries publication.
Startup may instead restore that same latest committed configuration under the
warm-admission rules. It must not restore an older configuration because the
newer publication failed or its acknowledgement was lost.
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
with an old Run's fixed endpoint. Provider/model retirement means
disable, not physical deletion; historical records and references survive.
ACP retains a primary availability/cancellation guard while preparing Runtime
context, then obtains a fresh Provider handle for each model attempt. Credential
injection must match the request's organization, connection ID and frozen base
URL to the handle binding. The Run monitors the current foreground Provider
through Tool work; selecting foreground B replaces A's monitor. A permission
judge protects its own in-flight call without replacing the foreground watch. Revoking inactive A cannot
cancel B, while current B's revocation still stops further work and joins its
original tasks. Released attempt handles and current-Provider monitoring have
distinct lifetimes; final Run cleanup removes the remaining monitor.

## Execution Publication V2 (#43, pending)

This section defines the shared v2 wire contract in
[execution-publication-v2.schema.json](execution-publication-v2.schema.json).
ACP and Controller implement it in separate owning-service batches, followed by
a cross-service integration batch; freezing the contract changes neither the
current publisher nor the pending consumers. The legacy
[execution-snapshot.schema.json](execution-snapshot.schema.json) and its
producer remain the unchanged N-1 v1 contract.

### Versioned snapshot

`POST /rpc/agent-acp/apply-execution-snapshot` continues to carry one complete
organization snapshot under the existing admission, size and error rules. A
body without `schema_version` is version 1 (the legacy shape); `schema_version:
2` selects the v2 snapshot. The v2 snapshot keeps the v1 `providers`, `models`,
`agents` and `organization_budget` collections and their document shapes, with
one change: a Provider `credential` is the closed reference `{ref, version}`
instead of decrypted `{method, secret}` material, and the wire carries no
plaintext Provider key. A semantic rule enforced by both services, not the
schema, requires `ref` to equal the Provider's `connection_id` and `version` to
equal its `credential_revision`. Enabled Providers require
`credential_revision` and `credential`; disabled Providers may retain or omit
the pair, and retaining it grants no usability. Model, Agent, Runtime and
budget shapes are unchanged: only Provider secret material leaves the wire,
and accepting-Agent Runtime `credential` relay is exactly as above.

### Apply Execution Delta

`POST /rpc/agent-acp/apply-execution-delta`

The body has exactly `schema_version: 2`, `organization_id`, `base_revision`,
`revision`, per-collection `{upserts, deletes}` for `providers`, `models` and
`agents`, and `organization_budget` (a budget object or `null`). Revisions are
JavaScript-safe integers; `base_revision` is at least 1 and `revision` must be
greater than `base_revision` (the schema therefore admits only `revision` ≥ 2;
equality and ordering beyond that are service checks). ACP reconstructs the
complete v2 authority atomically: unchanged documents are retained, deletes
remove their IDs, upserts replace same-ID documents, and `null` budget removes
the policy. Duplicate IDs within or across `upserts` and `deletes` are
rejected, and all final references are validated against the reconstructed
authority before it is persisted, under the same checks a full snapshot faces.

`base_revision` must equal the organization's current revision. A mismatch
returns 409 `configuration_base_mismatch`, and that result alone permits
Controller to fall back to a full v2 snapshot; the same base is never retried
and a delta failure never downgrades to a v1 plaintext snapshot. Other
failures follow the existing error rules and publish no partial state. The
per-request payload cap is unchanged; an organization whose recovery payload
exceeds the limit hits that explicit bound rather than unbounded capacity.

### Get Execution Digest

`POST /rpc/agent-acp/get-execution-digest`

The request has exactly `organization_id`. The response has exactly
`organization_id`, `schema_version` (0 absent, 1 legacy snapshot, 2 v2),
`revision`, `digest`, `{id, digest}` arrays for `providers`, `models` and
`agents`, and `organization_budget_digest`. An absent organization returns
`schema_version: 0`, `revision: 0`, null digests and empty arrays; a storage
error fails the request and is never reported as absence.

Digests cover the public projection only: Provider `credential` references
and secrets and Runtime `credential.token` are removed, and all other fields
are preserved. Each document digest is SHA-256 over the UTF-8 JSON whose
object keys are lexicographically sorted, arrays keep their order, string
escaping follows `JSON.stringify` except that U+2028 and U+2029 are escaped,
and no HTML escaping is applied. Collection digest entries are sorted by
`id`. The root `digest` hashes the object `{organization_id, schema_version,
revision, providers, models, agents, organization_budget_digest}` under the
same encoding. Digests are an optimization: revision compare-and-set and the
existing authority checks still enforce correctness, and a hash encoding
difference can only cause a safe extra full snapshot or upsert, never a lost
change. Digest reads include the current restored or published authority and
rerun the existing owner and acknowledgement barrier on a revision match; a
stored revision alone cannot shortcut readiness.

### Resolve Execution Credential

`POST /internal/execution-credentials/resolve`

Controller serves this route only to the authenticated `agent-acp-service`
workload, without a user CCT. The request has exactly `organization_id`,
`connection_id` and `credential_version`; the response is the same identity
plus `method: "api_key"` and a non-empty `secret`, defined in
[execution-credentials.schema.json](../agent-controller/execution-credentials.schema.json).
Controller binds the exact current organization, enabled connection and
credential version before decrypting. A missing or disabled connection or a
wrong version returns 409 `configuration_conflict` or 404 `not_found`,
invalid input 400, and a dependency failure 503. There is no
historical-secret fallback and no query parameters; responses carry
`Cache-Control: no-store`, instrumentation is metadata-only, and neither
request nor response secrets are logged or traced.

ACP resolves at model dispatch, never during apply or startup restore, holds
the result in a bounded in-memory cache with a 60 second TTL, and invalidates
it on credential version change, connection disable or removal. Cancellation
and version checks still run after the asynchronous resolve completes, and
there is no stale-entry fallback. Secrets never enter snapshot or Provider
persistence, audit or traces. The sealed Runtime authority above is unchanged.

### V2 rollout

All publication routes remain on the authenticated `agent-controller` control
listener only, with no user CCT. N-1 reads of v1 stay supported while ACP has
not been upgraded. Controller enables the v2 producer only after the ACP
upgrade, behind an explicit Controller wire-version setting that defaults to
1 until the deployment is updated; a v2 publisher never silently falls back
to v1. For the final v2 deployment the existing 30 second full
resynchronization becomes a 5 minute digest check that exchanges only digests
for unchanged organizations, while mutations and retries still wake
immediately. A full v2 snapshot fallback remains available for missing
authority or base mismatch.

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

The same guarantees apply when protected inventory prevented an application
graph from being initialized. ACP must join its original local handles and
validate the relevant predecessor stopping facts under current ownership;
missing components, terminal labels and a barrier by themselves prove neither.
Settlement checks all relevant original Runtime bindings in the scope, including
an install binding different from the current configuration. A revision filter
must not hide outstanding protection. Recheck the closed operation and Runtime
binding after waiting; timeout never supplies a missing stop proof.

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
`/rpc/agent-acp`, not custom ACP protocol methods or admission APIs.

The request is `POST` with an empty JSON object, verified Agent UI workload
and an Agent-scoped signed CCT. An Agent cannot be selected or an identity overridden in the
body. `get-agent-execution-state` returns one JSON state;
`watch-agent-execution-state` returns `text/event-stream` with `workspace_state`
events. Each event is the complete current view, without replay IDs or a journal.
After headers are sent, an unavailable state source emits a non-secret
`workspace_error` envelope and closes; before streaming, it returns HTTP 503.
No stream contents are recorded in telemetry. Reconnect starts a new snapshot.
The separate ACP v1 HTTP GET transport can record an original access-denial
failure on its existing SERVER when that failure actually closes its connection;
see the [HTTP close evidence contract](../../docs/observability-contract.md#acp-http-access-revocation-closure).
When the exact normal `RunSupervisor.shutdown()` reason reaches the watch RPC
boundary, its existing SERVER records the fixed
`antnest.stream.termination=process-shutdown` alongside the original ERROR.
An earlier failure, a matching message or wrapped cause is not normal shutdown;
get-state reads do not receive this marker. The non-secret error envelope and
stream lifetime remain unchanged. See the
[shared diagnostic contract](../../docs/observability-contract.md#acp-workspace-stream-shutdown).
State writes and terminal flushes are bounded by the service's configurable
delivery timeout. A blocked client is disconnected; terminal frames are best
effort, not a condition for revocation. Idle subscriptions do not expire on this
delivery timeout. The sender does not retry frames or maintain a replay journal.

The state contains `agent_id`, `access_allowed`, `availability`
(`ready`, `busy`, `offline`), nullable `active_session_id`, nullable
`configuration_revision`, and nullable `unavailable_reason` (`access_denied`,
`agent_unavailable`, `agent_preparing`, `runtime_barrier_required`). Busy includes accepted work
that has not started. It remains busy when new execution is disabled; the owner
may still locate and cancel its active Session. Other permitted principals see
busy but no Session identifier. Ready is Agent-level availability, not a promise
that an individual Session's selected model remains valid.

A listed, authorized Agent whose snapshot explicitly carries
`accepting_runs: false` and `unavailable_reason: "agent_preparing"` reports
offline/preparing with no active Session. Its new-execution admission returns
the existing catalog `agent_preparing` error, including the 1000 ms retry hint.
Unlisted or unauthorized Agents remain denied, and absent organization
configuration remains `configuration_not_ready`. Existing busy work takes
precedence over preparing, retaining the current owner/peer Session visibility
rules. These wire definitions do not prove the Controller ACK transaction or
enable automatic replay; owning-service and integration gates are specified in
the [readiness contract](../agent-controller/readiness.md).

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
model. Agent UI consumes `configuration_revision` rather than the old
numeric `agent_revision`; no Controller execution-state fallback is retained.

Agent UI forwards the unchanged Identity-signed CCT with its own workload credential. ACP derives the
organization/principal/Agent tuple from its verified claims. The view derives locally from current access/configuration and Agent
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
where possible; a consumer adjustment in Agent UI is not grounds to retain
Controller Run state or skip this behavior.

The Controller Agent list and Agent UI workspace bootstrap contain authorized
management metadata, not `AgentAccessSubject` or Controller-derived execution
availability. They include lifecycle, activation and Runtime state for the
chooser. These are deployment observations,
not ACP admission. Before ACP state arrives, execution remains unknown/connecting;
management state cannot unlock input. Agent UI does not fan out per-Agent ACP
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

Audit routes require verified Console workload and exactly one unchanged CCT
with ACP audience and organization scope. Subject, membership and roles come
only from signed claims. The caller must be a system or organization
administrator and is restricted to the signed organization under the bounded
offline grant. Missing/malformed context is 401, an ordinary user is 403;
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

Secret-exclusion testing enables production RPC payload capture and uses
synthetic credential markers on success, validation rejection and dependency
failure. Controller/ACP logs, traces, ACP persisted data and Temporal history
must contain none of those markers. A non-secret RPC is the positive capture
control; testing only with capture disabled is insufficient.

ACP stores the public snapshot and its revision separately from the sealed
private material described below. A stored revision alone is not proof of live
publication in the current process. Session creation persists immutable
`organization_id`, inherited by fork. Run and audit ownership derives from
Session even after Agent removal.

Default model and explicit Session selection resolve against the same current
catalog. Run acceptance fixes the selected model parameters, Provider binding,
and Runtime configuration, plus any explicit ordered fallback plan and its
capabilities/prices from the same publication, not authentication. Session authorization can
override defaults but not organization, Agent, Session, or model ownership.

### Sealed warm admission

ACP must be able to admit a new Run for an already known organization after
restart, before any new Controller publication, once startup recovery and
restoration of that organization's current authority have completed. This uses
ACP-owned durable state, not Controller startup resynchronization or a public
Run snapshot as a substitute for private authority.

The public snapshot and the private material needed to reconstruct the same
validated configuration must commit together in one database transaction under
the same organization revision compare-and-set. Private material includes
Provider authentication and its credential revision, and accepting Agents'
ACP-only Runtime credentials bound to their original Agent, Runtime revision,
execution ID, endpoint and connection ID. The public projection remains free of
credentials. Closed Agents carry no Runtime credential; empty or closed current
configuration never permits new execution. Retaining a disabled Provider's
material does not make its clients usable. Every new admission still requires
the exact current organization, Agent and Principal grant; revoked or absent
access cannot be reconstructed from private credential possession.

Private material is sealed with AES-256-GCM using a stable operator-provided
ACP bootstrap key (`ANTNEST_ACP_CLIENT_MCP_KEY`) and a fresh random nonce for
each seal. The existing key is reused with a distinct authenticated purpose;
it is not copied into configuration records. Authentication binds
the purpose, format version, organization and configuration revision using the
unambiguous UTF-8 JSON tuple
`["agent-acp-service/execution-authority", 1, organization_id, revision]`
as associated data. ACP owns the storage layout and retains the authenticated
envelope metadata with the ciphertext. The key remains outside the database
and must survive process restart. This contract does not introduce a key ring
or automatic key rotation.

After decryption, ACP must parse and validate the complete private configuration
and require its derived public projection to equal the stored public snapshot.
Missing Provider or Runtime authority, malformed or missing ciphertext, a wrong
key, an authentication failure or a projection mismatch leaves the affected
organization closed. Public metadata, an older record, another organization's
material or an alternative key must not be tried as an authority fallback.
Failure responses, logs and traces use safe identities, never decrypted
payloads, credential values or arbitrary cryptographic/parser error contents.

The recovery source is the latest committed revision, including one whose
original acknowledgement was lost or whose live publication failed after
commit. A failed write acknowledgement does not prove rollback. Restoration
must recheck current storage before publication and must not overwrite or
revive access older than a newer committed configuration or revocation.
Already sealed equal-revision material must retain its private identity, just
as the public projection must remain identical. Provider authentication cannot
change under the same credential revision, and an existing Runtime connection
identity cannot acquire different token bytes.

Restoration runs under ACP's existing worker ownership and finishes before
opening its listeners. It reuses the normal authorization and publication
boundary, validates all required Provider and Runtime material, and prepares
new process-owned Runtime sender directories and files with modes 0700 and 0600. Only complete successful restoration makes an organization usable.
Ownership loss or restoration failure cannot publish late authority or admit a
Run; ACP must close partial clients and remove partial sender files. An
organization-specific invalid record leaves that organization closed without
revoking other successfully restored organizations. A failed global database,
worker-ownership or startup-recovery barrier still prevents service readiness.
Sender
files remain volatile, are checked for every request and are removed on owned
shutdown. Restoring credentials neither replays interrupted model/Tool work nor
clears the existing startup, stopping or unknown-effect protections.

Historical public-only rows contain no recoverable secret. They must be filled
through authenticated publication on the existing control route before their
first warm restart. An equal-revision fill requires the identical public
projection and fully validated private material; it does not permit replacing
an existing sealed identity. Without that fill, restart remains closed for the
organization. A database migration must not manufacture credentials or count a
post-restart Controller resynchronization as successful warm admission.

Warm admission observes the latest configuration committed to ACP. It cannot
detect a Controller-side revocation that has not been published to ACP. Once a
newer publication commits, its authorization and closure take precedence over
all older material. This allowance applies only to ACP's sealed current
configuration; Controller still does not persist relayed Runtime tokens, and
secrets remain excluded from Run snapshots, public audit, logs, traces and
Temporal history.

## Rollout

Controller publishes execution configuration through this API, and Agent UI and
Admin Console consume the state and audit routes directly. The former
Controller Run APIs are removed; they are not supported as an alternative.
Contract and single-service PostgreSQL tests do not by themselves establish
cross-service readiness; the root integration and Docker E2E suites cover the
combined path.

The ACP producer implements sealed storage, startup restoration and migration.
Owning-service acceptance does not establish the subsequent cross-service
restart/admission verification. Controller and UI recovery consumers and that
integration batch remain pending; this phase does not complete #50 or change
the existing Controller relay behavior.

## Runtime barrier recovery (#50, pending)

ACP implements the durable recovery fact and its control query. Controller
policy/recovery consumption, Agent UI consumption and cross-service integration
acceptance remain pending; the query alone does not enable automatic recovery.
Its enforced workload grant is recorded in [the caller catalog](callers.json).

The query is `POST /rpc/agent-acp/get-runtime-barrier` on the control
listener only. It requires the verified `agent-controller` workload, without a
user CCT. The [control admission rules](service-authentication.md#runtime-barrier-control-admission-50)
apply independently of workspace state authorization. Controller must not use
the user `get-agent-execution-state` or `watch-agent-execution-state` routes,
obtain a user CCT for this purpose, or read ACP database tables directly.

The [wire schema](runtime-barrier-recovery.schema.json) defines the request and
response. Each request selects one Agent and has exactly these members:

```json
{
  "organization_id": "org-1",
  "agent_id": "agent-1",
  "expected_runtime_revision": "runtime-1"
}
```

A successful response has exactly `organization_id`, `agent_id`,
`runtime_revision` and `barrier`. The first two preserve the requested scope;
`runtime_revision` is the matching current Runtime revision.

```json
{
  "organization_id": "org-1",
  "agent_id": "agent-1",
  "runtime_revision": "runtime-1",
  "barrier": {
    "barrier_id": "barrier-1",
    "reason": "runtime_barrier_required",
    "runtime_execution_id": "execution-1"
  }
}
```

`barrier` is either `null` or an object with exactly the three members shown;
its `reason` is the literal `runtime_barrier_required`. Every identifier in the
request or response is a string of 1–200 characters containing no whitespace.
Identifiers are not trimmed or normalized. Extra members are rejected. The
response contains no credentials, endpoints, Run or Tool content, or Run/Tool
identifiers. This query is a recovery fact, not an execution audit interface.

ACP must match the original organization, Agent and current Runtime revision.
Its configuration source must be initialized and available before it can decide
that a scope is absent.
An organization or Agent absent from the current configuration returns 404
`not_found`; a different Runtime revision returns 409
`configuration_conflict`. Cold/uninitialized configuration and storage errors
fail the query rather than fabricating `barrier: null`. Neither failure nor an
unavailable source may be treated as a successful absence of protection.

ACP publishes a non-null receipt only after the original local execution and
all possible future dispatch have stopped, while stopping the protected Runtime
foreground call or retiring its temporary scope remains unproven. This is
independent of the historical effect classification, which may already be
`none` or `settled`. An ordinary Tool call that is still running does not
create a recovery receipt. `null` means only that this read has no fact from
which recovery may be started; it does not prove ready, idle, settled, absence
of active work, or permission to dispatch.

`barrier_id` identifies a durable recovery cycle. Repeated reads, ACP restarts
and equal-revision publication preserve it. After that protection is genuinely
cleared, a later barrier cycle receives a different ID, including when the
Runtime revision is reused. An ID must not be manufactured from a boolean or
only from the Runtime revision. `runtime_execution_id` comes from the original
Run snapshot of the protected durable fact, never from the latest health
observation or current configuration's replacement execution ID.
A health change, changed endpoint/execution ID
or elapsed TTL cannot clear protection or prove that the old Runtime command
stopped. Existing lifecycle isolation must establish that the old environment
cannot execute before its replacement is published as executable. No Prompt
or Tool is replayed by this recovery contract.

The [Controller policy contract](../agent-controller/control-api.md#runtime-barrier-recovery-policy-50-pending)
defines the organization decision and durable deduplication. Delivery proceeds
in separate batches: ACP receipt/query producer; Controller policy and recovery;
Agent UI reason and authorized action; then real Docker integration that kills
ACP during a Tool call in both `auto` and `manual` modes. Integration must prove
old Runtime isolation, the appropriate automatic or explicit Rebuild, subsequent
new Run admission, persistence and actual resource cleanup. None is established
by this document. #50's per-Run persistence containment, warm admission,
configuration publication without a reader gap, and barrier recovery retain
their own acceptance requirements; this contract or completion of warm producer
PR #281 alone cannot close the issue.
