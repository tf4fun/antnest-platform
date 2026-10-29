# Execution Configuration Publication

This service owns Agent configuration, lifecycle intent, Provider connections
and credential material. ACP owns protocol authorization, Sessions, Runs,
Tools and execution audit. This document describes how Controller publishes
current execution configuration to ACP and requests lifecycle settlement. The
wire format is defined by the
[internal RPC contract](../../../contracts/agent-acp/execution-api.md).

## Components

The publication path consists of a typed current-configuration projection, an
outbound ACP client, a private PostgreSQL source, mutation hooks, commit hints
and a publication worker. The main process wires one shared publisher into the
worker and the lifecycle service. It follows these rules:

1. The projection uses organization-scoped source records, not Run/admission
   snapshots or public paginated catalog APIs. Current credentials are opened
   only for publication or local capacity measurement; the plaintext projection
   is never persisted.
2. A consistent private PostgreSQL source keeps one current synchronization row
   per organization. The revision advances in the same transaction as effective
   configuration changes. Acknowledgements are kept separate from the desired
   revision.
3. The shared publisher runs after commits and periodically resends the current
   snapshot. Equal revisions are not skipped, because an ACP restart loses
   volatile credentials. Network waits stay outside database transactions and
   publication is serialized per organization.
4. Lifecycle operations close execution, publish, and request settlement; Runtime
   binding and ACP-acknowledged readiness are published independently of lifecycle
   completion. Controller has no Run admissions and
   ACP makes no business RPCs back into Controller.

This is the only execution configuration path; there is no compatibility mode.

## Binding Facts And Applied Readiness

Healthy inspection publishes the complete current binding, its immutable
ExecutionRevision and v2 `runtime_bound` in one PostgreSQL transaction. That
transaction advances the organization execution-configuration revision and
freezes the resulting value as `ready_after_revision`. This is not the
Agent-local execution counter. The private proof also binds current access and
owner authorization to that exact Runtime execution; private evidence is not
included in the public event or Agent response.

`RecordExecutionApplied` validates the organization ACK against its committed
revision and rechecks the current binding, owner/access, lifecycle eligibility,
active operation and Runtime condition. Only an ACK covering the eligible
binding's threshold commits ready proof, Agent aggregate and v2 `agent_ready`
journal event together with the applied watermark.
Stale, duplicate or concurrent ACKs cannot make a different or blocked binding
ready or duplicate its ready event. An ordinary ACK does not increase the
desired configuration revision.

Get/List expose current `readiness` as `preparing`, `ready` or `unavailable`.
Current blockers override historical ready proof; legacy views without known
readiness evidence omit the optional field. Storage failures remain errors.
An authorized, otherwise eligible unbound Agent stays listed with closed
admission and `agent_preparing`. A complete executable binding instead publishes
`accepting_runs: true` while Controller is still preparing for its ACK. The ACK
does not rewrite that snapshot or require another revision just to open it.

Existing v1 `agent_ready` history is never rewritten or accepted as new ACK
proof. Startup/periodic equal-revision resends also reconcile eligible legacy
bindings that lack a threshold. An ACK of committed revision R atomically
records that ACK, bootstraps the missing v2 `runtime_bound` proof at R+1, and
leaves current readiness preparing. A subsequent publication and ACK covering
R+1 can emit v2 `agent_ready`. This legacy bootstrap is the explicit exception
to ordinary ACKs leaving the desired revision unchanged; an ACK cannot claim a
future revision to bypass it. The ACK and synchronization wire envelopes stay
unchanged. See the [readiness contract](../../../contracts/agent-controller/readiness.md).

The Controller producer/API and ACP preparing boundary are implemented in this
candidate. Agent UI and Admin Console consumers, and the real two-second
delayed-publication acceptance over 100 create/ready/Prompt iterations, remain
pending. Focused unit evidence is not a final PostgreSQL, integration or remote
merge result.

## Management Synchronization Read

`GET /internal/execution-synchronization?organization_id=...` exposes only the
existing organization revision and its persisted acknowledgement, through
`AgentConfigurationService` and its narrow storage Port. No source snapshot,
credential opener, publication worker, Identity or ACP client participates in
this read. The main process reuses its existing configuration-service wiring.

