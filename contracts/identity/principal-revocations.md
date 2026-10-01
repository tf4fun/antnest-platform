# Principal Revocations

This document defines the Identity Service revocation feed and the owner
authorization query that Agent Controller consumes to disable a deactivated
principal's Agents.

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
and revocation commit atomically. After its other mutation writes, a producer
runs `LOCK TABLE principal_revocations IN SHARE ROW EXCLUSIVE MODE` inside the
transaction **before allocating the sequence**. That lock mode conflicts with
itself, so revocation writers are serialized and a committed higher sequence
cannot overtake an uncommitted lower sequence. Rollbacks may leave gaps.
Ordinary `identity_events` sequences have no such guarantee and are not a
consumer cursor. Feed rows are retained; there is no pruning or cross-service
database access.

## Controller Consumer

`POST /rpc/identity/resolve-owner-authorization` accepts `user_id` and
`organization_id`. It returns `authorization` containing those IDs,
`membership_id`, `active`, and `last_revocation_sequence` (zero if none).
Activity and the latest applicable global/organization revocation are read in
one PostgreSQL statement snapshot. Missing/tombstoned membership is `not_found`.
No administrator bypass, credential or profile is included. Restoration never
reduces this watermark. This internal query is for explicit create/enable
authorization, not an OAuth token or a subscription cursor.

Agent Controller owns durable consumption and reuses the normal asynchronous
disable lifecycle. A notification is not proof of Runtime shutdown. Pending
work is preserved across busy/provisioning/rebuilding states and drain
failures; the source sequence and trace context are recorded in lifecycle and
audit correlation. Identity access checks remain authoritative while delivery
is delayed.

The consumer depends on two invariants: a durable owner revocation boundary
shared with Agent creation and explicit enable, and a stop constraint that
disable-failure compensation cannot undo. A feed scan alone misses creation
committed after the scan; rechecking current `active` alone loses rapid
deactivate/reactivate history. Controller therefore freezes the authorization
watermark (read atomically with current Identity state) on create and explicit
enable, and compares it with received revocations. Ordinary login or rebuild
does not advance that authorization. Clocks are never compared across
services, and a failed disable is never treated as success.

The consumer handles creation/admission overlapping revocation, scoped owner
matching, duplicate delivery, restart, and rapid deactivate/reactivate. It
never disables another organization's Agents or revokes shared Model Profile
credentials. A revocation-driven disable settles ACP execution in `cancel`
mode: already-admitted Runs are cancelled rather than drained, within the
lifecycle drain deadline. Terminal failures remain visible and retryable
rather than being silently acknowledged as completed offboarding.

## Recovery Semantics

Controller catches up from its persisted cursor after restart, including
revocations created while it was stopped. Restoration and SCIM reprovisioning require an explicit Enable before
new Runs start; retained workspace data stays readable. No product service
accesses another service's tables.
