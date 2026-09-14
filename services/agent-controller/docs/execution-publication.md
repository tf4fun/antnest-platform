# Execution Configuration Publication

This service owns Agent configuration, lifecycle intent, Provider connections
and credential material. ACP owns protocol authorization, Sessions, Runs,
Tools and execution audit. The authoritative design is the
[Controller/ACP boundary plan](../../../docs/controller-acp-execution-boundary-plan.md)
and its [internal RPC contract](../../../contracts/agent-acp/execution-api.md).

## Service-Owned Delivery

B2 is in progress. Projection, the outbound client, the PostgreSQL source,
mutation hooks, commit hints, the publication worker and catalog availability are implemented.
The main process now wires the shared publisher into the worker and lifecycle
service. Legacy execution applications, repository methods and storage are now
removed. Whole-service format/lint/build and PostgreSQL/race gates have passed.
Real Temporal recovery and consumer/integration acceptance remain pending;
this is not yet a deployable producer/consumer combination. Delivery order:

1. Typed current-configuration projection and an outbound ACP client. Use
   organization-scoped source records, not Run/admission snapshots or public
   paginated catalog APIs. Open current credentials only for publication or
   local capacity measurement; never persist the plaintext projection.
2. A consistent private PostgreSQL source and one current synchronization row
   per organization. Advance the revision in the same transaction as effective
   configuration changes. Keep acknowledgements separate from desired revision.
3. Use the shared publisher after commits and periodically resend the current snapshot. Do not
   skip equal revisions: ACP restart loses volatile credentials. Keep network
   waits outside database transactions and serialize publication per organization.
4. Integrate lifecycle close/publication/settlement and independent Runtime
   readiness; remove old RunAdmissions and reverse ACP business RPCs.

The new client and source are not a compatibility mode or a second permanent
execution path. Production composition switches after the producer and all
its mutation sites are covered. A locally passing client test is not evidence
that lifecycle or Gateway integration is complete.

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

`ExecutionPublisher.Publish` serializes publication within an organization.
After acquiring that cancellable local boundary, it reads current source data,
checks the requested organization, builds the projection and sends it through
the ACP client. Database reads finish before credential opening or HTTP calls.
The result contains only the non-secret acknowledgement, never the snapshot.

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

Commit-triggered outbound RPCs inherit the originating span context through
the shared transport instrumentation. Periodic repair has no fabricated user
parent. Logs contain only safe failure classification. These callbacks are
not a persistent queue: a crash loses hints and traces, not configuration.
No new table, listener connection or per-organization background task is used.

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
must complete these lifecycle paths without access to the legacy Run table.

Legacy Run-admission storage and its execution methods have been removed.
No per-Run ticket, completion receipt, Run recovery or additional workflow is
introduced. Whole-service and later B5 evidence remain separate.

Production composition uses `ANTNEST_AGENT_ACP_SERVICE_URL` as the internal ACP
origin. `ANTNEST_ACP_MAX_CONFIGURATION_BYTES` must have the same value on both
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
- Keep Provider routing independent from credentials. Both enabled and disabled
  connections can publish current authentication to existing ACP client holders.
  This never permits new use of a disabled connection.
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
Cross-service deployment and Jaeger acceptance remain the integration batch.

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

The application owns this calculation behind a narrow capacity guard. A
configuration transaction holds the organization lock, writes its candidate,
reads the candidate and registered targets, and invokes the guard before
committing. Only local projection/cryptography may run there; the guard must
never perform HTTP, KMS or database calls. No plaintext or budget is stored.
Replacing local secret opening with a remote KMS requires revisiting this
transaction boundary, not silently adding network waits under the lock.

Catalog integration is followed by lifecycle/authorization mutation coverage
before production composition enables publication. Neither an optional
adapter hook in this intermediate batch nor a passing catalog test proves
that every lifecycle mutation already enforces the invariant.

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
This reconstruction is accepted on a fresh database, as specified in the main
plan. Migration 0012 creates the table without backfilling organizations from an
older development instance. Applying it to a populated pre-B2 database is not a
supported data upgrade; it must not be used to claim those organizations were
synchronized. Startup on databases written by this implementation retains and
enumerates the already committed synchronization rows normally.

A configuration writer takes a transaction-scoped organization advisory lock before changing execution
inputs and advances its revision before committing the same transaction.
Catalog request replay returns its existing receipt without advancing the
execution revision. An aborted resource write leaves neither the resource nor
its proposed revision visible. Lock ordering is request identity, organization,
then resource rows; remaining lifecycle integration must preserve that order.
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
neither acknowledgement nor synchronization reads advance the desired revision.
The publisher must still resend equal revisions after restart; an old persisted
acknowledgement is not proof that ACP currently has its in-memory credentials.

Provider creation/rotation, current Model writes, Agent lifecycle, authorization,
availability and revocation participate in revision and capacity hooks. The main
process wires the shared publisher, worker, commit observer and lifecycle
settlement Port. Database commit, remote application and Runtime readiness remain
separate facts. The Controller does not expose per-Run admission or credential RPCs.

Service-local tests exercise consistent snapshots, mutation/ACK atomicity, current
credential resend, capacity/references, worker cancellation and trace propagation.
Lifecycle confirmation is bounded by its original deadline, including database
lock waits; each Runtime-result write verifies Agent operation ownership. Independent
read-only review confirmed both fixes. See the
[current verification record](../../../docs/controller-acp-execution-boundary-plan.md#102-当前实施进度)
for final metrics rather than relying on historical counts.

Workspace metadata no longer reads Run state; the old state endpoints and Run
notification triggers are removed. Remaining B2 work removes legacy Run
application/store/schema and execution event fields. Gateway/Console and real Temporal/Docker/Jaeger tests
are not yet switched; production wiring alone is not an accepted deployment.

Owner default authorization now belongs to an independent
[Agent configuration service](agent-configuration.md), with a narrow storage port
and required HTTP/production dependency. It preserves default CAS, management
events and commit-triggered publication without calling a Run service. Identity
proof must match the Agent's current authorization sequence and cover the scoped
revocation watermark, including revoke/Enable before event consumption catches up.
The new race regression reproduced the old-proof defect before the fix; the
independent reviewer confirmed the correction. No default update clears an
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
same-Agent execution/Spec ownership. Read-only review found two fallback defects;
both were corrected and re-reviewed. The local suite does not establish T30's
complete lifecycle or real ACP deployment acceptance.

`execution_publication*_test.go` covers publication ordering, equal-revision
resend, source/acknowledgement scope, failure and cancellation. Standard Go
`testing/synctest` verifies that waiting publishers cannot read an outdated
source, cancelled waiters exit, and failures at read/send/acknowledgement release
the organization boundary. A different organization remains independent.
`execution_publisher_component_test.go` combines real PostgreSQL, `SecretBox`,
the application and the HTTP adapter with a synthetic ACP peer. It drops the
first HTTP response, rotates credentials and verifies current-state resend,
acknowledgement persistence, closed database transactions before network I/O,
and trace propagation without secret payloads. It is not a Docker/real-ACP
integration claim. The general source tests separately cover a repeatable-read
MVCC snapshot during concurrent rotation and exactly four source SELECTs.

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
