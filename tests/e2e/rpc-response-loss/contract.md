# Current RPC response-loss acceptance

This fixture-only integration batch replaces the retired acquire-run/finish-run
profile. Controller now calls ACP apply-execution-snapshot and settle-agent;
ACP owns Run admission, durable completion and replay. No service implementation
or production fault switch is changed.

For each installed ACP SDK version:

1. Hold the complete successful acknowledgement of a newly published Model
   configuration. ACP must already use the new parameters, while Controller's
   persisted acknowledgement remains behind. Drop the connection; the existing
   publication worker must resend current configuration and persist a real ack.
2. Hold a successful settlement reply for the exact Rebuild operation. Controller
   must remain in drain with its old Runtime despite ACP having settled. Drop
   the reply; Temporal retries the operation with its original deadline, mode
   and configuration boundary. Only a delivered acknowledgement permits rebuild.
3. Existing completed Run/Tool/history snapshots remain unchanged. Two reconnect
   replays execute nothing. A subsequent real Bash read sees exactly one marker
   written by the prior Run, including after Runtime replacement. A closed Agent
   rejects new work without storing an intent. ACP must not restart for a lost
   Controller acknowledgement.

The proxy targets exact organizations/revisions or Agents, records only bounded
non-secret identities and hashes, and holds only after a validated upstream 200.
Zero downstream headers/body precede drop. It never retries an upstream request.
Component tests cover negative selection, invalid/non-success acknowledgements,
disconnect/timeout and real socket behavior. All verification is serial.

Trace evidence correlates actual propagated HTTP CLIENT IDs with ACP SERVERs,
current driver persistence and Temporal retry activities. Expected injected
transport errors must match those receipts. Unrelated errors fail. Clock warnings
and lifecycle Docker absence-probe ERROR spans remain strict failures.

Publication attempts must now own a recording
`agent_controller.execution_publication` span and their actual source SELECT.
A dropped reply must have no acknowledgement SQL or success attribute; the
delivered retry must own exactly one acknowledgement UPDATE. Missing or foreign
writes fail. The [Controller follow-up](../../../docs/controller-publication-trace-revalidation.md)
closed the original `controller_publication_ack_sql_missing` gap without changing
global background SQL collection. Strict timing and probe errors remain failures.

The old ACP fail-stop/retry of Controller admission tickets has no current RPC
equivalent. Database commit-receipt loss and interrupted Run recovery belong to
the remaining ACP persistence fault batch; this integration does not claim them.
Cold credential rehydration is separately covered by the existing ACP restart
batch. Retire only obsolete RPC-owned assets after current scoped evidence and
owned-resource cleanup; keep shared helpers with remaining consumers.
