# Agent Ownership And Epoch Fencing (#49 Phase 3)

This contract defines the ownership facts that ACP processes must agree on.
It follows [durable Run admission](run-admission.md). The first delivery batch
provided lease storage and a fenced transaction primitive. Production now connects
fixed Agent generations, owned recovery and peer configuration acknowledgements.
The [fixed assignment contract](owner-assignment.md) defines shared compatibility
locking for peer mode and protection of unknown legacy work. Non-peer mode keeps
the exclusive lock. Forwarding, crash takeover and Docker integration remain
separate required work.

## Scope And Identity

One ownership scope is `(organization_id, agent_id)`. Sessions, principals,
connections and Runs of that Agent share its owner. Different organizations
with the same Agent string are independent. Ownership does not grant user or
service authorization and does not replace the durable active-Run constraint.

An ownership fence contains that scope, an opaque `owner_instance_id` identifying
one process incarnation, and a positive `epoch`. Every process start creates a
new incarnation; a stable deployment name cannot identify an incarnation.
Epochs increase on each acquisition after release or expiry, including reacquisition
by the same incarnation. They never wrap, decrease or reset when a lease is
released. Exhaustion fails closed. Epochs use decimal strings across process
boundaries; JavaScript number coercion must not truncate them. The maximum
epoch is `9223372036854775807`, represented as that decimal string.

An owner identity is not an endpoint or an authentication credential. A later
peer contract must map it through trusted deployment membership and verify the
target incarnation. Request bodies, CCT claims, redirects and arbitrary URLs
stored in the database cannot select a network destination.

## Acquisition, Renewal And Release

PostgreSQL time is authoritative. Each mutating lease decision first locks the
scope's durable row, then evaluates current database time. Time sampled before
waiting for that lock is insufficient. Client clocks and delayed RPC responses
cannot extend a lease.

- A never-owned scope starts at epoch 1. Concurrent acquisition gives only one
  incarnation a live lease.
- A live lease held by another incarnation rejects acquisition. Repeating
  acquisition by its current incarnation may return the same fence and expiry;
  it must not implicitly renew it.
- Acquisition after expiry or explicit release advances the persisted epoch.
  The old fence cannot be revived, even by the same incarnation.
- Renewal requires the exact scope, incarnation and epoch, still live when the
  lock is held and database time is checked. It sets a new bounded expiry from
  that database time. A delayed renewal cannot resurrect an expired lease.
- Release requires the exact live fence and makes the scope eligible for
  acquisition. A delayed or repeated release cannot shorten a successor's lease.
  It returns true only when that call shortened the live lease; an expired,
  already released or mismatched fence returns false without mutation. A false
  result cannot identify which other incarnation, if any, now owns the scope.
  The durable epoch history remains; release does not delete its row.

The storage primitive accepts a positive whole-millisecond duration from 1,000
through 300,000 ms. The later coordinator uses a default 30-second lease and a
10-second renewal interval, with finite SQL and transaction budgets shorter
than the lease. Configuration must reject a renewal/budget combination that
cannot leave time to fail closed. No coordinator tuning flag is enabled by the
storage-only batch.

Reading a lease returns a snapshot, including database observation time. A
snapshot is not permission to write or dispatch an effect. An unknown outcome
from acquire/renew is not proof of continued ownership; the coordinator must
reconcile with the database before resuming admission.

## Production Generation Lifetime

Each process captures its accepted registration before acquiring an Agent lease.
Acquisition is single-flight per scope. A generation owns one immutable registration
and fence, one component graph and the original asynchronous work dispatched through
that graph. Initialization must load and revalidate sealed configuration and the
durable revision under that fence before opening admission. An acquired lease or
constructed repository factory alone does not open an Agent.

Initialization has its own finite monotonic admission deadline, using the
generation operation budget (10 seconds by default). Renewal cannot extend that
deadline. On expiry, close only that scope's readiness and dispatch so other
Agents can prepare, while retaining and joining the original initializer and
cleanup before releasing its lease. Recheck the deadline before opening even
when timer delivery is late. Normal drain already closes readiness and continues
renewal while joining; the initialization timer does not turn it into lease loss.

Local lease deadlines are conservative monotonic deadlines: subtract the full
request/response duration from the database-observed remaining lifetime. Neither
wall-clock changes nor a delayed successful response may extend that bound. The
coordinator closes admission on expiry or an unknown acquire/renew outcome; it
continues to own and join the original operation. A late success cannot reopen the
closed generation or replace its fence. Only that exact, validated scope and
incarnation may be released after its work settles.

