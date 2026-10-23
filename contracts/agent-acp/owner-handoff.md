# ACP Owner Incarnations And Execution Handoff (#49)

This contract extends [Agent ownership](agent-ownership.md) and
[durable Run admission](run-admission.md). It defines the missing stop proof
needed to recover an Agent after its lease moves to another ACP process.
The operations below are planned producer/consumer work, not current route
grants. The global worker lock remains until those batches and two-replica
integration pass.

## Execution Identity And Reservation

Each accepted Run records its original process incarnation and Agent lease epoch
as immutable execution facts. The intent transaction writes that identity from
the explicit fence; acceptance verifies the same identity. The recovery owner's
current fence is separate and never overwrites the original execution owner.
Public execution snapshots and ACP protocol replies do not carry these private
control-plane facts.

Lease expiry, renewal failure, a lost PostgreSQL connection, missed heartbeats
and an unreachable peer are not proof that the original executor stopped.
Until a stop proof is accepted, an interrupted accepted Run remains nonterminal
and retains the durable Agent reservation. It must not be converted to terminal
`unresolved` merely to free that reservation: current terminal outcomes require
local executor quiescence.

Occupancy and settlement consult that durable reservation even when the new
owner has no local Run slot. They preserve Session/principal privacy and report
busy/not-settled until recovery has the required proof. The new owner does not
replay the original Prompt, Model call or Tool call.

## Trusted Incarnation Registration

Runtime Controller owns the platform adapter and its credentials. ACP receives
no Docker socket, container control permission or arbitrary inspection API.
The supported initial source is Docker; this does not claim Kubernetes support.

Runtime Controller receives an operator-owned ACP membership catalog. A member
maps to one configured platform service instance and a constrained private
probe address. These selectors are not supplied by ACP requests, user context,
database lease rows or redirects. Runtime Controller resolves the full container
identity and records the Docker engine identity and exact container `StartedAt`
privately. ACP uses only an opaque registration identifier.

Every ACP process creates a fresh random incarnation before starting its private
probe listener. It records a locally initiated registration intent with a fresh
unpredictable registration nonce before sending the registration request.
Registration names the configured member, that incarnation and that nonce.
Runtime Controller must verify the binding by probing the exact inspected
container with a fresh unpredictable challenge, using workload authentication.
The target answers only for its own still-pending registration intent; it must
not passively approve arbitrary requests naming its incarnation. The response
binds both nonces, the configured member and the current incarnation. The
registration nonce is private control-plane material and is not logged or
included in public inventory. Random incarnation identifiers are not credentials.
An unrelated replica cannot register another member by presenting the shared
ACP service identity. The adapter verifies the inspected container/start has
not changed before committing the registration. Process startup must be the
container's main process; a supervisor that can replace that process without
changing the observed container start is outside this adapter's contract.

The probe is available before ordinary ACP readiness and does not depend on
Controller publication or Agent readiness. Registration must complete before
that incarnation acquires Agent leases or starts execution. This avoids an
initialization cycle and ensures every newly owned Run has a resolvable origin.
Unknown registration outcomes are reconciled by exact member/incarnation
identity; they never authorize a new unrelated registration or execution replay.
Registration is idempotent for that member/incarnation and verified local intent.
Its engine/container/start binding is permanent. A retry cannot rebind an old
incarnation to a replacement start; it must return the original registration or
reject an identity conflict. Receipt lookup alone does not establish the
requesting process's identity.

The private wire is frozen in
[the planned operation manifest](owner-incarnation-contract.json) and
[the closed JSON schemas](owner-incarnation.schema.json). These files do not
grant routes in the active service caller catalogs. The operations are:

| Receiver                   | Operation                | Caller and input                                                                                 | Result                                                         |
| -------------------------- | ------------------------ | ------------------------------------------------------------------------------------------------ | -------------------------------------------------------------- |
| Runtime Controller         | `RegisterAcpIncarnation` | ACP workload; member ID, fresh incarnation ID and registration nonce                             | Opaque registration ID bound to the verified process start     |
| Runtime Controller         | `InspectAcpIncarnation`  | ACP workload; opaque registration ID                                                             | `running`, `stopped` with a durable stop receipt, or `unknown` |
| ACP private owner listener | `ProbeIncarnation`       | Runtime Controller workload; fresh challenge, registration nonce and expected member/incarnation | Exact challenge/member/incarnation response                    |

Runtime Controller receives `POST /internal/acp-incarnations/register` and
`GET /internal/acp-incarnations/{registration_id}` from ACP workloads only.
The separate early ACP owner listener receives
`POST /internal/acp-owner/incarnation/probe` from Runtime Controller only.
The existing ACP workspace, control and health listeners do not serve that
probe. The owner listener must not consult ordinary readiness, the database,
Identity or execution publication to answer a locally pending intent.

