# RPC response-loss contract

This document defines the recovery obligations that the
[RPC response-loss scenario](README.md) verifies. The Agent Controller calls the
ACP service's `apply-execution-snapshot` and `settle-agent` endpoints; ACP owns
Run admission, durable completion and replay.

## Obligations

For each installed ACP SDK version:

1. **Publication acknowledgement loss.** Hold the complete successful
   acknowledgement of a newly published Model configuration. ACP must already
   use the new parameters while the Controller's persisted acknowledgement
   remains behind. After the connection drops, the existing publication worker
   must resend the current configuration and persist a real acknowledgement.
2. **Settlement reply loss.** Hold a successful settlement reply for the exact
   Rebuild operation. The Controller must remain in `drain` with its old
   Runtime even though ACP has settled. After the reply drops, Temporal retries
   the operation with its original deadline, mode and configuration boundary.
   Only a delivered acknowledgement permits the rebuild.
3. **No duplicated work.** Existing completed Run, Tool and history snapshots
   remain unchanged. Two reconnect replays execute nothing. A later real Bash
   read sees exactly one marker written by the earlier Run, including after
   Runtime replacement. A closed Agent rejects new work without storing an
   intent. ACP must not restart because of a lost Controller acknowledgement.

## Proxy rules

The fixture proxy targets exact organizations, revisions or Agents, records only
bounded non-secret identities and hashes, and holds a response only after a
validated upstream HTTP 200. No downstream headers or body bytes are sent before
the drop. It never retries an upstream request. Component tests cover negative
selection, invalid and non-success acknowledgements, disconnects, timeouts and
real socket behavior.

## Trace rules

Trace evidence correlates propagated HTTP CLIENT span IDs with ACP SERVER spans,
driver persistence spans and Temporal retry activities. Expected injected
transport errors must match the recorded receipts; any other error fails.

Each publication attempt must own a recording
`agent_controller.execution_publication` span and its source SELECT. A dropped
reply must have no acknowledgement SQL and no success attribute; the delivered
retry must own exactly one acknowledgement UPDATE. Missing or foreign writes
fail. Clock warnings and Docker absence-probe ERROR spans are strict failures.

## Out of scope

ACP database commit-receipt loss and interrupted-Run recovery belong to the
[ACP persistence scenario](../acp-persistence/README.md). Cold credential
rehydration after an ACP restart belongs to the
[ACP restart scenario](../acp-restart/README.md).
