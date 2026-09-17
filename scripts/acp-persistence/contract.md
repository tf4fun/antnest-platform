# ACP persistence-fault migration

This follows the Controller-owned publication tracing fix and its separate
integration rerun. ACP owns Run intent, accepted input/snapshot, terminal facts
and startup interruption cleanup. No removed Controller admission RPC or table
is an oracle for these facts.

## Batch P1: committed database response loss

For each installed official ACP SDK version, lose exactly one successful
PostgreSQL result at each of three current boundaries: create Run intent,
accept input/snapshot, and persist the completed Run. The first two are explicit
COMMIT transactions; completion is one atomic auto-commit statement.

A fixture-only PostgreSQL wire proxy selects the exact Session and operation
(and exact Run for completion). It forwards real SQL to the disposable ACP
database, requires the real successful command tag and idle ReadyForQuery, then
holds the success result. It never writes/retries SQL or changes production
service behavior. It handles fragmented/coalesced PostgreSQL frames, tracks
transaction scope, rejects malformed/oversized protocol input, and exposes only
bounded identifiers/hashes. Authentication and SQL parameter values are never
logged. TLS is outside this isolated plaintext-database fixture contract.

While held, public Console audits must show the committed state, but ACP must
not proceed past the missing acknowledgement. Intent has no accepted message or
execution snapshot; acceptance has its immutable input/snapshot but no Provider
or Tool execution; completion already has the exact successful Run and Tool.
The proxy then drops only the selected socket. The real ACP service must stop
with exit code 1 on uncertain persistence; the host must observe that exit
before restarting the same owned container. No SIGKILL may substitute for this
fault. Startup cleanup fails admitting/running work honestly, never replays it,
and leaves a committed completed Run unchanged. Wait for current configuration
rehydration and readiness after every restart.

An unaccepted intent records state failed and
`service_restarted_before_execution`; its terminal/executor/effect fields remain
null because execution never started. Accepted interrupted work records an
actual failed/quiescent/none execution outcome. These distinct current storage
semantics must not be collapsed into one terminal tuple.

At completion, the execution slot must remain busy until the executor receives
the result. v1 cannot resolve its synchronous prompt early. v2 reads durable
Session output independently, so it may already emit the truthful persisted
`idle/end_turn` while the execution slot remains busy. If present, that state
must follow the completed Tool and saved answer exactly; a still-running
observer is also valid until its next read. Never equate observer delivery with
receipt of the executor's database acknowledgement.

Two reconnect replays per case must reproduce public persisted ordered message,
Tool and usage history with stable IDs and version-specific terminal state, with
no Provider/Tool execution. A subsequent real Bash Run proves execution recovers
and a physical marker is neither duplicated nor lost. Each failure class remains
distinct from successful completion. Audit queries are public read-only APIs;
the fixture client has no database or Docker access. Only the coordinator owns
process observation/restart and cleanup.

## Batch P2: process interruption and unknown Tool effects

After P1's local and deployed gates, migrate historical completed/model-held/
Tool-settled/Tool-in-flight restart scenarios. A physical marker and live PID,
not a delay or a database row alone, establish an in-flight Tool. Recovery must
preserve unresolved effects and reject new work until an explicit Rebuild
replaces the protected Runtime. Prove the original container is absent and the
audit remains unresolved after replacement. Keep Identity deactivation and
foreign access scenarios in their owning migration batch.

P2 uses fresh Sessions for four cases per SDK: a fully completed Run, a running
Run held at its first Provider response, a running Run held at the Provider
response after one completed Bash Tool, and one Bash call physically in flight.
Only P2 uses host SIGKILL, after its semantic barrier; exit 137, unchanged
container identity/restart count and a new healthy process must be observed.
Completed Run audits remain byte-for-byte equal. Known interrupted work becomes
failed/quiescent with `service_restarted_during_run` and effect none/settled.
In-flight recovery becomes unresolved/quiescent/unknown, source runtime_mcp and
`service_restarted_during_tool`; exactly one visible failed Tool update states
that its outcome is unknown. Preserve every prior public event and snapshot.

For unknown Runtime effects, public Agent execution state must be offline with
`runtime_barrier_required`. A prompt in another Session must fail with that
current domain error, with no Run or Provider request. There is no legacy
Controller admission/release event in this contract. Rebuild is verified through
its current public operation, Runtime operation journal, changed Runtime and
execution revisions, the original physical container's absence, and subsequent
ready state. Neither Rebuild nor a later successful Bash read may rewrite the
unresolved audit. Two reconnects per case and an additional reconnect after the
unknown-effect Rebuild must preserve history without execution. Physical reads
must return each marker exactly once, including the unknown call's marker.

Console deliberately excludes Runtime connection details from public execution
snapshots. Do not bypass that projection or require hidden fields. Correlate the
post-Rebuild public Run ID and observed execution revision to its actual Model
Trace context, whose Runtime revision/execution ID must match the replacement.
The ordinary Tool trace still proves the corresponding Runtime dispatch.

P1 cannot substitute for P2, and neither substitutes for browser or full protocol
acceptance. Unit/contract/wire component checks run serially before isolated
Docker integration. Use real propagated request identities for Trace evidence;
abrupt process failure can lose unexported spans, which must be reported rather
than invented. P2 is an opt-in crash-recovery profile, not a normal-request
Trace completeness gate. Its six intentionally interrupted requests report
`strict_trace=not_applicable` and diagnostic completeness, raw error spans,
warnings and unresolved parent IDs. Missing or unfinished crash spans do not
fail recovery acceptance; observed exit 137, public recovery audits, replay,
effect protection and replacement proof remain mandatory. Trace identity,
privacy and malformed evidence checks still apply. Missing diagnostic trace
data is reported as unavailable, not as a fabricated complete trace.

Completed requests and lifecycle operations retain strict topology, privacy,
error and warning checks. Their spans must finish and reach the backend before
the next fault or teardown; use bounded polling of the required evidence rather
than assuming a fixed five-second sleep guarantees visibility. P1's error
classification and other profiles remain unchanged. Retire an old helper only after its last mapped consumer has evidence
and all owned resources have been removed.

In P2, archive completed setup, replay, denial and ordinary-execution request
traces before the next SIGKILL. A failed export blocks the next injection.
Collect the interrupted request itself from the actual propagated Model trace
ID after the fault; missing active spans remain missing. This prevents a later
fault from destroying unrelated completed-request evidence without manufacturing
completion for the intentionally interrupted Run.