Register original initialization, admission, accepted Run completion, model/Runtime
and cleanup Promises before yielding their lifetime to another owner. Loss aborts
that Agent's dispatch signal immediately; it does not abort unrelated Agents.
Retaining a completion only joins work already dispatched and never authorizes a
new effect. The admitting operation must retain accepted completion before it
returns, including when its response arrives after ownership loss.

The application router captures request data before awaits, authorizes the trusted
connection binding, then captures a prepared generation by organization and Agent.
It never acquires a new lease on behalf of an individual request. Loss before the
application callback starts is `agent_unavailable`; after invocation, a write may
already be committed and the public result must retain the non-retryable
`database_error` / query-intent recovery classification. A captured Agent's loss
closes only that scope. Prompt persistence must not send it to the global database
failure channel. Closure is requested without awaiting the admission's own join.

Normal draining forbids new dispatch but continues renewal while original tasks
remain. After all original work has settled, stop renewal, join its in-flight
request and release the original fence. A non-cooperative task prevents completion
of drain; an AbortSignal race or elapsed grace period is not stopping proof.
Predecessor recovery still requires the separate stop-proof protocol. Production
startup must inventory and isolate protected owned scopes before scoped legacy
recovery; it must not pass those rows to global legacy recovery.

Legacy recovery helpers accept an explicit, validated organization/Agent scope.
They capture the complete tuple before waiting, select all candidate rows in that
scope, and reject owned work rather than silently filtering it out. Omitted scope
retains the global fail-closed behavior; malformed scope cannot fall back to it.
Learning recovery transactions share one lock-owning connection, so different
scopes run serially and only identical scopes share a result. Release joins the
original recovery queue, monitor and unlock, including repeated release calls.
Successful scoped recovery alone is not admission: the production coordinator
must still inventory protected predecessors and recheck under the acquired fence.

These lifetime requirements do not remove the global worker lock. Production
configuration/Prompt/permission/Learning consumers, scoped startup and stopping
recovery, and explicit multi-replica integration must all be admitted before that
lock can be retired.

## Transaction Fence And Linearization

Every Agent-owned durable mutation must carry an explicit fence. The database
transaction locks the lease row, verifies scope, incarnation, epoch and live
expiry after obtaining the lock, and retains a lock that excludes lease
replacement until COMMIT or ROLLBACK. The check and the business mutation must
use the same database transaction and connection. A check in an earlier
transaction, an in-memory flag or an AbortSignal race cannot provide this proof.

TTL makes a lease eligible for takeover; it cannot undo a transaction that has
already committed. A finite transaction admitted under the fence may finish
while takeover waits for its row lock. Takeover then advances the epoch. Once
takeover commits, a write with the old epoch must fail with no business changes,
including a query issued earlier but still waiting for the lease lock. Tests
must prove this commit ordering rather than claim wall-clock expiry revokes
already committed work.

Fenced transactions contain database work only, never model, Runtime, peer or
other external RPC waits. A database-enforced hard budget bounds the whole
transaction; per-statement and idle-transaction timeouts alone cannot bound a
transaction that keeps issuing more statements. Cancellation must join the
actual database operation and rollback;
abandoning a Promise does not prove that a write stopped. Lost commit receipts
retain their existing uncertain-result semantics and never authorize replay.

Paths already needing an organization barrier lock keep the order:
organization lock, lease rows in sorted organization/Agent order, Session, Run,
then child records. Ordinary Agent operations need no added organization lock.
They must not obtain a Session/Run lock and then acquire the lease lock. Scope
resolved from a Run or Session is rechecked against its durable identity;
caller-provided scope cannot authorize another object's mutation.

The complete write inventory includes Run intent/accept/reject/cancel/finish,
Run events and tool attempts, checkpoints, Session lifecycle/configuration/MCP,
permission decisions and durable tool rules, temporary skills and Runtime
protection, skill projections, and learning claims, budgets, outcomes and
cleanup. Learning generation fences remain additional requirements. A tested
generic transaction primitive does not prove those consumers are connected.

## Core Run Writer Requirements

An explicit owned repository factory must copy, validate and freeze the accepted
registration tuple (`registration_id`, `member_id`, `incarnation_id`) and its
Agent fence before returning writers. The fence's `owner_instance_id` must equal
the registration's `incarnation_id`. Later caller mutation cannot change either
binding. Legacy repositories use a separate explicit factory. Optional-fence
APIs, ambient AsyncLocalStorage ownership, mutable `currentFence` lookups and
fallback from an owned failure to legacy writes are forbidden.

