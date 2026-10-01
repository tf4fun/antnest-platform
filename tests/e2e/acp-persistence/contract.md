# ACP persistence and interruption contract

This document defines the recovery obligations for ACP-owned Run persistence.
ACP owns Run intent, accepted input and execution snapshot, terminal facts and
startup interruption cleanup. Controller tables are not an oracle for any of
these facts. The first section is verified by the
[ACP persistence scenario](README.md); the second by the
[ACP restart scenario](../acp-restart/README.md). Neither substitutes for the
other, and neither substitutes for browser or full protocol tests.

## Committed database response loss

For each installed official ACP SDK version, exactly one successful PostgreSQL
result is lost at each of three boundaries: create Run intent, accept input and
snapshot, and persist the completed Run. The first two are explicit COMMIT
transactions; completion is one atomic auto-commit statement.

### Proxy rules

A fixture-only PostgreSQL wire proxy selects the exact Session and operation
(and the exact Run for completion). It forwards real SQL to the disposable ACP
database, requires the real successful command tag and idle ReadyForQuery, and
then holds the success result. It never writes or retries SQL and does not
change production service behavior. It handles fragmented and coalesced
PostgreSQL frames, tracks transaction scope, rejects malformed or oversized
protocol input, and exposes only bounded identifiers and hashes. Authentication
and SQL parameter values are never logged. TLS is outside this isolated
plaintext-database fixture.

### Required behavior

- While the result is held, public Admin Console audits must show the committed
  state, but ACP must not proceed past the missing acknowledgement. Intent has
  no accepted message or execution snapshot; acceptance has its immutable input
  and snapshot but no Provider or Tool execution; completion already has the
  exact successful Run and Tool.
- The proxy then drops only the selected socket. ACP must stop with exit code 1
  on uncertain persistence, and the host must observe that exit before
  restarting the same owned container. SIGKILL may not substitute for this
  fault.
- Startup cleanup fails admitting or running work honestly, never replays it,
  and leaves a committed completed Run unchanged. The test waits for
  configuration rehydration and readiness after every restart.
- An unaccepted intent records state `failed` with
  `service_restarted_before_execution`; its terminal, executor and effect fields
  stay null because execution never started. Accepted interrupted work records
  a `failed/quiescent/none` execution outcome. These two storage semantics must
  stay distinct.
- At completion, the execution slot stays busy until the executor receives the
  result. v1 cannot resolve its synchronous prompt early. v2 reads durable
  Session output independently, so it may already emit the persisted
  `idle/end_turn` while the slot is still busy. If present, that state must
  follow the completed Tool and saved answer exactly; a still-running observer
  is also valid until its next read. Observer delivery never implies that the
  executor received its database acknowledgement.
- Two reconnect replays per case must reproduce the persisted ordered message,
  Tool and usage history with stable IDs and version-specific terminal state,
  without Provider or Tool execution. A later real Bash Run proves execution
  recovers and a physical marker is neither duplicated nor lost.

Audit queries use public read-only APIs. The fixture client has no database or
Docker access; only the coordinator observes and restarts processes and cleans
up.

## Process interruption and unknown Tool effects

Each SDK version runs four cases in fresh Sessions: a fully completed Run, a
running Run held at its first Provider response, a running Run held at the
Provider response after one completed Bash Tool, and one Bash call physically in
flight. A physical marker and a live PID, not a delay or a database row,
establish that a Tool is in flight.

### Required behavior

- The host sends SIGKILL only after the semantic barrier. Exit code 137, an
  unchanged container identity and restart count, and a new healthy process
  must be observed.
- Completed Run audits remain byte-for-byte equal. Known interrupted work
  becomes `failed/quiescent` with `service_restarted_during_run` and effect
  `none` or `settled`.
- In-flight recovery becomes `unresolved/quiescent/unknown` with source
  `runtime_mcp` and `service_restarted_during_tool`. Exactly one visible failed
  Tool update states that its outcome is unknown. Every earlier public event
  and snapshot is preserved.
- With an unknown Runtime effect, public Agent execution state must be offline
  with `runtime_barrier_required`. A prompt in another Session must fail with
  that domain error and create no Run or Provider request.
- Rebuild is verified through its public operation, the Runtime operation
  journal, changed Runtime and execution revisions, the absence of the original
  container, and the subsequent ready state. Neither the Rebuild nor a later
  successful Bash read may rewrite the unresolved audit.
- Two reconnects per case, plus one more after the unknown-effect Rebuild, must
  preserve history without execution. Physical reads must return each marker
  exactly once, including the marker of the unknown call.

The Admin Console deliberately excludes Runtime connection details from public
execution snapshots, and the test must not bypass that projection. The
post-Rebuild public Run ID and observed execution revision are correlated with
the actual Model Trace context, whose Runtime revision and execution ID must
match the replacement.

### Trace rules

This is an opt-in crash-recovery profile, not a Trace completeness gate. The six
intentionally interrupted requests report `strict_trace=not_applicable` together
with diagnostic completeness, raw error spans, warnings and unresolved parent
IDs. Missing or unfinished crash spans do not fail recovery, but exit 137,
public recovery audits, replay, effect protection and replacement proof are
mandatory. Trace identity, privacy and malformed-evidence checks still apply,
and missing diagnostic data is reported as unavailable.

Completed requests and lifecycle operations keep strict topology, privacy,
error and warning checks. Their spans must finish and reach the backend before
the next fault or teardown; the test polls for the required evidence rather than
relying on a fixed sleep. Completed setup, replay, denial and ordinary execution
Traces are archived before the next SIGKILL, and a failed export blocks the next
injection. The interrupted request is collected afterwards from its propagated
Model Trace ID; missing active spans remain missing.

## Verification order

Unit, contract and wire component checks run serially before the isolated Docker
integration. Trace evidence uses real propagated request identities.
