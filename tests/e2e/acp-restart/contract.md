# ACP process interruption contract

This contract belongs to the [ACP restart scenario](README.md).
ACP owns Run intent, accepted input, execution snapshots, terminal facts and
startup interruption cleanup. Controller tables are not an oracle for these
facts. Committed database response loss is covered separately by the
[ACP persistence components](../../integration/agent-acp-service/support/persistence/README.md).

## Private execution state

Restart reads the complete ACP-owned execution state through
`POST /rpc/agent-acp/get-agent-execution-state`, using the original owner's
browser session and its login Principal. Every read delegates that same session
through Identity's workspace profile and uses the Agent UI ACP workload grant.
Both Principal fields, the requested Agent and `access_allowed` must match.
The retired public Gateway state route and Bridge projections are not state
oracles for this protocol recovery scenario.

The complete response is archived privately before the read returns or fails.
Only the exact complete `execution_state_unavailable` startup 503 may be retried.
Other 503s, malformed or partial data, denied access, changed authority and
archive failures fail acceptance. Cancellation during read or archival is joined
and remains a failure; read and archive errors are both retained. A valid
`runtime_barrier_required` offline response must remain visible for the original
unknown-effect checks and must not be treated as startup recovery.

## Private ACP requests

Connections delegate the original owner login through the shared private ACP
opener. Its initialization is the only initialization on that connection.
Original inputs, SDK results and errors, raw replies and updates are privately
archived, including on failure. Request IDs are scoped to the actual connection;
the original input and returned Session, Agent and protocol must agree. No
request may borrow a reply from another connection or a local-close exception.

The eight cases require 26 connections/initializations and 46 business requests:
10 Session creations, 18 history replays, 16 execution prompts and two Runtime
barrier refusals. Each case uses its original connection and two reconnects;
the two in-flight cases add one reconnect after Rebuild. Interrupted v1 prompts
retain their original rejection; v2 prompts retain their original message ID
ACK, which does not establish completion. The host's SIGKILL proof remains
independent and mandatory.

Closure joins the transport and all pending request archives before the final
inventory is checked. Cleanup and archival errors remain visible alongside the
original business failure. The complete private inventory is preserved before
publishing success, and partial inventory is retained on failure.

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
- With an unknown Runtime effect, private Agent execution state must be offline
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

Confirmed external SDK defects are non-blocking under the repository policy;
retain their diagnostics without investigation or workaround. Internal service
logic and business recovery requirements still apply.

Completed requests and lifecycle operations keep strict topology, privacy,
error and warning checks. Their spans must finish and reach the backend before
the next fault or teardown; the test polls for the required evidence rather than
relying on a fixed sleep. Completed setup, replay, denial and ordinary execution
Traces are archived before the next SIGKILL, and a failed export blocks the next
injection. The interrupted request is collected afterwards from its propagated
Model Trace ID; missing active spans remain missing.

Private Trace checks reuse the existing ACP collector and the owning command,
Session, initialization and Runtime barrier inspectors. The recorder's original
inputs and results supply their expectations. Only the precise recorded barrier
rejection is projected from a failed RPC to the inspector's rejected outcome.
Every current connection's initialization is archived before the next SIGKILL,
even while that connection remains open. Completed request reports stay bound to
their original requests; interrupted requests never enter this success path.
The final inventory contains 26 initializations, 40 completed business requests,
six interrupted diagnostics and four independent lifecycle operations.

## Verification order

Unit, contract and wire component checks run serially before the isolated Docker
integration. Trace evidence uses real propagated request identities.