The intent transaction records four immutable private Run facts from that
captured binding: `execution_owner_registration_id`, `execution_owner_member_id`,
`execution_owner_incarnation_id` and `execution_owner_epoch`. They must be either
all null or all valid together. Historical rows remain all null; migration or
later access must not backfill them with a current owner. Acceptance verifies
the original tuple rather than replacing it. These facts do not change public
Run snapshots or protocol wire shapes.

Every ordinary owned Run mutation requires both a currently live exact lease
and a complete match between the Run's original four facts and the captured
registration and epoch. A new owner cannot use ordinary accept, reject, cancel
or finish paths to terminate a predecessor's Run, including a previous epoch
of the same incarnation. Predecessor recovery requires the separate scoped
stop-proof path in [owner handoff](owner-handoff.md).

Scope derived from a Session or Run must be rechecked on the same connection
inside the fenced transaction before business mutation. `finish` retains its
organization barrier and locks in organization, lease, Session, Run order.
The current lease and original Run identity checks precede all duplicate event,
tool-attempt and terminal receipt returns. A transaction which waits for the
organization barrier rechecks the lease only after that wait. Event payloads,
targets and timestamps are captured before yielding; caller mutation cannot
redirect an already queued write or change its committed facts. Terminal Run
facts, refusal exclusions, checkpoint invalidation, permission cancellation and
Runtime barrier creation share that same guarded transaction.
Session cancellation, close and other lifecycle paths that mutate Runs must
apply the same guard; a fenced Run repository cannot leave those bypasses
unfenced. Context checkpoints must carry their original Run binding. Looking up
the Session's latest Run cannot authorize a delayed checkpoint write.
The actual ContextBuilder receives that original Run ID from RunExecutor and
passes it with every saved checkpoint. The guarded transaction validates its
Session and original owner before conflict handling, and only a running Run may
save a checkpoint. A late write after refusal must not recreate invalidated
context, even while the same owner still holds a valid lease.

The actual Prompt path must pass the captured owner through admission,
Supervisor, Coordinator and Executor into event, context and recovery writers.
Constructing an owned factory without those production consumers is not an
implemented execution path. Legacy writers reject mutations of every owned row;
global startup recovery must fail closed when it would act on an owned Run. They
cannot clear ownership facts, release its reservation or process it through the
all-null branch.

These are implementation requirements, not evidence of completed consumers.
Remaining owned writes, scoped recovery, actual task joins, configuration ACKs
and peer/integration work below remain pending. The global worker lock stays
until their required admission passes.

### Session Mutation Boundary

Session create, fork, MCP replacement/reactivation, cancellation, close, delete
and configuration changes use the same immutable authority as the Agent's Run
repositories. They enter the lease transaction before locking the actual Session;
scope is rechecked on the locked row. Any affected active Run is then locked and
checked against its original execution tuple before Session changes, cancellation
timestamps, configuration revision or replay events are written. A targeted
cancel also validates a matching terminal Run before returning its no-op result.
Legacy writers cannot mutate a Session over an active owned Run.

Delete retries for an absent or already-deleted Session still require a live
captured authority before local cancellation is dispatched. Existing Session
authorization is preserved. Callers cannot retarget an in-flight mutation or its
subsequent supervisor cancellation by changing mutable inputs across an await.
Denied writes leave persisted business state unchanged and dispatch no local
cancel. Successful ordinary cancellation keeps its original authority and joins
the supervised task; it is not evidence of whole-generation or remote quiescence.

Configuration compare-and-set remains atomic with its revision and replay event.
These adapter and Application boundaries do not enable production multi-replica
execution: coordinator lifetime capture, remaining learning writers, scoped
recovery and cross-replica integration are separate requirements.

### Permission Mutation Boundary

Permission open and decision use the same captured authority as the original
Run. In a lease-fenced transaction, lock the actual Session and Run and verify
scope and original execution identity before stale/deadline, terminal or duplicate
response handling. An always rule and its permission decision are atomic; losing
authority cannot persist either side. Request payload, decision and rule are
captured before awaits. Run cancellation and authority signals retain their
original references, so replacing caller input cannot bypass cancellation.

Global startup permission cancellation is legacy-only. It locks and validates
the selected pending records before cancelling that exact set. Any selected
owned Run makes the whole transaction fail closed; later rows are not borrowed
into the original cleanup. Scoped predecessor recovery is a separate API and
requires its independent stopping proof.