`member_id` is a lowercase catalog label of 1–64 ASCII letters, digits or
hyphens, beginning and ending with a letter or digit. Incarnation,
registration and receipt identifiers are lowercase UUIDv4 values. The two
nonces are independently generated 32-byte CSPRNG values encoded as exactly
64 lowercase hexadecimal characters. Identifiers are not bearer credentials.
Register carries only `member_id`, `incarnation_id` and `registration_nonce`;
its result carries the first two fields and `registration_id`, without a nonce.
Probe request and response each carry exactly the member, incarnation,
registration nonce and `challenge`. The receiver compares the nonce without
content-dependent timing. A successful probe does not consume the pending
intent: only a validated registration result or local shutdown closes it.
Absent, closed or mismatched intents share `acp_probe_intent_mismatch` (409).

Registration uses the exact member/incarnation/nonce tuple as its idempotency
identity; no separate `Idempotency-Key` or new nonce is generated after an
uncertain result. Runtime Controller retains only a one-way nonce digest in
its durable registration. An authenticated exact retry may return that original
receipt without a new probe, including after the original start has stopped.
This is receipt recovery, not evidence that the caller is that running process.
A different nonce or platform binding cannot replace the original binding.

Inspection returns HTTP 200 with one closed shape: `running` has the registered
member/incarnation and `observed_at`; `unknown` has the registration identifier
and a reason, without any stop receipt; `stopped` has the registered binding and
one immutable `stop_receipt` containing a receipt identifier, reason and first
observation time. The outer registration/member/incarnation fields bind that
receipt, so consumers retain the complete response. Timestamps are UTC RFC3339
diagnostics and never establish a lease, deadline or proof by age. Consumers
validate actual calendar dates as well as the schema's lexical form.

Unregistered identifiers return `unknown/unregistered` without querying the
platform. Platform failure, changed engine or missing membership likewise return
`unknown`; inability to read the registry is a typed retryable 503. An HTTP
404, malformed response or transport failure never implies `stopped`.
Authenticated stop receipts already persisted remain permanent facts, even
when a later platform observation is unavailable.

Each operation authenticates its exact workload caller before reading a body
or accessing platform/storage. JSON bodies are limited to 4 KiB and replies to
8 KiB; registration and inspection have a 10-second total deadline, and a
single probe has a 2-second total deadline within its caller's remaining budget.
The deadlines cover response-body reads and actual cancellation/join, not just
headers. No operation follows redirects or environment proxies. All responses
use `Cache-Control: no-store`; payload capture is disabled for requests,
responses and errors, including Trace diagnostics. Logs never include nonces,
credentials, Docker identities or configured probe addresses.

Producer batches add their exact caller-catalog entries with actual HTTP,
authorization, platform, persistence and cancellation rejection tests. Existing
Controller-only RPC grants and public ACP routes remain unchanged until those
explicit batches are delivered.
Probe destinations stay inside the trusted membership catalog and authenticated
transport; no request can choose a URL, redirect, Docker selector or credential.

## Platform Stop Facts

An incarnation stop receipt permanently identifies one registered process start.
Runtime Controller may record it only after authoritative observation of that
exact start's termination: the registered container is stopped, the same full
container ID has a different start instance, or the registered container is
confirmed removed from the same Docker engine. An unregistered 404, a changed
or unavailable engine, cached health, missing membership or a failed inspection
returns `unknown`, never `stopped`.

The registration binds a full container identity, not a reusable name or IP.
A replacement using the same member, name, address or container ID cannot turn
an old incarnation back into a live one. Runtime Controller persists the first
accepted stop receipt and returns it idempotently; subsequent transient platform
failures cannot erase it. The receipt exposes no Docker identity or credentials
to ACP's public surfaces.

ACP verifies the authenticated response and exact opaque registration binding.
Under the current Agent fence it records which original Run/incarnation the
stop receipt covers. A caller-provided Boolean, new lease epoch, different
member's stop result or unbound historical receipt is insufficient.

## Live Owner Handoff

An owner that loses a lease immediately closes that scope to admission and
further effect dispatch. Its old immutable context stays lost even if an acquire
or renewal response arrives later. Other Agents in the process continue under
their own contexts.

The old owner aborts and actually joins the original admission, executor,
permission, output and cleanup handles. An owner-peer handoff response may
confirm completion only after those handles settle and that generation is
permanently closed to dispatch. The later peer contract must authenticate the
exact original incarnation and bind the response to organization, Agent, Run,
epoch and original Runtime binding. An empty local slot alone is insufficient.

The current owner validates and persists that receipt under its current fence.
The old owner receives no exception allowing stale-fence terminal, permission
or cleanup writes. A failed or unjoined handoff retains the reservation; a
finite service shutdown failure may terminate the process, after which the
platform stop-proof path applies. No failed join is reported as successful.

During graceful drain, new admission stops first. Lease renewal continues while
the original work is cancelled and joined. The coordinator joins in-flight
acquisition and renewal before releasing the exact leases, then releases the
global worker lock and closes storage. A shutdown budget expiry is a failure,
not a clean handoff receipt.

