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

Trace collection and strict inspection are auxiliary for every request and
lifecycle operation. Raw errors, missing parents, incomplete or invalid evidence
are retained as diagnostics. Budget exhaustion is reported as not collected;
in-flight collection is cancelled and joined. No Trace result blocks the next
fault injection, business acceptance or cleanup.

Confirmed external SDK defects are non-blocking under the repository policy;
retain their diagnostics without investigation or workaround. Internal service
logic and business recovery requirements still apply.

Private Trace checks reuse the existing ACP collector and the owning command,
Session, initialization and Runtime barrier inspectors. The recorder's original
inputs and results supply their expectations. Only the precise recorded barrier
rejection is projected from a failed RPC to the inspector's rejected outcome.
Attempted initialization and completed-request reports stay bound to their
original requests; interrupted requests never become completed evidence.
The final inventory contains 26 initializations, 40 completed business requests,
six interrupted diagnostics and four independent lifecycle operations.

### Physical deletion acceptance

The original successful Delete and joined client resources do not replace the
host's physical check. Both Runtime-scope container and volume inventories must
actually become empty before fallback teardown. The host waits at most 60 seconds,
capped by the original suite deadline, for asynchronous unreferenced-Skill cleanup.
It preserves every inventory read and original error, never deletes resources
during observation, and rejects persistent leftovers, failed reads, cancellation,
late empty results and failed evidence preservation.

## Verification order

Unit, contract and wire component checks run serially before the isolated Docker
integration. Trace evidence uses real propagated request identities.