### Temporary Skill Mutation Boundary

Reservation and cleanup receipts use the captured Agent authority and original
Run identity, including on duplicate and terminal paths. Lock organization,
lease, actual Session and Run in that order before changing temporary scopes,
load-skill stopping facts or Runtime barriers. Candidate reads are not authority.
Before dispatching cleanup, validate the exact stored scope and original Runtime
binding under the same authority. Cleanup remains valid for a terminal Run and
a deleted Session while its original owner still holds the lease.

Capture cleanup scope and install input before awaits. Never keep a database
transaction open across a Runtime call. A preflight is not atomic fencing of
the remote effect: ownership can change during that call. In that case join the
original call, reject the late database receipt and retain all pending cleanup
and barrier facts. Updating released_at, load-skill stopping facts and barrier
retirement is one transaction. It must not stop ordinary Runtime tool attempts.
Generation dispatch closure, original network-task joins and predecessor
stop-proof recovery remain separate requirements before multi-replica rollout.

### Learning Claim Mutation Boundary

Learning uses the current Agent lease and the original Learning claim's durable
execution identity. Its historical sourceRun is evidence, not the owner of the
current Learning execution. A successor may learn from that completed source
with a new claim, but cannot borrow a predecessor's claim or save its late model
or Runtime receipt. Claim identity includes task scope, principal, sourceRunId,
claimId, generation, and the registration/member/incarnation/epoch that admitted
that generation. Check identity before duplicate or already-settled returns.
Claim-bound review, candidate and apply reads check the same identity before
returning facts that may drive another dispatch.

Pending tasks distinguish explicit legacy and owned admission before any claim
exists. Legacy writers must not treat an owned pending task's empty claim tuple
as legacy authority. Owned pending management may adopt an historical legacy task
only while it is pristine pending work: generation zero, no claim/started time
and no spent budget, review, model, candidate, evidence, apply or maintenance effects.
Adoption and the pending operation (first claim, cancellation or enqueue replay)
commit under the current lease in the same transaction;
there is no downgrade or fallback after an ownership failure.
An already-owned task with no claim must satisfy the same pristine-work checks;
an owned marker does not permit spending or child records before admission.

Each dispatched generation persists its own immutable owner binding. Ordinary
pause, resume, terminal transitions and receipt replay cannot replace or erase
that binding, including by substituting a new claimId. Same-owner pause/resume
preserves the claim, budget and all unsettled effects. Receipt settlement may
still be valid after a pause; requiring a running task is a separate condition
for new dispatch, not a substitute for ownership. Cross-owner recovery requires
positive stopping proof and preserved old-generation evidence through a separate
recovery operation; ordinary resume is not that operation.

Acquire the Agent lease before existing queue/review locks and task/child locks;
never hold a child intent or model-call lock while acquiring its task or lease.
Scope candidate scans and paused-task selection to the bound Agent and operation
mode. Keep existing global review and budget limits. Global worker-lock recovery
remains explicit legacy-only and fails the entire transaction if selected work
is owned; it cannot infer claim ownership from a historical sourceRun. Capture
mutable inputs before awaits. Production generation, scoped stopping recovery,
actual network-task joins and multi-replica admission remain later gates.

## Configuration And Recovery Boundaries

Controller configuration revision and Agent ownership epoch are independent.
Takeover must not rewrite configuration revision, Runtime identity or historical
Run snapshots. A new owner loads the latest sealed authority, installs it and
rechecks the durable revision and its epoch before opening admission. Public
configuration alone and a predecessor's acknowledgement are insufficient.

The existing organization acknowledgement wire stays unchanged. Its eventual
multi-replica implementation must cover current owners applying the revision
and stopping revoked access, and recheck their epochs when committing the
aggregate acknowledgement. Saving a snapshot at one replica is not a cluster
ACK. An accepting Agent without an owner cannot disappear from that proof, and
replicas still holding old access streams must be covered by revocation or
fencing even if they no longer own an Agent. Ownership acquisition and
executable publication must not depend on
Controller `ready`; the [readiness contract](../agent-controller/readiness.md)
forbids that acknowledgement cycle.

Recovery may mutate only the Agent scope acquired under the current fence.
The [owner handoff contract](owner-handoff.md) defines the original incarnation
binding and positive executor stop proof required before recovery can release a
predecessor's durable Run reservation.
Global startup Run recovery, abandoned permissions and learning recovery cannot
remain unchanged when the worker lock is removed. The current owner may recover
a predecessor's Run under the new fence while preserving its historical facts.
Other healthy owners' work must remain untouched.