## Recovery And Runtime Effects

For predecessor handoff, only the current scope owner may recover the original
Run after accepting a valid executor stop proof. Same-incarnation, same-epoch
single-Run persistence recovery still uses that Run's actual join; it does not
require stopping the entire process or retiring its Agent generation.
Handoff recovery uses the new fence for every mutation, preserving
the original execution identity and historical snapshots. Pending recovery is
keyed by scope/epoch as well as Run, so an older reconciliation Promise cannot
be reused for a new owner.

Stopping an ACP process does not prove that remote Runtime effects stopped.
Recovery preserves `runtime_call_stopped=false`, temporary-skill protection,
unknown effects and the original Runtime binding. It then applies the existing
[Run recovery rules](execution-api.md#runtime-barrier-recovery-50-pending),
including terminal persistence and creation of the stable Runtime barrier in
one transaction. Runtime reconciliation remains separate from executor stop
proof; no proof authorizes replay of an uncertain effect.

### Durable Proof Consumption

The authenticated inspection happens outside the database transaction. The
consumer captures its inputs before waiting, then rechecks the current Agent
fence and the original target on the same transaction connection. A stopped
inspection must match all three original registration fields; the original
epoch comes from the immutable Run or claim, not from the inspection timestamp.
Running, unknown, malformed or mismatched inspections authorize no recovery.
The current incarnation cannot present its own stop receipt as a predecessor.

Persist the complete stopped response and its first acceptance without changing
it on retry. One registration cannot acquire a different receipt or binding,
and a receipt cannot be reused for another registration. Associate the receipt
with the exact original Run or claim and record the recovering authority
separately. Ordinary writers retain their original-owner checks. This dedicated
recovery path is not a new authority mode available to ordinary repositories.

A current owner may reuse the complete immutable stopped response already
accepted for the same original registration, including one first accepted while
recovering another Agent. Revalidate its full original binding under the current
scope fence; do not make another Controller inspection a condition of using that
permanent fact. Each target still needs its own fenced recovery transaction and
original-work association.

Run recovery locks organization, current lease, Session, Run and child records
in that order. Proof association, permission cancellation, interrupted Tool
events, terminal persistence and any stable Runtime barrier commit atomically.
An admitting Run is rejected without accepting its Prompt; a running Run uses
the existing restart outcome rules. Historical owner, execution snapshot and
unknown Runtime effects remain unchanged. Retrying a committed recovery does
not append events, charge usage or recreate a retired barrier. A stale current
fence or any failed child write rolls back the entire recovery transaction.

### Predecessor Learning Reviews

For a claimed running or paused review, valid stop proof permits a dedicated
recovery transaction to set `cancelled` with `cancel_reason=worker_lost`.
This closes the local review permanently; it does not resume the old claim or
requeue the same source. Preserve the original claim, generation, owner tuple,
policy, review attempts, evidence, candidate and maintenance history.

Change only `reserved` model-call records to `unknown`. Keep settled usage,
reservation amounts and their original accounting dates. Unknown costs continue
to count against the existing daily budget; recovery cannot refund them, invent
usage or replay the original inference. Lock the organization barrier, current
lease, the same global review-admission lock, task and child records in that
order. Only the committed
cancellation releases the global running slot. New completed sources may then
be reviewed under the existing quiet-period, cooldown and budget rules.

Cancelling a review is not a maintenance receipt. Pending or unknown installs
retain their exact request body, candidate and original Runtime binding. The
same recovery transaction creates protection for that intent's own Runtime,
which may differ from the source Run's Runtime. Other scope cleanup cannot
retire a barrier while that protection remains. Only a valid replacement
publication after Runtime isolation can admit new work on a new binding; Agent
closure, a same-revision publication or a model-cost record cannot stand in for
that isolation. Pure unknown model cost does not itself keep a stopped local
executor or an unrelated Agent busy.

These are consumer requirements. Run recovery, Learning recovery, startup
availability, Runtime barrier consumers and real handoff integration are
separate delivery evidence; one completed storage writer is not the workflow.

## Delivery And Admission

1. Freeze this shared stop-proof contract and the exact producer wire contract.
2. Deliver Runtime Controller registration/inspection with platform identity,
   authorization, persistence and replacement-race component tests.
3. Deliver ACP's private probe and registration consumer, production owner
   coordinator, fenced writers, scoped recovery and durable occupancy/settlement.
4. Deliver authenticated owner forwarding and live handoff, then deployment
   membership. Preserve existing connection cleanup and revocation boundaries.
5. Run two real ACP replicas: independent Agents on both; a held live old owner
   cannot be falsely marked stopped; kill one exact registered process; after
   lease expiry the other obtains platform stop proof and recovers its Runs by
   #50 without replay. Confirm stale writes fail and real resources are cleaned.

Unit, contract, component and applicable Docker E2E gates remain necessary for
each owning-service batch. Planned interfaces and primitive-only tests do not
complete #49. Span/Trace diagnostics remain auxiliary.
