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

The protocol client uses the private workspace listener with the original
owner's Identity delegation, and reads execution state through the authenticated
private state reader. It does not use the retired Gateway ACP or state routes.
The Controller alone uses the fault proxy; private client traffic bypasses it.

The four cases own exactly 12 connections/initializations and 22 business
requests: four new Sessions, eight completed prompts, eight load/resume replays
and two closed-admission rejections. Each request retains its original parameters,
SDK result/error, request ID, raw response and connection/Agent/Session/protocol
identity. Connections and telemetry must finish before final evidence is accepted.
Every Rebuild read binds its public Run to the replacement Runtime.

A closed-admission prompt returns exactly `-32020` with
`{code: "agent_unavailable", retryable: false}`. Its private Trace contains the
RPC, its application span and four ordered SELECTs (Session authorization,
client MCP revision, temporary scopes, Session reread). There is no protection
query, transaction, write, Run, Provider or Runtime call. The single application
DomainError event owns the RPC error origin; it is preserved as an expected
strict failure, not rewritten as a successful Trace.

Private initialization, Session and ordinary-prompt collection reuses the
existing inspectors and stable-source collector. Raw diagnostics remain in the
report. Confirmed external SDK issues are non-blocking under repository policy;
this consumer adds no SDK investigation or workaround. The existing accepted
CLI exit code remains zero, rejected evidence remains one.

Trace evidence correlates propagated HTTP CLIENT span IDs with ACP SERVER spans,
driver persistence spans and Temporal retry activities. Expected injected
transport errors must match the recorded receipts; any other error fails.

Trace collection must not accept repeated incomplete snapshots as converged.
All same-trace synchronous parents must be present, followed by three stable
span-ID samples within the existing 40-query limit. Missing parents at the limit
fail admission. Diagnostic reads after a failure preserve the original snapshot
and cannot turn that failure into a pass.

Each publication attempt must own a recording
`agent_controller.execution_publication` span and its source SELECT. A dropped
reply must have no acknowledgement SQL and no success attribute; the delivered
retry must own exactly one acknowledgement UPDATE. Missing or foreign writes
fail. Clock warnings and Docker absence-probe ERROR spans are strict failures.

## Out of scope

ACP database commit-receipt loss belongs to the
[ACP persistence components](../../integration/agent-acp-service/support/persistence/README.md).
Interrupted-Run recovery and cold credential rehydration after an ACP restart belong to the
[ACP restart scenario](../acp-restart/README.md).