Before preparing a new Agent generation, inventory persistent work by the full
organization/Agent identity. Owned admitting/running Runs, pending permissions,
unstopped Runtime attempts and unreleased Temporary scopes protect that Agent.
The Run determines a Temporary scope's ownership even if copied scope metadata
is inconsistent. Claimed nonterminal Learning and unsettled model calls also
protect the Agent, independently of its completed source Run.

An earlier pending/unknown install can be covered by a later terminal conditional
install only when the complete canonical attempt sequence, claim, candidate,
apply basis and final receipt agree. Applied outcomes additionally require the
matching durable change, including principal and source Run. A replacement
Runtime execution for a legitimate resend is allowed: the final receipt must
match the final intent, not the older basis execution. Do not rewrite historical
attempts or infer a model-call outcome from a terminal task label.

Inventory is advisory until repeated under the acquired fixed fence, after the
organization and lease barriers. Capture caller inputs before waiting and read
fresh work after the wait. This only admits scopes without protected predecessor
work; it is not the stopping proof required to recover an occupied scope.

Startup inventory's protected flag combines local execution uncertainty with
remote Runtime protection. It cannot be mapped directly to lifecycle settlement,
and application admission must not be a prerequisite for protected settlement.
An exclusive lifecycle control operation shares the Agent's scope barrier with
application generations. It admits no user dispatch, joins retired local work,
and uses its own fixed current fence to validate durable stopping facts. Scope
retirement remains occupied through the original control operation and lease
release, including cancellation, late results and failed cleanup.

Expiry or process loss is not evidence that remote Runtime effects have stopped.
Recovery must follow [Run recovery](execution-api.md#runtime-barrier-recovery-50-pending)
without replaying uncertain effects or fabricating quiescence and cleanup.
A lost owner must stop new work, abort and actually join its original handles;
it cannot write terminal, permission or cleanup receipts using its old fence.
An unjoined operation remains a failure/protection fact. Cleanup must remain bound
to the original Run and Runtime execution, never an unrelated current binding.

Graceful shutdown closes admission and keeps renewing while it drains and joins
owned work within the existing budget. It releases only after that work is
actually joined. A kill has no such receipt. Budget expiry retains failure and
protection facts; it does not count unexecuted cleanup as passed.

## Remaining Peer And Integration Batches

The private publication/revocation receipt, complete-member aggregate ACK and
subsequent forwarding boundaries are specified in [owner peer coordination](owner-peer.md).
They remain pending production consumers and do not remove the global worker lock.

The next peer contract must define a separate authenticated listener and exact
operations. The intended model is one owner terminating the complete ACP
session, with fixed-path, single-hop ingress forwarding. It must preserve
v1/v2 completion, bidirectional permission/output, CCT expiry, backpressure,
connection quota ownership and the distinction between connection loss and Run
cancellation. It grants no current peer route or self-call permission.

HTTP connection IDs and DELETE cleanup receipts remain tied to the original
instance and epoch. They cannot be rerouted using only the Agent's new owner;
a successor cannot acknowledge another process's cleanup. The peer contract
must define trusted connection routing, signed user context in addition to peer
workload identity, bounded deadlines, and no retry after possible forwarding.
Request IDs alone do not establish durable idempotency.

Before removing the global lock, service batches must connect every owned write,
scoped recovery and actual task joins, owner-covered configuration/revocation
ACKs, trusted member selection and peer forwarding. Deployment changes and any
Controller consumers have their own batches. Final Docker integration must
show different Agents running on both replicas, takeover after killing one,
stale-epoch rejection, #50 recovery behavior and actual resource cleanup.

## Evidence For The Storage Batch

Real PostgreSQL checks must cover concurrent acquisition, independent scopes,
same-owner retry without renewal, expiry and monotonic reacquisition, stale
renew/release rejection, and epoch exhaustion. Controlled lock barriers must
prove that renewal checks time after acquiring the lock, that a guarded write
and takeover commit in the required order, and that stale fences leave no
effects. Rollback and test cleanup must join all clients and Pools.

Those checks admit the primitive only. All production write consumers, actual
multi-process ownership and the final two-replica business workflow remain
pending until their own unit, contract, component and remote integration gates
pass. Span/Trace findings and confirmed external SDK defects remain auxiliary.
