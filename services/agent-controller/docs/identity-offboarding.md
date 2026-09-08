# Identity-triggered Agent offboarding

Identity owns authentication and the ordered principal-revocation feed. Agent
Controller consumes that RPC feed and owns the resulting Agent lifecycle. It
never reads Identity tables. This is a narrow consumer, not a general event bus.

## Business contract

- A global User deactivation stops that user's Agents in every organization.
  Membership deactivation/deletion stops only Agents in that organization.
- Receipt durably fences new Run admission. An idle, available Agent enters the
  existing Disable saga: drain admitted work, close network, disable Runtime,
  then publish `disabled` only with the existing Runtime effect proof.
- Work already admitted retains its frozen snapshot and completion/replay
  contract. This is eventual offboarding, not emergency process cancellation.
- Busy lifecycle operations finish through their existing recovery worker.
  The offboarding intent survives them. Failed/unavailable or uncertain Runtime
  states remain fenced and pending; they are not reported as successfully stopped.
- Identity restoration does not re-enable an Agent. Explicit Enable requires a
  fresh active-owner authorization snapshot and a completed disabled source.
- No Agent, workspace, history, or shared provider credential is deleted/revoked.

## Durable boundary

`identity_revocation_cursor` stores receipt progress. `owner_revocations` stores
the latest revocation per `(user_id, organization_id)`; an empty organization
denotes the global scope. They belong exclusively to `agent_controller` schema.
The source feed remains the detailed identity history, so no duplicate inbox is
needed. Cursor advancement, scope update, Agent fence, and Agent event append
commit together.

Each Agent captures `owner_authorization_sequence` on Create or explicit Enable
using Identity's atomic `resolve-owner-authorization` RPC. Its independent
`identity_revocation_sequence` records the latest applicable consumed revocation.
A larger revocation sequence forbids new admission until explicit Enable.

Create/Enable and fresh admission take a shared lock on the receipt cursor before
locking an Agent. Receipt takes the exclusive lock. Thus a Create that passed
Identity before deactivation either commits before receipt and is fenced by it,
or observes the newer scope watermark and is rejected. An Agent explicitly
created after identity restoration is not stopped by an older delayed event.
No cross-service wall-clock comparison or distributed transaction is assumed.

## Execution and recovery

The consumer validates a complete bounded feed page before applying it. It then
scans local pending fences in bounded keyset pages, independently of source RPC
availability. Each pass receives at most 100 source events and examines at most
100 local candidates. The feed RPC has a five-second deadline (or the shorter
caller/client deadline); a stalled read cannot indefinitely starve local work.
The poll interval defaults to two seconds and is independently configurable.
It schedules ordinary Disable operations with a durable revocation
cause and deterministic request IDs; the lifecycle recovery worker executes them.
Running/unknown operations retain their original request IDs. A terminal failed
attempt leaves the fence intact and may be retried with a new operation.
Terminal failed offboarding attempts have a 30-second cooldown in the local
candidate query, preventing a failing dependency from generating a tight loop
of operations/events. Busy or unavailable candidates do not starve later pages.

Offboarding failure must never compensate by reopening the network or restoring
an enabled intention. The same restriction applies when a revocation arrives
during a previously requested manual Disable/rebuild. An already dispatched
external RPC can still finish; no instantaneous cross-service rollback is claimed.
Compensation rechecks the durable fence after reading Egress, before dispatching
an open request, and recloses if receipt committed during the successful RPC.
This is not a distributed lock: races after the last local check remain subject
to eventual Disable convergence.

Operators can inspect `identity_revocation_sequence > owner_authorization_sequence`
on Agent records for a pending owner stop constraint, then inspect its current
lifecycle operation and failure. A completed disabled Agent retains that
constraint until an explicit authorized Enable. Do not manually advance the
receipt cursor or remove scope rows: that discards the late-create protection.

## Observability and verification

Identity RPC calls carry dependency spans and bounded error metrics. Each consumed
revocation continues its source `traceparent`; its Agent event and Disable
operation retain this causality through the existing lifecycle tracing. Receipt
progress is not a claim that all Runtime shutdowns completed. Pending fences and
failed lifecycle operations remain inspectable in Controller storage/events.

Required service tests: scoped/global fencing, duplicate delivery, atomic cursor
rollback, late Create, restored/new authorization, fresh admission versus replay,
strict Disable failure, busy lifecycle convergence, source outage with local
pending work, restart/retry, and no automatic Enable. Full Gateway/Identity/ACP/
Runtime Docker and Jaeger acceptance is a separate integration batch.
