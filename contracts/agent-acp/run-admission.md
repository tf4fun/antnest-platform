# Durable Agent Run Admission (#49 Phase 2)

This contract defines the ACP persistence invariant following the
[connection and indexed admission batch](connection-admission.md).
The ACP schema and Run repository enforce the reservation described below.
It does not claim that multiple ACP service replicas can start or recover Runs.
The database-wide worker lock remains until leases, fencing, forwarding and
two-replica recovery have their own implementation and acceptance evidence.

## Durable Scope And Reservation

At most one Run in state `admitting` or `running` may exist for one
`(organization_id, agent_id)`, across Sessions, principals, connections and
database clients. The database must enforce this invariant. The local
Supervisor slot remains an early rejection and execution-lifetime mechanism;
it cannot be the sole reservation authority.

A Run captures its organization and Agent from its locked `acp_sessions` row
when its intent is inserted. Callers do not supply additional scope fields to
`CreateRunIntentInput`. Session state and current Session configuration are
still read under the existing Session lock.

The persistence batch adds non-null `organization_id` and `agent_id` columns to
`runs`, backfills them from the referenced Session, and binds the tuple
`(session_id, organization_id, agent_id)` to that Session with a composite
foreign key. A Run cannot name an unrelated organization or Agent. Its public
identity, captured access revision, input, Bridge intent and execution snapshot
retain their existing meanings.

The partial unique index is named `runs_agent_nonterminal_unique`, keyed by
`(organization_id, agent_id)`, with predicate
`state IN ('admitting', 'running')`. It does not include principal, Runtime
revision, connection or Session in its key. Different Agents may be admitted
independently; identical Agent strings in different organizations do not share
a reservation.

## Rejection And Transaction Boundaries

The intent transaction retains the existing Session lock and rejection order:

1. Require an existing, active Session.
2. Preserve Bridge intent digest/idempotency decisions, expected append-version
   conflicts and append-version exhaustion checks.
3. Reject a current nonterminal Run for that same Session with `session_busy`.
   This decision must not depend on which of two unique indexes PostgreSQL
   happens to report first.
4. Insert the intent with the Session-derived organization and Agent. A conflict
   on `runs_agent_nonterminal_unique` returns canonical `agent_busy`.
5. Advance the Session append version in the same transaction only after the
   intent insertion succeeds.

Only SQLSTATE `23505` for that named Agent index maps to `agent_busy`; other
unique constraints, foreign-key failures and storage errors retain their own
classification. The existing Session index remains an independent guard.
`acceptRun` keeps its Session-then-Run lock order.

The [existing error catalog](errors.json) defines `agent_busy`: JSON-RPC code
`-32030`, HTTP status `409`, `retryable: true`, `retry_after_ms: 1000` and public
message `Agent already has an active Run`. No new error shape or public route
is introduced. A rejection must not reveal the other principal, Session or Run.
It must leave no new intent, visible message or append-version advancement.
The existing retry policy never authorizes replay of a recorded or uncertain
Prompt or effect.

## Reservation Lifetime And Recovery

The reservation survives connection loss, process exit and loss of an
acceptance receipt. Requesting cancellation sets the existing cancellation fact;
it does not release an `admitting` or `running` reservation. Only a committed
transition out of those states releases the unique-index reservation.

Terminal `unresolved` is not an active admission reservation. It also is not
evidence that Runtime effects have stopped. The existing Runtime barrier and
recovery rules remain independently blocking until their required evidence is
present. This batch does not retry an effect or rewrite an uncertain Run as a
successful or cleanly cancelled Run.

The migration preserves all historical Runs, input, messages, terminal facts
and references. If existing data contains multiple nonterminal Runs for the
same Agent scope, the migration fails atomically. It must not choose a winner,
delete facts or manufacture terminal outcomes to install the constraint.

## Required Evidence

Before the producer change, a real PostgreSQL component test must reproduce the
missing invariant with two independent Node processes, each with its own Pool
and repository. A ready/go barrier starts concurrent submissions for different
Sessions of the same organization and Agent. The final implementation must
return exactly one successful reservation and one `agent_busy`, with only the
winner's durable intent and append advancement.

Evidence must cover both `admitting` and `running`, retention after cancellation
and worker exit, and admission after a real terminal transition. The tests also
cover separate Agents, organization isolation, same-Session rejection priority,
Bridge intent conflicts, Session-derived scope, migration backfill and atomic
failure on historical duplicate active Runs. Child processes and Pools must be
bounded, stopped and joined on success, failure and interruption.

Service tests, the affected contracts and the exact candidate's complete remote
CI remain required. This component evidence proves durable admission only;
lease epochs, stale-owner write rejection and actual two-replica recovery remain
separate Phase 3 requirements.
