# ACP Connection Admission And Partitioned Ownership (#49)

This document defines shared connection quota requirements and the delivery
order. The ACP transport implements the replica-local quotas and cleanup
ownership below. The execution directory uses immutable Agent-indexed snapshots,
with a recorded application admission benchmark. Complete Phase 1 remote
acceptance and durable partitioned ownership remain separate gates; these
changes do not enable multiple replicas, change the ACP protocol, or complete #49.

## Scope And Configuration

Initial ACP v1 HTTP connections and ACP v1/v2 WebSocket connections share one
ACP process-level quota owner. The three limits apply together:

| Scope                                               | Environment variable                        | Default |
| --------------------------------------------------- | ------------------------------------------- | ------- |
| All counted ACP connections in the process          | `ANTNEST_ACP_MAX_CONNECTIONS`               | 1024    |
| One organization in the process                     | `ANTNEST_ACP_MAX_CONNECTIONS_PER_ORG`       | 256     |
| One `(organization, principal)` pair in the process | `ANTNEST_ACP_MAX_CONNECTIONS_PER_PRINCIPAL` | 64      |

Each configured limit must be a positive safe integer, from 1 through 9007199254740991. The effective limits must satisfy
`principal <= organization <= global`; invalid values or ordering fail startup.
These are Phase 1 replica-local limits. They are not cluster-wide quotas, and
running additional replicas must not be described as preserving a cluster-wide
1024/256/64 capacity bound.

## Identity And Existing Admission Gates

Only verified workload authentication and the trusted CCT organization and
principal select quota buckets, following the existing
[ACP authentication contract](service-authentication.md). The principal bucket
is scoped by both organization and principal, across that principal's Agents.
Request bodies, unsigned headers and identity hints cannot select or change a
bucket. Quotas grant no new caller, route or organization authority.

Authentication, current Agent/Session authorization, and the existing Agent
preparing and Runtime barrier gates retain their existing boundaries. Quota
admission does not replace any of them or infer readiness from Runtime health.
Rejection must not expose another tenant's identity, bucket, usage or inventory.

## Quota Rejection

Exceeding any limit rejects the initial HTTP connection or WebSocket handshake
before admitting a new ACP connection. The response is HTTP 429, before any
WebSocket upgrade, with these headers:

```http
Content-Type: application/json
Cache-Control: no-store
Retry-After: 1
```

The JSON response is flat and contains exactly:

```json
{
  "code": "connection_quota_exceeded",
  "message": "Connection capacity is exhausted",
  "retryable": true,
  "retry_after_ms": 1000
}
```

The error catalog classification is `class: resource`, `json_rpc_code: null`,
`http_status: 429`, `surfaces: ["http"]`, `retryable: true`,
`retry_after_ms: 1000`, and `recovery: backoff`, with the same fixed message.
It is an HTTP connection admission error, not a JSON-RPC method response.
The [existing error catalog](errors.json) and its schema retain their current
roles; this document adds no schema or implementation.

After the indicated delay, a caller may retry establishing a connection.
This response does not authorize replay of any Prompt, model call or tool call,
including work with an unknown outcome. Exceeding capacity must not evict an
existing connection, create a Session or Run, or start another effect.

## Reservation Ownership And Release

An admitted initial connection atomically reserves one global, organization and
organization/principal unit. Either all three reservations succeed or none do.
A rejected reservation leaves no increments or orphan buckets.

HTTP GET, POST and DELETE for an existing connection ID use that original
reservation without charging again. A full quota must not prevent the existing
connection's authenticated cleanup from completing. The
[private HTTP transport retirement rules](service-authentication.md#private-http-transport-retirement)
continue to apply: pending cleanup, retained acknowledgements and already
admitted responses retain capacity until their real ownership ends. Removing
an ID or writing an acknowledgement does not release its reservation while
cleanup or an admitted response remains unjoined. Cancellation and expiry do
not permit early release. Initialization failure releases its reservation only
after its owned cleanup has actually joined, without leaving empty buckets.

A WebSocket reservation remains counted until the actual connection closes and
its owned cleanup joins. A close request or an in-memory closed flag is not a
completion receipt. Repeated close/cleanup notifications must not release a
reservation twice. These quotas count transport ownership, not Sessions or Runs.

## Delivery Order

Each owning-service batch requires its own tests and documentation before the
explicit integration batch. Local producer checks do not establish complete
Phase 1 or multi-replica acceptance.

1. Freeze the shared quota contract and error classification before consumers
   or producers implement it.
2. ACP Phase 1: use immutable snapshots indexed by Agent for admission reads,
   removing whole-organization read serialization and cloning while preserving
   publication-versus-admission, revocation and ACP ACK fences. Implement the
   shared HTTP/WebSocket quotas above. Record an actual admission benchmark
   with 1, 100 and 1000 Agents in one organization; a lookup-only microbenchmark
   does not establish flat admission latency.
3. ACP Phase 2: enforce the durable one-active-Run-per-Agent invariant. A real
   PostgreSQL component test must submit concurrently from two processes for
   the same Agent and observe exactly one success and one canonical
   `agent_busy`. This does not by itself prove full multi-replica operation.
4. ACP Phase 3: implement leases and epochs, fence every owned write, make
   publication consistent across replicas, scope recovery to the owned or
   expired Agent, and provide internal owner forwarding. The detailed peer
   protocol and its authorization are to be frozen in a separate contract
   batch; this document does not invent them. Implement and validate these
   ownership guarantees before removing the database-wide worker lock last.
   Graceful shutdown must stop new admission, drain within the existing budget,
   and join owned work before handing off ownership.
5. Run explicit two-replica Docker integration after those service stages:
   distribute different Agents across both replicas, kill one replica, recover
   ownership after lease expiry, and verify the recovered Run behavior under
   #50 without replaying uncertain effects. Prove actual process, connection
   and resource cleanup. Span/Trace diagnostics remain auxiliary; business,
   authorization, persistence, Runtime behavior and actual cleanup are hard gates.

## Original #49 Acceptance Status

All five original criteria remain pending until their complete delivery gates
pass. Local application benchmark and quota evidence do not replace the final
candidate's complete remote checks.

| Original criterion                                                                                                       | Status  | Evidence still required                                                            |
| ------------------------------------------------------------------------------------------------------------------------ | ------- | ---------------------------------------------------------------------------------- |
| Phase 1 flat admission latency at 1/100/1000 Agents and a typed per-organization quota rejection                         | Pending | Final remote admission of the recorded application benchmark and transport quotas  |
| Phase 2 two-process, same-Agent PostgreSQL admission gives one success and one `agent_busy`                              | Pending | Real concurrent PostgreSQL component evidence from two processes                   |
| Phase 3 two ACP replicas distribute Agents and survive a replica kill through lease expiry, following #50 recovery rules | Pending | Explicit two-replica Docker kill/handoff, Run/effect and actual cleanup evidence   |
| Stale-epoch writes are rejected                                                                                          | Pending | Component evidence for the owned write fences                                      |
| ACP architecture and operations docs describe scaling and lease tuning and retire the old single-process restriction     | Pending | Owning-service documentation matched to the implemented and admitted scaling model |
