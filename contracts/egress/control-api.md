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

This document describes control contract revision 4.

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
an Agent with an active allocation receives the same allocation and current
attachment projection. Ensure never opens a closed Runtime attachment;
lifecycle traffic changes only through the attachment CAS operation.

```json
{
  "agent_id": "agent-1",
  "tunnel_ipv4": "100.64.0.2",
  "resolver_ipv4": "100.64.0.1",
  "packet_contract_revision": 1,
  "egress_endpoint": {"ipv4": "10.20.0.8", "port": 8092},
  "state": "active",
  "network_resource_version": 1,
  "attachment_state": "closed",
  "attachment_resource_version": 1
}
```

A new Agent is assigned the built-in deny-all desired policy
`(policy_id="builtin/deny-all", revision=1)` before the allocation is returned.
Its Runtime attachment starts closed. Egress installs a probe-only route that
can answer the canonical local readiness probe defined by the Runtime packet
contract, but cannot write TUN, create a flow, or reach an upstream. The desired
policy and attachment state are independent durable records.

### Inspect

`GET /internal/agent-networks/{agent_id}` returns the same document. A missing
Agent returns `agent_network_not_found`.

## Runtime Attachment

`PUT /internal/agent-network-attachments/{agent_id}`

```json
{"state":"closed","expected_resource_version":7}
```

Attachment state is `closed` or `open` and has its own monotonic resource
version. It never rewrites the Agent's desired policy.

- Closing first installs a hard fence, drains packet writers, and clears
  userspace flow and conntrack state. It commits `closed` only after that
  barrier succeeds, then publishes the probe-only route. Durable `closed`
  therefore proves cleanup completed.
- Opening hard-fences and completes flow/conntrack cleanup before committing
  the CAS, then compiles the current desired policy and publishes the open
  route. The caller must first establish Runtime readiness. Same-state open
  retries also complete cleanup; durable idempotency does not mean live
  connections survive a repeated open request.
- Every transition requires an active allocation. An exact same-state retry is
  accepted only when its expected resource version is the current version or
  the immediately preceding version consumed by that transition. Older-cycle
  requests fail CAS and cannot replace newer state.

The response is the complete Agent network document shown above.

### Release

`POST /internal/agent-networks/{agent_id}/release`

```json
{"expected_resource_version": 8}
```

Release requires the current **network** resource version and a closed
attachment. Egress atomically validates and moves the allocation into durable
quarantine before removing the probe-only route and repeating bounded cleanup.
A stale release has no packet-gate or cleanup side effect. Repeating release
reconciles cleanup and returns the current quarantined state.
An address becomes allocatable only after its quarantine deadline and a final
cleanup check.

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

`GET /internal/policies/{policy_id}/revisions/{revision}` reads the exact
immutable revision, including its policy document:

```json
{
  "policy_id": "internet-enabled",
  "revision": 3,
  "spec": {"schema_version": 1, "action": "allow_all"},
  "digest": "sha256:..."
}
```

Policy identifiers are opaque. Callers percent-encode the complete identifier
as one path segment, including the slash in `builtin/allow-all`. Both built-in
policies (`builtin/allow-all` and `builtin/deny-all`, revision 1) are seeded by
Egress. A caller must read `spec.action`, not infer behavior from an ID/name.
`allow_all` means public IPv4 access under the existing non-bypassable private/
special-address baseline, not access to the deployment platform.

Reading never creates a missing revision or Agent network, changes an
assignment, clears flows or opens an attachment. Unknown keys return
`404 policy_revision_not_found`; malformed identifiers or nonpositive revisions
return `400 invalid_request`. A repository failure uses the existing bounded
control error contract. This is a control RPC with W3C trace propagation; it
does not add any packet-level tracing. PUT responses retain their existing
metadata-only shape.

## Policy Assignment

`PUT /internal/agent-policy-assignments/{agent_id}`

```json
{
  "policy_id": "internet-enabled",
  "revision": 3,
  "expected_resource_version": 1
}
```

Ensure creates the initial deny assignment at resource version 1. Callers use
the assignment's current version; this operation cannot create an assignment
for a missing network. A stale value returns `resource_version_conflict`.
An exact retry that already produced
the requested assignment returns the current assignment instead of advancing
the version again.

Policy assignment changes only desired policy. When the Runtime attachment is
open, Egress closes the packet gate, clears flows and conntrack, commits the
assignment CAS, publishes the new policy snapshot, and reopens the gate. When the attachment is
closed, the same CAS changes durable desired policy without opening traffic;
the next attachment open applies the latest revision. Other Agents never wait
for this Agent's gate.

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

Assignment inspection describes durable desired policy, not proof of live
traffic. A failed post-fence operation may leave the Agent fenced while its old
assignment remains readable. On timeout or `503`, callers must not announce
that traffic is enabled merely because a subsequent GET returns that policy;
an identical PUT reconciles the packet gate before acknowledging success.
`200` on PUT means the barrier and snapshot are settled. With a closed attachment
it means the desired policy is saved for the next lifecycle open, not that
traffic has opened. Version conflicts require a fresh read and explicit user
decision, never silently replacing `expected_resource_version` and retrying.

Ensure may restore an already-open attachment's route, but must complete flow
and conntrack cleanup before removing a hard fence. Explicit attachment open
uses the same barrier, including same-state retries. If cleanup fails, the
packet gate stays fenced and the operation returns `cleanup_failed`; a read or
matching durable version cannot bypass this barrier. Successful reconciliation
applies the current durable assignment, not a target from a previously failed
policy change. A healthy Ensure is a no-op and does not reset live connections.

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
