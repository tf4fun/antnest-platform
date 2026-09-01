# Runtime Egress Control API

Runtime Egress exposes a small JSON-over-HTTP RPC API to Agent Controller on a
trusted internal network. It performs no end-user authentication and carries no
Runtime generation, deployment-provider, Run, Tool, or Channel state.

All requests and responses use `application/json`. Unknown fields are rejected.
Agent identifiers and policy identifiers are opaque strings containing 1-255
visible ASCII bytes. IPv4 addresses are serialized in canonical
dotted-decimal form. IPv4 endpoints are objects containing `ipv4` and `port`,
not implementation-specific socket strings. Runtime Egress uses the exact
revision and fixed MTU defined by `../runtime/packet-contract.json`; the
revision is returned in each Runtime network attachment while MTU is never
negotiated through this API.

Control callers propagate W3C `traceparent` and optional `tracestate` headers.
Invalid trace context is ignored without rejecting the business request.
Runtime Egress does not accept `baggage` as part of its control contract.

This document describes control contract revision 2.

## Status

`GET /status`

```json
{
  "status": "ready",
  "data_plane_ready": true,
  "control_plane_ready": true,
  "snapshot_revision": 12
}
```

`status` is `ready` or `degraded`. The listener is opened only after cold-start
recovery and packet initialization complete, so an externally observable
`starting` state would be fiction. `/status` deliberately returns HTTP 200 in
both states; callers inspect `control_plane_ready` before issuing mutations.
When degraded, the last published packet snapshot may continue forwarding,
while control mutations fail with a retryable stable error.

## Agent Network

### Ensure

`PUT /internal/agent-networks/{agent_id}`

The request has no body. Address-pool selection and allocator versions are
private Egress implementation details. The operation is naturally idempotent:
an Agent with an active allocation receives the same allocation. If that Agent
is already fenced after an ambiguous mutation or cleanup failure, Ensure first
repeats userspace-flow and conntrack cleanup and reopens traffic only after the
durable assignment and packet snapshot have been reconciled.

```json
{
  "agent_id": "agent-1",
  "tunnel_ipv4": "100.64.0.2",
  "resolver_ipv4": "100.64.0.1",
  "packet_contract_revision": 1,
  "egress_endpoint": {"ipv4": "10.20.0.8", "port": 8092},
  "state": "active"
}
```

A new Agent is assigned the built-in deny-all policy
`(policy_id="builtin/deny-all", revision=1)` before the allocation is returned.
Allocation never exposes an address without a policy snapshot. This identifier
is part of the control contract; lifecycle clients must not invent an alias.

### Inspect

`GET /internal/agent-networks/{agent_id}` returns the same document. A missing
Agent returns `agent_network_not_found`.

### Fence

`POST /internal/agent-networks/{agent_id}/fence`

```json
{"expected_resource_version": 7}
```

Fence publishes deny-all, drains packet writers, clears userspace flows, and
clears matching conntrack before acknowledging. The resource version fences
the lifecycle mutation against a newer policy assignment. Repeating a fence
that already produced deny-all is idempotent; a stale fence cannot overwrite a
policy restored by a newer lifecycle operation.

### Reset Flows

`POST /internal/agent-networks/{agent_id}/reset-flows`

```json
{"expected_resource_version": 8}
```

Reset drains packet writers and clears userspace flows and matching conntrack
without changing the durable policy assignment. The request must name the
current deny-all assignment version. Agent Controller calls it after the old
Runtime is confirmed absent and before activating a candidate.

### Release

`POST /internal/agent-networks/{agent_id}/release`

```json
{"expected_resource_version": 8}
```

Release fences the Agent, completes flow and conntrack cleanup, and moves its
address into durable quarantine. The request must name the current deny-all
assignment version. Repeating release with that version returns the current
state. An address becomes allocatable only after its quarantine deadline and a
final cleanup check.

## Policy Revisions

`PUT /internal/policies/{policy_id}/revisions/{revision}`

```json
{"spec":{"schema_version":1,"action":"allow_all"}}
```

`revision` is a positive integer. A new revision is immutable. Repeating the
same `(policy_id, revision, canonical spec)` is idempotent; reusing the key for
different content returns `policy_revision_conflict`.

```json
{
  "policy_id": "internet-enabled",
  "revision": 3,
  "schema_version": 1,
  "digest": "sha256:..."
}
```

The initial implementation accepts only the policy documents described by
[`policy.schema.json`](policy.schema.json).

## Policy Assignment

`PUT /internal/agent-policy-assignments/{agent_id}`

```json
{
  "policy_id": "internet-enabled",
  "revision": 3,
  "expected_resource_version": 1
}
```

`expected_resource_version` is `0` when no assignment is expected. A stale
value returns `resource_version_conflict`. An exact retry that already produced
the requested assignment returns the current assignment instead of advancing
the version again.

Before acknowledging a changed assignment, Egress compiles the policy, closes
the Agent packet gate, commits the CAS, clears userspace flows and conntrack,
publishes the new snapshot, and explicitly reopens the gate. A post-fence
database ambiguity or cleanup failure leaves that Agent fenced until a complete
retry reconciles durable state, kernel state, and the packet snapshot. Other
Agents never wait for this Agent's gate.

```json
{
  "agent_id": "agent-1",
  "policy_id": "internet-enabled",
  "revision": 3,
  "resource_version": 2
}
```

`GET /internal/agent-policy-assignments/{agent_id}` returns the current
assignment.

## Errors

Errors have one stable shape:

```json
{
  "code": "resource_version_conflict",
  "message": "policy assignment changed",
  "retryable": false
}
```

| Code | HTTP | Meaning |
| --- | ---: | --- |
| `invalid_request` | 400 | JSON, identifier, address, revision, or policy validation failed |
| `route_not_found` | 404 | The control route does not exist |
| `agent_network_not_found` | 404 | No durable Agent network exists |
| `policy_revision_not_found` | 404 | Referenced immutable policy revision does not exist |
| `method_not_allowed` | 405 | The route does not support this HTTP method |
| `agent_network_unavailable` | 409 | Existing Agent network is quarantined or otherwise unavailable |
| `policy_revision_conflict` | 409 | Existing revision key has different canonical content |
| `resource_version_conflict` | 409 | Compare-and-swap precondition failed |
| `address_pool_exhausted` | 409 | No usable non-quarantined address is available |
| `cleanup_failed` | 503 | Flow or conntrack barrier did not complete |
| `operation_failed` | 503 | This bounded database/control operation failed; shared readiness may remain healthy and retry is allowed |
| `control_plane_unavailable` | 503 | Database or control mutation path is unavailable |

Internal failures never expose SQL, credentials, packet payloads, or command
stderr in the response.
