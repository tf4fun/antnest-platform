# Runtime Egress Control API

Runtime Egress exposes a small JSON-over-HTTP RPC API on a
private control-purpose network with verified workload authority. Agent Controller
owns lifecycle and policy calls; Runtime Controller owns only private generation-key registration.
It performs no end-user authentication and carries no
deployment-provider, Run, Tool, or Channel state. Generation identity is limited
to the opaque key ID and Runtime revision required for transport authentication.

JSON requests and responses use `application/json`; Ensure and GET requests
have no body. Unknown and duplicate fields are rejected. Exact workload grants,
token/TLS configuration, strict request limits and listener placement follow the
[revision 5 authentication profile](service-authentication.md). The caller catalog
is enforced and the Egress owning-service gates have passed. Coordinated
deployment and actual Controller-to-Egress acceptance remain a separate final
integration batch.
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

This document describes control contract revision 9.

## Status

`GET /status`

This minimal probe exists only on the separate loopback health listener,
`ANTNEST_EGRESS_HEALTH_LISTEN` (default `127.0.0.1:8082`). It is not a business
route on the authenticated control listener.

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
  "packet_contract_revision": 2,
  "egress_endpoint": { "ipv4": "10.20.0.8", "port": 8092 },
  "state": "active",
  "network_resource_version": 1,
  "attachment_state": "closed",
  "attachment_resource_version": 1,
  "tunnel_key_id": null
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

## Private generation key preparation

`PUT /internal/agent-tunnel-keys/{agent_id}` is restricted to Runtime Controller.
Its strict request follows [tunnel-key-request.schema.json](tunnel-key-request.schema.json).
RC sends Egress's private X25519 key, the Runtime public key and a shared 32-byte
PSK, with the opaque key ID, Runtime revision and allocated inner IPv4. The
response is `204` without a body. No other caller can register generation keys.

The key ID is immutable: exact replay succeeds, different identity or key
material conflicts. New preparation requires a closed attachment and keeps at
most the current generation and one candidate. Opening selects the prepared
key and retires all other generations under the output barrier. Release deletes
all private generation records. Egress seals private material in its database
using its independent root-only 32-byte master file; restart restores the
static generation keys and establishes fresh WireGuard sessions. Private RPC
content is never captured, even when diagnostic content capture is enabled.

Only authenticated revision 2 datagrams can reach readiness or policy; no raw
revision 1 fallback exists. Authentication, replay and unknown-context drops
have aggregate counters without Agent labels. See the
[transport contract](../../docs/authenticated-runtime-tunnel.md).

## Runtime Attachment

`PUT /internal/agent-network-attachments/{agent_id}`

```json
{ "state": "open", "expected_resource_version": 7, "runtime_endpoint": "10.243.1.20", "tunnel_key_id": "rtk_0123456789abcdef0123456789abcdef" }
```

Attachment state is `closed`, `pending`, or `open` and has its own monotonic resource
version. It never rewrites the Agent's desired policy.

Revision 8 adds `pending` for a provisioned target whose current Runtime has no
bindable peer. Pending omits both peer and key (or sends both as null). It has
exactly the same probe-only packet gate as closed; it grants no outbound traffic.
Ensure, policy changes and Egress recovery preserve that gate. New generation-key
preparation still requires closed; exact replay of an existing prepared key is
unchanged. Release also requires closed.

Closed-to-pending and pending-to-closed are distinct CAS transitions and each
consumes a version. A completed lifecycle may leave its target pending without
occupying the lifecycle slot. Controller may bind that target's first fresh,
matching running peer using the pending version, before health becomes ready.
It never opens closed from observation. A later lifecycle close invalidates the
old pending version, including requests delayed beyond their caller's timeout.
An exact lost-response retry is allowed only for the immediately preceding CAS;
newer lifecycle cycles cannot be borrowed. Pending is not executable availability.

Deploy the Egress producer before enabling the Controller consumer. Older
consumers remain compatible with closed/open; they must not be used after a
newer Controller has persisted pending attachments. For rollback, stop producing
pending transitions, use the revision 8 consumer to drain all pending attachments,
and confirm its in-flight requests have ended. Only then roll back Controller,
followed by Egress.

Revision 7 binds each open attachment to the prepared `tunnel_key_id` and `runtime_endpoint`, the canonical IPv4
address reported by RC for that Runtime on its management network. This is an
address, not a URL or an inner tunnel address; the UDP source port is not pinned.
Open requires both fields and a previously prepared generation key. Close omits them or sends null and clears the public binding, retaining the private generation for authenticated readiness.
Network responses include the address while bound. State, address and key ID form one
CAS value: changing either consumes a new resource version; same-state replay
with an older version succeeds only for the exact same address and key ID. Policy changes,
Ensure and Egress restart preserve the committed peer binding.

Controller uses the provisioned lifecycle result and reconciles RC's current
inspection before publishing execution readiness. Runtime restart/address
changes rebind an already-open attachment, or first bind the completed target's pending attachment, using its current CAS version;
observation cannot reopen an attachment closed by a lifecycle operation.
Rebuild, Enable and source restoration bind the respective Runtime address.
An unbound open route fails closed. A closed or pending route has no outbound access and
may answer only the fixed local readiness probe from the packet contract.