The response is `{organization_id, synchronization}`; `synchronization: null`
means no row, not synchronized. Otherwise it contains `revision`,
`applied_revision`, `updated_at`, and nullable `applied_at`. The read neither
creates the first row nor changes any timestamp/revision. Old acknowledgements
remain readable even when ACP is offline or after it restarts; clients must not
use this record to infer online status, Agent execution readiness or Run state.
Store failures are errors, never an empty or ready response. The common HTTP/RPC
and PostgreSQL instrumentation records the request and single SELECT without
custom application spans. See the [management contract](../../../contracts/agent-controller/control-api.md#execution-configuration-synchronization).

## Publication Application Boundary

`ExecutionPublisher.Publish` serializes publication within an organization,
including callers in separate Controller instances. After its cancellable local
gate, the repository acquires a PostgreSQL session advisory lock before reading
current source data. Ownership covers projection building, credential opening,
Runtime authority resolution, ACP delivery and acknowledgement persistence.
Source transactions and ordinary pool connections finish before credential
opening or HTTP calls; a dedicated connection holds the publication lock.
The result contains only the non-secret acknowledgement, never the snapshot.

Publication uses the `APUB` lock namespace, separate from the `AEXP` locks used
by short configuration mutations. Credential rotation and authorization changes
can therefore commit while an existing publication waits on ACP. The next
publisher rereads the newly committed state after acquiring ownership. Lock
acquisition is cancellable; release and connection cleanup have an independent
bounded context. A coordination or cleanup failure returns no successful
acknowledgement, including when ACP already applied the configuration.

Every explicit attempt rereads the current source, including an equal-revision
resend. There is no cached payload or acknowledged-revision shortcut. Another
organization need not wait for this organization's network request. Cancelled
waiters leave without reading or sending, and idle publication boundaries are
removed rather than retained as an unbounded task registry.

Only a successful, matching acknowledgement is persisted. Invalid source,
credential opening, transport or acknowledgement failures cannot record
success. If ACP applies a snapshot but the response or local acknowledgement
write is lost, the next attempt sends the latest current state. The publisher
does not retry internally or manufacture rollback of a remote application.
Post-commit, periodic and lifecycle callers share this same publisher instance.

### Private Runtime Authority

For each accepting Agent, the publisher calls RC's Controller-only
`POST /internal/runtimes/{agent_id}/connection` after closing the source
transaction. It checks the returned Agent, Runtime revision, execution ID and MCP
endpoint against that source binding, plus the exact connection ID and canonical
ACP credential profile. This happens on every publication, including an equal
revision and process restart. Missing or mismatched authority aborts the whole
publication before ACP receives it; no acknowledgement advances.

The private response is limited to 8192 bytes and strict UTF-8 JSON, requires
`Cache-Control: no-store`, and cannot redirect or use environment proxies.
Dependency errors preserve only known classifications and cancellation sentinels,
never remote messages or credentials. The existing HTTP instrumentation records
metadata, not the private response or relay body, even with debug capture enabled.
The publisher passes the credential only to the dedicated ACP control client.
Controller stores neither the credential nor a second instance-authority record.

Closed Agents carry only retained execution fences or a null Runtime, without
credentials. Drain, revocation, disable and deletion do not resolve that Agent's
authority and remain publishable when its Runtime is unavailable. A later reopen
requires fresh resolution. These rules follow the
[private instance contract](../../../contracts/runtime/instance-connection.md);
ACP private/public separation is a subsequent owning-service batch.

### Commit Hints And Resynchronization

The revision writer registers a transaction completion callback. Only a
confirmed commit emits a nonblocking local hint; rollback, replay and failed
commit emit none. The callback never decrypts, queries or calls ACP. A lost
commit reply therefore leaves synchronization to a later current-state scan,
without claiming that the management write succeeded.

One publication worker coalesces hints by organization and retains only their
trace context, never request contexts, credentials or snapshots. Startup and
periodic scans resend every organization's current configuration, even when
its persisted acknowledgement already matches. The scan deadline does not move
on hints, so busy management traffic cannot starve restart resynchronization.
Database enumeration and each publication have bounded, cancellable timeouts.
The worker processes one publication at a time, sharing the publisher with
explicit lifecycle synchronization. Failed cycles use bounded exponential
backoff; new hints cannot bypass it. One failed organization does not prevent
other organizations in the same cycle from being attempted.

### Background Publication Trace Contract

Each bounded organization attempt owns one INTERNAL span named
`agent_controller.execution_publication`, from before its current-state read
through the acknowledgement write. Commit-triggered attempts use the retained
commit span context as parent; retries get distinct attempt spans with that same
causal parent. Startup and periodic attempts start fresh roots, without retaining
an earlier management request or inheriting the worker's ambient span.

Only the organization ID and a successfully persisted `applied_revision` are
recorded. A failed attempt has ERROR status and the static classification
`execution_publication_failed`; raw dependency errors, snapshots and credentials
are never recorded. Cancellation and deadlines still bound the original work,
and every started attempt ends on success or failure. A pre-cancelled attempt
does no work and starts no span.

The recording attempt context lets existing PostgreSQL driver instrumentation
capture the source transaction and acknowledgement UPDATE beside the real ACP
HTTP CLIENT. There are no per-query application wrappers and no global enabling
of unparented database traces; periodic enumeration stays untraced. Lifecycle
publication keeps its Temporal activity context.

Commit-triggered outbound RPCs inherit the originating span context through
the shared transport instrumentation. Periodic repair has no fabricated user
parent. Logs contain only safe failure classification. These callbacks are
not a persistent queue: a crash loses hints and traces, not configuration.
No new table, listener connection or per-organization background task is used.

## Runtime Barrier Query Adapter

The ACP client implements `RuntimeBarrierReader.GetRuntimeBarrier` against the
[frozen recovery query](../../../contracts/agent-acp/execution-api.md#runtime-barrier-recovery-50-pending)
through the dedicated Controller control origin and its existing workload
transport. The request selects the original organization, Agent and expected
Runtime revision. It does not obtain or forward a user caller-context token.

The adapter makes one POST without retries or redirects. It retains the existing
request timeout, cancellation, one MiB response limit and actual response-body
close. Only a complete, strictly decoded result with exactly the requested scope
and Runtime revision is accepted. Missing `barrier`, duplicate decoded keys,
case aliases, extra fields, invalid UTF-8, unpaired surrogate escapes and extra
JSON documents fail the read. Valid surrogate pairs and literal replacement
characters remain unchanged; malformed escapes never collapse distinct IDs.
Identifiers preserve their original Unicode codepoints and use the frozen
1–200 character, ECMAScript non-whitespace rule; they are not normalized into
Controller identifier syntax. A barrier retains its original execution identity.

An explicit `barrier: null` is only absence of a recovery fact, not proof of
readiness, settlement or permission to dispatch. Dependency, configuration and
storage errors return no result. The error mapping preserves known HTTP/code
pairs and safe cancellation causes without returning remote messages, endpoint
addresses or credentials. A cancellation that arrives during response cleanup
cannot turn into a successful read after cleanup finishes.

Controller main runs the observation and pending-start workers with this
authenticated adapter. Automatic recovery has a real ACP mid-tool crash gate;
the UI consumer and real manual UI recovery remain separate acceptance work.

## Atomic Runtime Barrier Admission

Migration 0028 adds immutable recovery receipts, one cooldown per Agent and
pending workflow starts. Recovery supplies optional metadata to the existing
`BeginAgentRebuild` transaction. The original organization/Agent/barrier tuple
derives one stable Rebuild request ID; the command retains the existing six-field
Rebuild fingerprint. Opaque barrier and original execution IDs use `BYTEA` so
Unicode and NUL identities survive PostgreSQL and restart without normalization.

An existing tuple returns its original receipt before current policy, Template,
cooldown or lifecycle checks. A regular lifecycle operation without a matching
recovery receipt cannot be converted into a recovery. A new automatic admission
requires the observed policy revision in `auto` mode, the same configured Runtime/source
and Template revision, unchanged owner authorization and revocation watermarks,
and an active owner binding. It retains the existing lifecycle CAS and does not
require execution readiness or equate the barrier's original execution ID with
a later health observation. The absent policy defaults to `manual`; neither
`manual` nor `notify` admits automatic recovery.

Migration 0029 adds an explicit `manual` origin flag, defaulting existing
receipts to automatic. An internal manual intent retains the authenticated
administrator's actor and can use any valid current policy mode; it still
requires the exact policy revision and every source, lifecycle, authorization
watermark and cooldown check. The flag is never part of the public request or
the existing six-field lifecycle fingerprint. Receipt readers and Temporal
startup use the saved origin, actor and policy. Automatic receipts still require
the `agent-controller` actor and an accepted `auto` policy. Cross-origin replay
follows the original operation and never renews its cooldown.

The internal flag is not authorization. The existing administrator Rebuild HTTP
entry verifies workload/CCT scope before both admission and replay. Its optional
`recovery` object contains only the original `barrier_id` and
`expected_runtime_revision`; null, duplicate, unknown or invalid fields fail
without falling through to ordinary Rebuild. The request ID must derive from
the original organization/Agent/barrier tuple, and the requested Template must
match the configured target. The existing operation response remains HTTP 202.

`RuntimeBarrierManualRecoveryService` first replays a committed original tuple,
preserving its actor, fingerprint, policy and cooldown. On a fresh request it
reads the current Agent, the exact ACP barrier and policy, then uses shared
atomic admission. If a concurrent recovery commits after the first receipt
miss, a changed Runtime, target, lifecycle source or barrier triggers another
original-receipt read; replay still validates the requested original Runtime
and target. Cancellation prevents further reads or admission. Controller main
installs this service with the same authenticated ACP reader as observation;
the pending-start worker starts the persisted workflow command.

Real HTTP/PostgreSQL component tests cover all three policy modes, reopen and
replay, current authorization, binding/target conflicts and an active cooldown.
ACP facts and RC Skill preparation are controlled in those tests; they do not
prove manual Runtime recovery. The persistent observation and notification
boundary below supplies the Agent detail projection; UI consumers and real
manual UI acceptance remain pending.

Lock order is lifecycle request, policy organization, Identity admission,
execution organization, Agent, owner binding/cooldown and event journal. After
these locks, one PostgreSQL clock value defines acceptance, lifecycle/spec/event
and Agent timestamps, and the cooldown deadline. The drain deadline preserves
its configured duration from that acceptance point. Earlier Skill preparation
timestamps are unchanged. A new barrier remains blocked before the saved
cooldown deadline even after the previous Rebuild fails; at or after the
deadline it may admit a new request. Original receipt replay never extends it.

The spec, lifecycle operation, Agent CAS, event, synchronization revision,
receipt, cooldown and original pending command commit together. Any failure
rolls back all these effects. Pending commands can be enumerated after process
restart without consulting current ACP or policy state. Confirmation requires
the exact immutable request ID and fingerprint and is monotonic: repeating it
changes nothing and cannot acknowledge another Agent's pending command.

This storage API does not start or confirm a Temporal workflow on its own. The
orchestration batch must prove that the engine accepted the original command
before confirming it; timeout, cancellation or an unknown response must leave
the command pending. Manual/notify presentation and real manual UI recovery
acceptance remain required before the complete recovery workflow is delivered.

### Application Admission

`RuntimeBarrierRecoveryAdmissionService` checks the scoped original receipt
before loading current Agent, Template or Skill preparation data. A committed
receipt replays its original six-field Rebuild command even after policy,
owner or Template observations change. Receipt and operation scope,
fingerprint, configured source Runtime and target Template must agree;
missing or inconsistent persisted state is a contract error.

New recovery admission shares ordinary Rebuild preparation, including its
stable target ID, Skill intent and drain duration. It passes recovery metadata
to the atomic repository transaction and then reads the persisted receipt;
the application never invents acceptance or cooldown timestamps. A normal
lifecycle operation alone cannot substitute for a recovery receipt. If
preparation or Begin fails after a concurrent or unknown commit, a valid
original recovery receipt takes precedence; otherwise the original error is
preserved.

Cancellation stops subsequent dependency calls at admission boundaries. A
cancelled preparation does not begin a new lifecycle; cancellation after a
commit leaves its original command pending. This application service never
starts a workflow or acknowledges a pending start. The observation worker below
selects candidates for this boundary and runs independently of pending starts.

### Original Workflow Start

`EnsureRuntimeBarrierRecoveryStarted` starts only the receipt's original
`LifecycleCommand`, using `agent-rebuild/<request_id>` and the existing
`LifecycleWorkflow` task queue. It uses existing running executions and rejects
duplicate closed executions. The business row, an admission Update or an old
Update handle cannot substitute for engine acceptance.

For a new, running or retained closed execution, the adapter checks the exact
workflow/run identity, type, task queue and known execution status. It reads
the original Started event and requires one input equal to the full original
command. Missing or expired history, conflicting input and unknown dependency
results remain errors; no replacement workflow or refreshed command is sent.
Success proves acceptance, not successful lifecycle completion.

Each dependency call uses the caller's context and settles before return.
Cancellation prevents subsequent dispatch and cannot become a successful
confirmation after a delayed SDK response. This adapter never acknowledges
the database pending row. The pending-start worker confirms the original request
and fingerprint only after successful engine verification; a crash between
these steps leaves the same command available for retry.

### Pending Workflow Start Worker

`RuntimeBarrierRecoveryStartWorker` resumes durable accepted commands through
only pending enumeration, original engine-start verification and confirmation.
It does not query current ACP, policy, catalog or admission state. Confirmation
means that Temporal accepted the original command, not that Rebuild completed.

Each round reads one page with a configured limit of 1–1000 receipts and one
deadline shared by enumeration, starts, confirmations and the local cursor gate.
The entire page must have valid, strictly increasing request IDs before any
dispatch. Failed attempts advance the cursor so later requests can progress;
unattempted entries are not skipped. Completing a short page, including an empty
one, wraps the cursor so retained failures and newly inserted lower IDs are
revisited. A process restart begins a new scan from durable pending state.

Unknown or conflicting starts never confirm. Confirmation errors retain their
original causes; a lost commit response is not treated as rollback. All calls
remain synchronous. Cancellation waits for the actual outstanding call to
settle and prevents further dispatch, including confirmation after a late start
response. Polling starts immediately, then waits between rounds with a
cancellable timer. Logs contain only a fixed failure classification.

UI and real manual recovery integration remain separate required work.
Component coverage uses real PostgreSQL and Temporal
acceptance, with synthetic response-loss/held-return adapters; it does not claim
execution against a real Runtime, ACP or Egress service.

### Barrier Observation And Admission Worker

`RuntimeBarrierRecoveryObservationWorker` scans created, enabled Agents across
organizations using the existing `(created_at, agent_id)` keyset query. It does
not filter Runtime state: a Controller projection can still report `available`
while ACP retains a durable barrier. Each round validates one complete ordered
page before reading any candidate's current lifecycle base. Stale, disabled,
revoked or already-owned lifecycle work is not eligible for a new observation.

The current base must belong to the selected Agent and Organization and retain
valid configured spec/execution lineage. The ACP read uses that Runtime revision
and must return the exact requested scope. A null barrier means no matching fact;
errors never become an empty or safe result. The barrier's original execution
identity is preserved and need not match a later health observation.

Only a valid, current Organization policy in `auto` mode invokes admission.
The intent carries the stable barrier-derived request ID, configured Template
snapshot, and Agent owner/authorization/revocation watermarks. The admission
transaction rechecks binding, policy, lifecycle and cooldown after these reads;
an observation is not authority to bypass those guards. `manual` and `notify`
perform no automatic admission; notify mode persists a deduplicated journal
notification, while manual mode only records the observed recovery state.

Before the ACP read, the worker captures the persisted observation revision.
A successful read, including an explicit null, is recorded with the current
policy and source snapshot before any automatic admission. Failed or malformed
reads retain the previous observation. Persistence failures prevent admission
for that candidate and leave other candidates eligible in the bounded round.

A configured page limit of 1–1000 bounds candidate count, and one round deadline
covers the cursor gate, query, base, ACP, policy and admission calls. Each visited
candidate advances the cursor even if it fails; later candidates can proceed.
A completed short or empty page wraps, while cancellation preserves the
unvisited tail. Calls remain synchronous and cancellation waits for the actual
outstanding call to return; a late successful read cannot start new admission.
The first round runs immediately and subsequent rounds use cancellable polling.
Logs use a fixed failure classification without raw causes or Agent identities.

### Durable Observation, Notification And Agent Projection

Migration 0030 stores one versioned observation per Agent, including explicit
null tombstones. The transaction locks policy, Identity admission, execution
organization, Agent and owner binding before writing. Runtime/spec/execution
lineage, access revision and owner authorization/revocation watermarks must
still match; changing health observations or aggregate sequence alone does not
invalidate that source. An unchanged fact/source/policy is a durable no-op.
A changed result requires the revision read before the ACP query, so a late
null cannot erase a newer barrier and a late barrier cannot resurrect a cleared
one. No ACP or Temporal call occurs while these database locks are held.

Notify mode atomically appends one v1 `agent_runtime_barrier_required` event for
the original organization/Agent/barrier tuple. Its immutable notification row
is separate from Rebuild receipts, starts and cooldowns: notifying does not
consume an operation, and later manual recovery remains possible. Repeated
observations and policy changes cannot republish or rewrite that notification.
The Agent aggregate advances only for a newly committed notification.

Opaque barrier IDs, including NUL, are stored as BYTEA. The journal JSONB holds
the other four public fields. List/Watch reads join the typed notification row
in the same database query and validate its tuple, stable ID and payload before
adding the barrier ID. A missing or inconsistent extension fails the entire
page; historical v1 payloads and readiness v2 readers retain their contracts.

The optional `runtime_recovery` Agent field contains only the nine frozen
management fields. It excludes execution IDs, endpoints, credentials and Run
content. Reads fence the observation against the caller's source, the current
Agent, active owner binding and revocation watermark in one database snapshot.
An original Rebuild may retain its reason until it replaces that source. The
nullable UTC cooldown comes from the accepted Agent cooldown, never a new
deadline derived from the current policy. This read-only projection grants no
recovery authority; the existing administrator Rebuild grant still applies.

Observation never starts a workflow or confirms a pending command. The separate
pending-start worker can resume a committed original even when current ACP or
policy reads fail. Both workers are started by the main-process owner below.
Component coverage uses real
PostgreSQL candidate queries, atomic admission, reopening and intervening policy
or owner-binding changes; ACP observations and RC preparation are synthetic.
Real ACP kill-mid-tool, Runtime replacement, new Run, and manual UI acceptance
remain required before issue #50 is complete.

### Main Process Ownership

Controller constructs both recovery workers with the existing PostgreSQL
repository and lifecycle application. Observation uses the configured ACP
control origin and workload-authenticated HTTP client; pending starts use the
same orchestration service as public lifecycle commands. Deploy the ACP barrier
query producer before this Controller version. The logical Organization default
remains `manual`; only an explicitly stored `auto` policy admits new recovery.

All configuration, service construction and listener creation finish before the
Temporal worker and background loops start. Recovery observation, pending
starts, execution publication, Runtime observations and identity revocations run
independently. A held publication or failed current ACP query cannot prevent
already committed commands from reaching the pending-start worker.

`ANTNEST_AGENT_CONTROLLER_RUNTIME_BARRIER_RECOVERY_POLL_INTERVAL` defaults to
`2s`, `ANTNEST_AGENT_CONTROLLER_RUNTIME_BARRIER_RECOVERY_ROUND_TIMEOUT` to `10s`,
and `ANTNEST_AGENT_CONTROLLER_RUNTIME_BARRIER_RECOVERY_BATCH_SIZE` to `100`.
Both durations must be positive and the page limit must be 1–1000. The workers
share configured values, but each round has its own deadline and cursor; these
settings do not override Organization mode or cooldown.

Parent cancellation or an HTTP Serve failure cancels the common background
context and initiates HTTP shutdown. The existing shutdown timeout bounds the
graceful phase. Exceeding it remains an error, but does not release dependency
ownership: all five actual worker callbacks and HTTP Serve must return before
main stops the Temporal worker, closes its client, and closes PostgreSQL. This
is not a claim that an unresponsive dependency can always finish within `15s`.
HTTP Serve, Shutdown and Close errors are retained together, and one cleanup
error cannot skip another worker. A pre-cancelled owner closes its listener
without dispatching Serve or background business.

Ownership tests hold callbacks through cancellation and budget expiry and
observe their actual returns before simulated dependency closes. They do not
replace real ACP/Runtime fault-recovery acceptance.

## Lifecycle Settlement

The lifecycle application, not PostgreSQL, decides whether drain may advance.
Rebuild, disable and delete first publish the current organization snapshot,
verify that the target Agent is closed for the same lifecycle operation, and
persist ACP's acknowledgement. Only then may they call `settle-agent`: rebuild
and ordinary disable wait; delete and identity revocation cancel and await
settlement. The organization publication gate is released before waiting; credential
updates and identity revocation must not queue behind a long-running Run.

The operation stores one absolute `drain_deadline_at` when it is accepted.
Retries and process restarts reuse that value, including after a configuration
change. Publication, gate acquisition and settlement share this deadline.
An expired operation does not issue a late cancellation or mutate Runtime.
Transport or acknowledgement errors are not proof of an idle Agent.

`settled` and `runtime_barrier_required` permit the same existing network-fence
and Runtime lifecycle stages. `not_settled` stays in drain until the fixed
deadline and then follows the existing lifecycle failure policy. Repository
drain methods only conditionally advance the management operation; they do not
read Run admissions. ACP retains any unconfirmed old-Runtime stop protection,
even when a failed management operation restores the previous configuration.

Runtime replacement, disable and deletion must only persist management facts.
They must not release Run admissions, interpret unknown Tool effects or append
execution events. Runtime result and absence validation remain local management
checks; ACP alone retains and clears its execution protection. Component tests
complete these lifecycle paths without any Controller Run table.

Controller has no Run-admission storage, per-Run ticket, completion receipt,
Run recovery or additional workflow.

Production composition uses `ANTNEST_AGENT_ACP_CONTROL_URL` as the dedicated ACP
control origin. Both publication and settlement authenticate with Controller's
own workload credential; they are already accepted service-owned operations and
do not replay the initiating user's expiring CCT. `ANTNEST_ACP_MAX_CONFIGURATION_BYTES` must have the same value on both
services (default 16777216, accepted range 1024-67108864). The Controller applies
that limit transactionally before accepting configuration, not after committing
an unsendable snapshot. Publication scheduling is configured on Controller:
`ANTNEST_AGENT_CONTROLLER_EXECUTION_RESYNC_INTERVAL` (30s),
`ANTNEST_AGENT_CONTROLLER_EXECUTION_RETRY_INTERVAL` (1s),
`ANTNEST_AGENT_CONTROLLER_EXECUTION_MAX_RETRY_INTERVAL` (30s) and
`ANTNEST_AGENT_CONTROLLER_EXECUTION_REQUEST_TIMEOUT` (15s).
The shared publisher is used by the worker and lifecycle requests. Worker
shutdown is awaited before the database closes; a timed-out lifecycle attempt
does not spawn an independent publication task.

## Projection Rules

- Include all current Providers and Models in the organization, including
  disabled records required by retained configurations. Model parameters are
  current catalog values, not a model revision embedded in a past Agent build.
- Keep Provider routing independent from credentials. The wire schema permits
  authentication material on disabled connections, but ACP revokes disabled
  clients and aborts existing holders; it does not drain or revive them.
  Credential rotation on an enabled connection preserves that client's lifetime.
- Publish trusted Provider discovery facts only while the stored observation
  set's binding still matches the current connection: organization, connection,
  provider, request protocol, canonical base URL and the current STRING
  credential version. A matching set emits `provider_token_limits`
  (`source:"models"`, its durable `source_revision`, binding and API model id)
  on the execution model with the same API id — only when at least one token
  dimension was observed — and `supports_tools` whenever capability was
  proven. Rotated, edited, disabled or mismatched bindings publish nothing;
  editable `context_window`/`max_output_tokens` can never fill an unknown
  observed dimension. Facts live on the execution model only — never on
  editable `ModelParameters`, history or fingerprints.
- Publish the Agent's committed executable configuration, or its known build
  configuration with execution closed before the first successful build. Never
  substitute a pending rebuild target for a still-running configuration.
  The source carries the existing `AgentSpecRecord`: its Agent ID and committed
  Spec ID must match. Before an Agent has a committed Spec, only its own first
  persisted candidate is allowed, with execution closed. This is not a second
  revision or lifecycle model.
- When a failed lifecycle has cleared the executable binding, the last
  successful execution's own Spec remains the configuration source. Before
  any successful execution, use the Agent's first persisted candidate instead,
  including a created-but-never-ready Agent. Neither fallback restores an
  executable Spec ID, Runtime or permission. Missing/foreign history fails the
  read; a pending rebuild target is not a fallback.
- Runtime readiness, enabled intent/activation, absence of an active lifecycle
  operation, and complete binding are necessary to set `accepting_runs`.
  Closing execution alone does not remove authorized history access.
- Revoked identities receive no execution grant. Deleted Agents disappear from
  the projection; ACP retains their historical Sessions and audit itself.
- Incomplete, cross-organization, duplicate or dangling source data fails the
  whole projection; it must not silently publish an empty or partial snapshot.
  Source identity validation precedes deletion filtering. An ambiguous
  deleted/live duplicate cannot restore a grant by being silently filtered.

## RPC And Diagnostics

Only `apply-execution-snapshot` and `settle-agent` are outbound execution-control
RPCs. There is no acquire/finish RPC, admission ticket or per-Run credential lookup.
The client validates acknowledgements against the requested organization/revision,
rejects redirects, bounds response decoding, and uses caller cancellation and
configured network deadlines. It does not retry commands or extend lifecycle
deadlines internally; the existing orchestration owns retries.
`not_settled` and `runtime_barrier_required` remain distinct results, not errors
or aliases for successful settlement. Only the caller's lifecycle policy can
interpret them. An invalid/stale acknowledgement or failed RPC has no result.
UTC conversion preserves the original deadline instant, including on retries.

Snapshot HTTP exchanges use the shared telemetry transport with method, organization,
revision and error metadata. Never capture snapshot request/response contents,
decrypted credentials, raw downstream error messages, or response bodies in logs.
Transport/read/close failures cannot return their raw error causes either:
Temporal serializes unwrapped errors. The adapter retains only safe classifications
and cancellation/deadline sentinels, verified using Temporal's failure converter.
Temporal activities receive only identifiers, assemble current data locally,
and return non-secret acknowledgements. Secrets must never be Workflow inputs,
activity results or durable history.

## Verification

Use doc -> test -> code. Required evidence includes shared JSON Schema validation
of actual serialized requests, current credentials and disabled connection refresh,
fail-closed source validation, creation/readiness distinctions, response-loss and
replay semantics, caller cancellation and secret-excluding trace propagation.
Then cover PostgreSQL snapshot consistency, atomic revision/acknowledgement updates,
capacity reservation, every mutation site, lifecycle and production composition.
Cross-service deployment and Jaeger tracing are verified by the root Docker E2E
suites, not by service-local tests.

## PostgreSQL Publication State

### Capacity Invariant

The producer budgets the actual Go JSON encoding of the current organization,
including locally decrypted credentials. It additionally budgets every Agent's
registered, still-running lifecycle target and its retained fallback Spec
without publishing either alternative. For each Agent, take the largest
current/target/fallback encoding: these are alternative configurations, not
three simultaneously published Agents. A smaller unready target cannot release
the budget still needed if a lifecycle failure closes execution and falls back.
The retained Spec is joined in the existing source SELECT, not loaded per Agent.

Closure budgets include the longer `false` Provider/model values, the largest
safe revision, up to 200 ASCII bytes for mutable identifiers and one owner
grant, up to 200 UTF-16 units for the unavailable reason, and a future Runtime
binding. Runtime MCP endpoints produced by Controller are limited to 2048 UTF-8
bytes; the budget allows JSON escaping for every byte. This is a producer
constraint, not a new ACP field or endpoint. Variable target prompts and model
selections are checked when registering the target, before creating a Runtime.
The closure envelope also reserves the connection ID and the maximum canonical
ACP token; this local measurement never resolves RC authority. The private
instance handoff additionally limits executable endpoints to 1024 bytes.

The application owns this calculation behind a narrow capacity guard. A
configuration transaction holds the organization lock, writes its candidate,
reads the candidate and registered targets, and invokes the guard before
committing. Only local projection/cryptography may run there; the guard must
never perform HTTP, KMS or database calls. No plaintext or budget is stored.
Replacing local secret opening with a remote KMS requires revisiting this
transaction boundary, not silently adding network waits under the lock.

Catalog, lifecycle and authorization mutations all invoke the guard. A passing
catalog test alone does not prove that every lifecycle mutation enforces the
invariant; each mutation site needs its own coverage.

### Mutation Boundary

Lifecycle begin, publish, failure and quarantine change the current Agent
projection and commit one organization revision with that change. Intermediate
workflow phases do not: their child results remain private until publication.
Registered rebuild targets are capacity-checked before any external provisioning.
Replay returns the saved operation without another configuration revision.

Lock ordering is request identity, an existing Identity/observation cursor
boundary when needed, sorted organization locks, resource rows, then event
journal rows. Lookup of an Agent's immutable organization precedes its row lock.
Multi-organization changes must acquire their complete organization lock set
before changing resources; no HTTP call is made while those locks are held.

Runtime execution binding, loss and effective availability changes participate
in the same configuration transaction. Repeated condition timestamps and
diagnostic text alone do not generate a new execution revision. Owner
authorization and identity revocation update the current projection locally;
actual publication remains after commit and is not a second database write path.
Repeated revocation still advances identity watermarks and audit events, but
advances configuration only for organizations whose effective access changes.
An organization can contain both already-revoked and newly authorized Agents;
one newly removed grant advances its revision exactly once. Agents already
closed by deletion intent do not create another execution change on revocation.

`agent_controller.execution_configuration_sync` is one current row per
organization: desired `revision`, `applied_revision`, and update/acknowledgement
timestamps. Revisions start at one on the first committed configuration change.
No snapshot payload,
credential copy, message queue, delivery lease or per-Run receipt is stored here.
Migration 0012 creates the table without backfilling organizations that existed
before it. Applying it to a database populated by an earlier schema is not a
supported data upgrade and does not mean those organizations are synchronized.
Startup retains and enumerates already committed synchronization rows.

A configuration writer takes a transaction-scoped organization advisory lock before changing execution
inputs and advances its revision before committing the same transaction.
Catalog request replay returns its existing receipt without advancing the
execution revision. An aborted resource write leaves neither the resource nor
its proposed revision visible. Lock ordering is request identity, organization,
then resource rows; lifecycle writers preserve that order.
This also covers the first write, before an organization synchronization row
exists, without a zero-revision placeholder or a no-op row update.

The private source reader uses one read-only repeatable-read transaction for
the organization revision, current sealed Providers, current Models and Agent
configuration/authorization bindings. It reads complete ordered collections,
not the public catalog's pages, and closes the transaction before credential
decryption or HTTP publication. Missing/dangling configuration fails the read;
it cannot silently disappear through an inner join. Different organizations
are never joined and no database belonging to another service is accessed.

Acknowledgement writes can only advance `applied_revision` up to a currently
committed revision. Delayed lower acknowledgements cannot regress it, and
ordinary acknowledgements and synchronization reads do not advance the desired
revision. Bootstrapping a legacy binding without proof republishes it at R+1
before a subsequent ACK can establish readiness.
The publisher must still resend equal revisions after restart; an old persisted
acknowledgement is not proof that ACP currently has its in-memory credentials.

An effective unbound preparing/unavailable transition changes the snapshot
reason and therefore advances its revision; repeated diagnostic updates do not.
When fresh Runtime evidence reopens an existing binding, the same transaction
records its private `reopen_after_revision` after advancing the organization
revision. Both the current readiness projection and a first ready event require
an ACK covering that fence. A previously ready binding keeps its original
bound/ready history and does not append a duplicate ready event. Unrelated
organization changes do not move its reopening fence. Historical failed
operation diagnostics remain readable without blocking a recovered binding.

Provider creation/rotation, current Model writes, Agent lifecycle, authorization,
availability and revocation participate in revision and capacity hooks. The main
process wires the shared publisher, worker, commit observer and lifecycle
settlement Port. Database commit, remote application and Runtime readiness remain
separate facts. The Controller does not expose per-Run admission or credential RPCs.

Service-local tests exercise consistent snapshots, mutation/ACK atomicity, current
credential resend, capacity/references, worker cancellation and trace propagation.
Lifecycle confirmation is bounded by its original deadline, including database
lock waits; each Runtime-result write verifies Agent operation ownership.

Workspace metadata does not read Run state. Controller has no workspace state
endpoints, Run notification triggers, Run application/store/schema or execution
event fields.

Owner default authorization belongs to an independent
[Agent configuration service](agent-configuration.md), with a narrow storage port
and required HTTP/production dependency. It preserves default CAS, management
events and commit-triggered publication without calling a Run service. Identity
proof must match the Agent's current authorization sequence and cover the scoped
revocation watermark, including revoke/Enable before event consumption catches up.
A race test covers a stale proof submitted after a revocation. No default update clears an
identity fence or enables an Agent, and no Session override is written back.

Catalog retirement uses the existing enabled flags and command ledger; see
[Provider management](provider-management.md). Enabled template heads, current
non-deleted Agent configurations and running targets protect their actual model
dependencies under one organization lock. Historical revisions do not reserve
resources forever. Failed rebuild/disable retains the committed current spec and
only clears execution/Runtime bindings, preventing accidental fallback to a
retired model. Disabled templates remain readable for audit; new derivation is
validated transactionally, independently from history reads.

Capacity tests cover actual organization-lock contention, mixed Provider/Model
writes, credential/model rollback including command receipts, zero-Agent
closure, escaped payloads, retained fallback and a real never-ready disable
failure. Source tests reject missing/foreign retained execution and enforce
same-Agent execution/Spec ownership. The local suite does not cover a complete
deployed lifecycle against a real ACP.

`execution_publication*_test.go` covers publication ordering, equal-revision
resend, source/acknowledgement scope, failure and cancellation. Standard Go
`testing/synctest` verifies that waiting publishers cannot read an outdated
source, cancelled waiters exit, and failures at read/send/acknowledgement release
the organization boundary. A different organization remains independent.
`execution_publication_ownership_integration_test.go` uses independent repository
pools and HTTP peers against real PostgreSQL to verify that a waiting publisher
cannot read, decrypt or send early, mutations and other organizations remain
independent, cancellation leaves no publication work, and failed delivery
releases ownership. These are in-process repository integration checks; they
do not establish one publication per revision or the complete multi-process
capacity acceptance for issue #43.
`execution_publisher_component_test.go` combines real PostgreSQL, `SecretBox`,
the application and the HTTP adapter with a synthetic ACP peer. It drops the
first HTTP response, rotates credentials and verifies current-state resend,
acknowledgement persistence, closed database transactions before network I/O,
and trace propagation without secret payloads. It is not a Docker/real-ACP
integration claim. The general source tests separately cover a repeatable-read
MVCC snapshot during concurrent rotation and exactly four source SELECTs.
`runtime_connection_component_test.go` uses real PostgreSQL and authenticated RC
and ACP HTTP peers to cover exact binding, restart resolution, mismatch/outage
rejection, unchanged acknowledgement, closed publication and database/Trace
privacy. It does not substitute for final cross-service acceptance.

## Owner Binding And Persistence Boundary

Publication reads Agent owner, access revision and the matching active binding in
the same MVCC transaction. A missing or inactive binding publishes no principals
and closes execution, while retaining the Agent configuration entry. Identity
revocation and deletion independently remove access. Organization-shared Provider
credentials are not deleted when one owner's access changes.

The binding table is keyed by Agent ID. Controller has no opaque execution
subject, duplicated prompt capability fields, Run table, admission receipt or
Run audit event. Future management operations that change binding validity must
advance the organization's publication revision in the same transaction.
Default authorization updates recheck the current owner and matching binding;
consistent changes of owner/access revision invalidate an old request proof.

The internal Provider section contains current decrypted credentials. It must
remain internal; Runtime deployment commands, managed-MCP arguments/environment
and ciphertext storage details are not part of the published Agent payload.

## Model-call policy publication upgrade

Migration 0032 advances organization publication revisions for effective Template
retry/failover defaults while preserving immutable history and existing ACKs.
Stop old Controller publishers before the migration, and deploy the ACP consumer
first. The [model-call policy guide](model-call-policy.md) specifies rollout,
revision exhaustion, explicit opt-outs and remaining consumer work.
