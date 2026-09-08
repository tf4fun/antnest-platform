# Principal Revocations

Identity deactivation must eventually disable the owner's Agents and Runtime,
retaining their data. Access denial alone is not offboarding. Identity restoration
does not enable Agents; administrators must explicitly enable them afterwards.

## Producer Contract

`POST /rpc/identity/list-principal-revocations` is trusted internal RPC, not a
Gateway/public route. Request: `after_sequence` (required, >= 0), `limit`
(required, 1..500). Response: `events` ordered by increasing `sequence`, and
`next_sequence` equal to the last returned sequence, or the requested cursor
for an empty page. Start at zero; repeat requests safely; an empty page means
caught up, not end of stream. Consumers persist their own progress.

Each event contains `sequence`, `user_id`, `reason`, `occurred_at`, optionally
`organization_id` and W3C `traceparent`. No profile, email, token or credential
payload is exposed. The sequence identifies an immutable fact, not a User
revision. Reasons and scope are:

| Reason | Scope | Trigger |
| --- | --- | --- |
| `user_deactivated` | all organizations; organization_id absent | global User active -> inactive |
| `membership_deactivated` | specified organization | local or SCIM Membership active -> inactive |
| `membership_deleted` | specified organization | SCIM Membership tombstoned |

No event is emitted for login, profile/role/group changes, restoration, or an
unchanged inactive value. A delete following inactivity is a distinct fact.
Quick restoration does not retract a previously committed revocation.

Identity owns `principal_revocations` in its private database. Mutation, audit
and revocation commit atomically. Producers take a transaction-scoped exclusive
writer lock on this table **before allocating the sequence**, after other
mutation writes. Thus a committed higher sequence cannot overtake an uncommitted
lower sequence. Rollbacks may leave gaps. Ordinary `identity_events` sequences
have no such guarantee and are not a consumer cursor. Feed rows are retained;
this phase has no pruning or cross-service database access.

## Controller Consumer Batch

Agent Controller will own durable consumption and reuse the normal asynchronous
disable lifecycle. A notification is not proof of Runtime shutdown. Preserve
pending work across busy/provisioning/rebuilding states and drain failures;
record the source sequence and trace context in lifecycle/audit correlation.
Identity access checks remain authoritative while delivery is delayed.

The read-only design review identified two consumer prerequisites: a durable
owner revocation boundary shared with Agent creation/explicit enable, and a
stop constraint that disable-failure compensation cannot undo. A feed scan
alone misses creation committed after the scan; rechecking current `active`
alone loses rapid deactivate/reactivate history. The consumer batch must define
an authoritative authorization watermark (read atomically with current Identity
state), freeze it on create/explicit enable, and compare it with received
revocations. Ordinary login or rebuild must not advance that authorization.
Do not compare clocks across services or equate a failed disable with success.

The consumer must cover creation/admission overlapping revocation, scoped owner
matching, duplicate delivery, restart, and rapid deactivate/reactivate. It must
not disable another organization's Agents or revoke shared Model Profile
credentials. Already-admitted Runs drain under the existing disable contract;
this is not emergency cancellation. Terminal failures remain visible and
retryable rather than being silently acknowledged as completed offboarding.

## Delivery Batches

1. Identity: transactional feed, bounded RPC, service tests and documentation.
2. Agent Controller: durable consumption, lifecycle convergence, race tests.
3. Integration: Gateway -> Identity -> Agent/Runtime disabled, retained data,
   scoped restoration, interruption recovery and Jaeger causal links.

Producer completion alone does not complete the business workflow.