- Closing first installs a hard fence, drains packet writers, and clears
  userspace flow and conntrack state. It commits `closed` only after that
  barrier succeeds, then publishes the probe-only route. Durable `closed`
  therefore proves cleanup completed.
- Opening hard-fences and completes flow/conntrack cleanup before committing
  the CAS, then compiles the current desired policy and publishes the open
  route. The caller must first establish completed provisioning and its peer
  address; execution readiness is independently observed by Controller. Same-state open
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
{ "expected_resource_version": 8 }
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
{ "spec": { "schema_version": 1, "action": "allow_all" } }
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

Control contract revision 9 publishes the schema_version 2 policy document:

```json
{
  "schema_version": 2,
  "default": "deny",
  "rules": [
    { "action": "allow", "domains": ["api.github.com"], "ports": [443], "protocol": "tcp" },
    { "action": "allow", "cidrs": ["10.20.0.15/32"], "ports": [443] },
    { "action": "deny", "ports": [25] }
  ]
}
```

`default` is `allow` or `deny` and applies when no rule matches. `rules` is an
ordered array of at most 128 entries evaluated first-match — the first rule
whose selectors match the destination decides; there is no longest-prefix or
priority ordering. Each rule carries a required `action` (`allow` or `deny`),
optional `ports` (integers or `{from, to}` ranges, 1-65535, up to 64 entries;
`from` greater than `to` is a semantic runtime rejection), an optional
`protocol` that is `tcp` only, and at most one destination selector: `cidrs`
(canonical IPv4 CIDRs, no leading zeros, prefix 0-32; host-bit enforcement is
semantic runtime) or `domains` (lowercase ASCII hostnames of two or more
labels, each 1-63 characters without edge hyphens, no trailing dot, no
wildcards, at most 253 characters total). A rule with no selector matches any
destination. Unknown fields, both selectors together, empty selector lists and
IPv6/wildcard forms are invalid.

A `default` of `allow` keeps the v1 external-only universe: it never opens
loopback, link-local, private, multicast, documentation, benchmarking,
reserved or deployment addresses. An explicit v2 `allow` rule may additionally
cover RFC1918 destinations only; it can never permit the configured platform
deny set or other special-use ranges, which are evaluated before any rule.
Under schema_version 2, TCP DNS to the virtual resolver is permitted even when
`default` is `deny` so domain rules can resolve; that is the single documented
resolver exception and does not grant general resolver access. The canonical
v1 migration is `allow_all` to `{"default": "allow", "rules": []}` and
`deny_all` to `{"default": "deny", "rules": []}`, which preserves each v1
external decision except for this resolver access; callers needing total DNS
denial keep `deny_all`. Domain rules bind only validated answers from the
Agent's own resolver queries; they can never grant platform addresses.

Revision 9 is implemented by the Egress service; the owning Controller and
Console consumer batches remain pending.

`GET /internal/policies/{policy_id}/revisions/{revision}` reads the exact
immutable revision, including its policy document:

```json
{
  "policy_id": "internet-enabled",
  "revision": 3,
  "spec": { "schema_version": 1, "action": "allow_all" },
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

| Code                        |    HTTP | Meaning                                                                                                  |
| --------------------------- | ------: | -------------------------------------------------------------------------------------------------------- |
| `service_unauthenticated`   |     401 | Missing or invalid workload authority; nonretryable, exact service challenge                             |
| `caller_not_allowed`        |     403 | Verified workload is not the permitted caller for this route; nonretryable, no challenge                                          |
| `unsupported_media_type`    |     415 | JSON carrier is missing, ambiguous or unsupported; nonretryable                                          |
| `invalid_request`           | 400/413 | JSON, body size, query, identifier, address, revision, or policy validation failed                       |
| `route_not_found`           |     404 | The control route does not exist                                                                         |
| `agent_network_not_found`   |     404 | No durable Agent network exists                                                                          |
| `policy_revision_not_found` |     404 | Referenced immutable policy revision does not exist                                                      |
| `method_not_allowed`        |     405 | The route does not support this HTTP method                                                              |
| `agent_network_unavailable` |     409 | Existing Agent network is quarantined or otherwise unavailable                                           |
| `policy_revision_conflict`  |     409 | Existing revision key has different canonical content                                                    |
| `resource_version_conflict` |     409 | Compare-and-swap precondition failed                                                                     |
| `address_pool_exhausted`    |     409 | No usable non-quarantined address is available                                                           |
| `cleanup_failed`            |     503 | Flow or conntrack barrier did not complete                                                               |
| `operation_failed`          |     503 | This bounded database/control operation failed; shared readiness may remain healthy and retry is allowed |
| `control_plane_unavailable` |     503 | Database or control mutation path is unavailable                                                         |

| `tunnel_key_unavailable`    |     409 | Open references an absent or unreadable prepared generation; no mutation occurs                          |
| `tunnel_key_conflict`       |     409 | Existing key ID has different identity or key material                                                   |
| `attachment_open`          |     409 | A new candidate cannot be registered while traffic is open                                              |

Internal failures never expose SQL, credentials, packet payloads, or command
stderr in the response.
