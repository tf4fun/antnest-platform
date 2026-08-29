# Stage 1 Runtime And Egress Architecture

> Status: implemented Stage 1 baseline; future changes remain doc-first<br>
> Updated: 2026-08-30<br>
> Compatibility: greenfield; no legacy service or wire compatibility is kept

Stage 1 establishes the isolated Agent execution and network data planes.
`antnest-runtime` and Runtime Egress are implemented and accepted together.
Runtime Controller, Agent Controller, and ACP Service appear here only where
their future boundaries constrain Runtime or Egress; their existing prototype
code is not authoritative.

Both Stage 1 data-plane services are implemented in Rust. Runtime Egress has a
small but privileged Linux packet hot path, long-lived concurrent I/O, and
strict ownership lifetimes; Rust provides the clearest fit without introducing
a cross-language framework or shared implementation library.

This document is the canonical cross-component design for Stage 1. A future
change must update this document before changing the affected contracts or
implementations.

## 1. Goals

Stage 1 must provide a small, durable foundation for later Agent management:

1. Run one Agent in an isolated Linux Runtime with a persistent workspace.
2. Route all Agent-executor network traffic through a separately managed
   Egress data plane.
3. Give one Agent one stable Tunnel IPv4 address across Runtime generations.
4. Keep network policy independent from Runtime generation and deployment.
5. Permit a prepared candidate Runtime without allowing two generations to
   execute Agent work concurrently.
6. Keep deployment-platform details outside Agent and Egress domain models.
7. Preserve enough durable state to recover configuration after process
   restart without persisting packets, peers, flows, or conntrack.

Stage 1 does not provide an external API, end-user authentication, Channel
integration, model execution, Agent prompts, Memory, Skill Registry, active-
active Egress, zero-trust Runtime tunnels, or transparent connection survival
across Egress restart.

## 2. Design Invariants

1. Agent Controller is the sole authority for Agent lifecycle, Runtime
   generation allocation, rollout, and Agent-level execution admission.
2. Runtime Controller realizes one explicitly named Runtime generation on one
   deployment platform. It never chooses a generation or an Agent policy.
3. Runtime Egress is the sole authority for Agent Tunnel addresses, address
   reuse, policy definitions, policy assignments, and packet decisions.
4. Antnest Runtime owns only local bootstrap, MCP tools, process containment,
   filesystem side effects, TUN, and packet transport.
5. One Agent has one stable Tunnel IPv4. All of its Runtime generations receive
   the same network attachment.
6. One Agent may have active and candidate Runtime resources, but only the
   active generation may receive Agent operations.
7. Before a candidate becomes active, the old Runtime is confirmed absent and
   Egress has cleared all flows and conntrack owned by that Agent.
8. Network policy changes never create a Runtime generation.
9. No component reads or writes another component's database tables.
10. RPC retries reuse the original logical identifier and payload digest.

## 3. Component Boundaries

| Component | Responsibility | Explicit non-responsibilities |
| --- | --- | --- |
| Agent Controller | Agent desired state, generations, rollout, deletion, execution gate, and workflow recovery | Containers, Pods, packet forwarding, network policy storage, MCP implementation |
| Runtime Controller | Idempotent `Ensure`, `Inspect`, and `Delete` for a caller-selected Runtime generation; deployment-platform credentials and resource association | Generation selection, rollout, work dispatch, policy, Egress allocation |
| Runtime Egress | Agent network allocation, policy revisions and assignments, UDP/TUN forwarding, rejection, flow ownership, conntrack cleanup, and address quarantine | Runtime creation, Agent lifecycle, Runs, Tools, prompts, Runtime generations |
| Antnest Runtime | Immutable bootstrap, status, MCP tools, UID/GID isolation, workspace access, TUN setup, and raw-IP-over-UDP transport | Durable state, policy decisions, containers, databases, Agent lifecycle |
| ACP Service | Runs, sessions, Agent loop, and MCP calls made under an Agent Controller execution grant | Runtime rollout, Tunnel allocation, deployment-platform resources |

Runtime Controller contains its Docker or Kubernetes adapter in process. Stage
1 does not add another Provider service hop. Different platform implementations
must expose the same language-neutral Runtime Controller contract.

```text
Management -----> Agent Controller -----> Runtime Controller -----> Docker/Kubernetes
                         |
                         `---------------> Runtime Egress control plane

ACP Service ---- acquire operation -----> Agent Controller
ACP Service ----------- MCP ------------> active Antnest Runtime
Antnest Runtime ---- raw IP over UDP ---> Runtime Egress ----> destination network
```

## 4. Identity And Lifetime

### 4.1 Agent

`agent_id` is globally unique and is never reused. It owns the persistent
workspace, network address, policy assignment, and ordered Runtime generations.

### 4.2 Runtime generation

Runtime identity is the composite key `(agent_id, generation)`. `generation`
is a positive, monotonically increasing integer scoped to one Agent and
identifies one immutable Runtime deployment specification. The same composite
key and specification digest are idempotent. Reusing the composite key with
different content is a conflict.

Generation identity is not part of the Egress durable model. It is needed only
by Agent Controller, Runtime Controller, deployment labels, Runtime status, and
the execution grant returned to ACP Service.

### 4.3 Agent network

One active Agent owns one Tunnel IPv4. The address remains unchanged while
Runtime generations are prepared, replaced, or deleted. It is released only
after the Agent is deleted and every Runtime is confirmed absent.

The outer Runtime UDP `IP:port` is an ephemeral return locator. It is neither a
durable identity nor an authentication credential.

## 5. Runtime Deployment Contract

Agent Controller constructs an immutable Runtime deployment request containing:

- `agent_id` and positive Agent-scoped `generation`;
- Runtime image reference and resource limits;
- Runtime listen address;
- Agent workspace and system-Skill mount descriptions;
- `tunnel_ipv4`, virtual resolver IPv4 address, and literal IPv4 Egress UDP
  endpoint;
- exact packet contract revision selected by Egress;
- a canonical specification digest.

Runtime Controller serializes the language-neutral object defined by
`contracts/runtime/runtime-spec.schema.json` once and supplies it as
`ANTNEST_RUNTIME_SPEC`. Antnest Runtime does not reconstruct the same contract
from a second collection of field-specific environment variables.

It contains no network mode, policy ID, policy revision, allow/deny rules,
allocator cursor, Egress token, reservation, or generation network lease.

Runtime Controller maps this description to deterministic Docker or Kubernetes
resources. Platform labels contain `agent_id`, `generation`, and the
specification digest. These labels are the reconstructible association; Runtime
Controller should not need its own database. Runtime and Egress use the fixed
inner MTU defined by `contracts/runtime/packet-contract.json`; it is a protocol
constant rather than deployment input.

Runtime Controller also exposes Agent-scoped workspace operations. Deleting a
Runtime generation must never delete the Agent workspace. Workspace deletion is
allowed only during Agent deletion through a separate operation.

## 6. Runtime Contract Alignment

The implemented Rust Runtime remains the baseline for privilege separation,
MCP, filesystem roots, cancellation, process cleanup, status, telemetry, and
raw packet transport.

The implemented Egress design applies the following Runtime contract decision:

- UID/GID 1000 traffic always enters TUN and reaches Runtime Egress.
- Runtime no longer implements a local `restricted` versus `unrestricted`
  policy decision.
- Runtime receives one complete network attachment and knows no Agent policy.
- Egress produces allow, reject, or drop decisions.

`runtime-spec.schema.json`, Runtime network bootstrap, packet fixtures, and
Runtime tests contain no `network.mode`; policy belongs exclusively to Egress.

The first Egress implementation matches the completed Runtime packet scope:
one complete, unfragmented IPv4/TCP packet per UDP datagram with a fixed inner
MTU of `1400`. Inner UDP, IPv6, fragmentation, and unsolicited inbound flows require a
later explicit contract revision.

RuntimeSpec and the Egress attachment carry that revision. A future incompatible
packet revision is introduced on a distinct Egress UDP endpoint, supported in
parallel during Runtime generation rollout, and removed only after no Runtime
uses the old revision. The revision is control metadata, never a packet envelope.

## 7. Runtime Egress Durable Model

Runtime Egress owns a private PostgreSQL schema, role, and migrations. The
minimal durable entities are:

```text
address_pools
  pool_id, cidr, resolver_ipv4, next_slot, quarantine_duration, resource_version

agent_networks
  agent_id, pool_id, tunnel_ipv4, state, resource_version, quarantine_until

policy_revisions
  policy_id, revision, schema_version, canonical_spec, digest, created_at

agent_policy_assignments
  agent_id, policy_id, revision, resource_version, updated_at
```

`agent_networks.state` is `active` or `quarantined`. A quarantined
row continues to occupy its address. A sweeper makes the slot reusable only
after the deadline and a final zero-state check.

The first policy schema supports `allow_all` and `deny_all`. Immutable,
schema-versioned revisions allow later destination CIDR, port, protocol, or
domain-derived rules without changing Runtime. A missing, invalid, or
unavailable Agent policy assignment is always interpreted as `deny_all`.

Runtime generation, outer UDP peer, packet, flow, DNS cache, compiled policy,
queue, rate counter, and kernel conntrack state are not persisted.

## 8. Egress In-Memory State

Runtime Egress maintains bounded indexes:

```text
Tunnel IPv4                     -> Agent network
forward inner flow             -> owning outer UDP peer
reverse inner flow             -> owning outer UDP peer
Agent                           -> owned flow keys
Agent                           -> current compiled policy snapshot
outer UDP peer                  -> activity and bounded counters
```

A flow contains the Agent, canonical inner five-tuple, owning UDP peer, policy
assignment version, protocol state, and last activity time. The first peer to
claim an inner flow owns it until the flow is closed or expires. A second peer
using the same five-tuple is rejected and cannot replace the owner.

There is no durable active/candidate peer state. Candidate Runtime does not
receive Agent work, and the rollout barrier clears all Agent flows before the
candidate is made active.

## 9. Packet Processing

### 9.1 Uplink

1. Receive exactly one UDP datagram and retain its outer source `IP:port`.
2. Validate the complete inner IPv4 packet, total length, MTU, fragmentation,
   and supported protocol header.
3. Resolve the inner source Tunnel IPv4 to an active Agent network.
4. Read the Agent's immutable compiled policy snapshot.
5. Reject or drop denied traffic without creating a flow.
6. Atomically claim a new inner flow for the outer peer, or verify that an
   existing flow already belongs to that peer.
7. Recheck policy version and flow ownership immediately before writing the
   packet to Egress TUN.

### 9.2 Downlink

1. Validate a packet read from Egress TUN.
2. Resolve its destination Tunnel IPv4 and reverse inner five-tuple.
3. Require an existing flow with the current policy assignment version.
4. Send the complete packet as one UDP datagram to the flow's owning peer.
5. Drop malformed, unsolicited, stale, or unowned packets.

Valid policy-denied TCP receives a correct TCP reset. Malformed packets and
unknown Tunnel addresses are dropped silently. No packet or payload is logged
by default.

## 10. Policy Mutation Barrier

Policy assignment is Agent-scoped and independent of Runtime generation. An
assignment update performs:

1. validate and compile the immutable target revision;
2. close that Agent's data-plane admission gate;
3. update the assignment with resource-version compare-and-swap;
4. atomically publish the compiled snapshot;
5. clear the Agent's userspace flows and kernel conntrack;
6. reopen data-plane admission;
7. acknowledge the control request.

An acknowledged update means no later packet can be admitted by the previous
assignment. A policy update never calls Runtime Controller or changes Runtime
generation.

## 11. Lifecycle Workflows

### 11.1 Initial creation

1. Agent Controller persists the Agent and initial Runtime generation.
2. It calls Egress `EnsureAgentNetwork` and obtains the stable attachment.
3. It ensures Agent storage through Runtime Controller.
4. It calls Runtime Controller `EnsureRuntime` with the immutable request.
5. Runtime Controller observes platform presence and Runtime `/status`.
6. Agent Controller marks the generation active and opens execution admission.

A failed Runtime build is visible immediately. The failed candidate is deleted,
but the Agent network and workspace remain available for an explicit retry.

### 11.2 Runtime rollout

1. Persist and create a candidate using the same workspace and network address.
2. Wait for candidate local readiness; candidate receives no Agent work.
3. Close new-operation admission and wait for the current operation to finish.
4. Delete the old Runtime and require Runtime Controller to report `Absent`.
5. Call Egress `ResetAgentFlows` and wait for flow/conntrack cleanup.
6. Atomically set the candidate as active and reopen operation admission.

Candidate failure before step 3 leaves the active Runtime untouched. An
ambiguous old-Runtime deletion keeps admission closed until inspection proves
presence or absence. This deliberately favors a short queued interval over two
generations executing concurrently.

### 11.3 Agent deletion

1. Persist deletion intent and close operation admission.
2. Finish or cancel the current operation. Ambiguous side effects become
   `unknown` and are never automatically replayed.
3. Fence the Agent network and clear flows and conntrack.
4. Delete every Runtime generation and confirm absence.
5. Delete the Agent workspace according to retention policy.
6. Mark the Agent deleted.
7. Release its network address into Egress quarantine.

An address is never released while platform deletion is ambiguous.

## 12. Minimal Internal RPC Surface

```text
Runtime Controller
  EnsureRuntime(agent_id, generation, spec, digest)
  InspectRuntime(agent_id, generation)
  DeleteRuntime(agent_id, generation)
  EnsureAgentStorage(agent_id, storage_spec)
  DeleteAgentStorage(agent_id)

Runtime Egress
  EnsureAgentNetwork(agent_id)
  InspectAgentNetwork(agent_id)
  ResetAgentFlows(agent_id)
  FenceAgentNetwork(agent_id)
  ReleaseAgentNetwork(agent_id)
  CreatePolicyRevision(policy_id, revision, spec)
  AssignAgentPolicy(agent_id, policy_ref, expected_resource_version)

Agent Controller
  BeginAgentOperation(agent_id, operation_id)
  FinishAgentOperation(agent_id, operation_id, outcome)
  CancelAgentOperation(agent_id, operation_id)
```

`BeginAgentOperation` returns the exact active Runtime generation and endpoint.
ACP Service must not cache an endpoint beyond that operation. Runtime MCP and
Runtime `/status` remain their existing standard HTTP interfaces.

## 13. Failure And Recovery Semantics

- A timed-out mutation is inspected and retried with the same identifier. A
  timeout never causes an inverse mutation or a new generation automatically.
- Runtime Controller operations are serialized per generation. `DeleteRuntime`
  returns only after platform absence; deletion wins over concurrent ensure.
- Runtime failure after possible side effects produces an `unknown` operation
  outcome. The operation is not automatically replayed.
- Agent Controller persists workflow phase before issuing a side effect and
  resumes non-terminal workflows by inspecting child components.
- Runtime Controller restart reconstructs state from deterministic platform
  names and labels.
- Egress cold start is fail-closed. It loads allocations and policy, initializes
  TUN and kernel state, and becomes ready only after publishing one consistent
  snapshot.
- Egress restart clears flows and conntrack. Existing TCP connections fail;
  new outbound flows relearn their UDP peers without rebuilding Runtime.
- During a warm Egress database outage, the last applied snapshot continues to
  forward traffic, but policy mutation, allocation, and address release fail.

## 14. Trust And Security Boundary

Docker or Kubernetes is the trusted deployment boundary for Stage 1. Internal
service RPCs and the Runtime UDP tunnel do not add application credentials or a
custom authentication envelope.

Deployment topology still separates responsibilities:

- Runtime containers can reach the Egress UDP data-plane endpoint but not the
  Egress control listener or PostgreSQL.
- Agent Controller can reach internal control RPCs but owns no Docker socket,
  TUN device, or packet privilege.
- Runtime Controller alone holds Docker or Kubernetes credentials.
- Egress alone holds host network privileges and its database role.
- UID/GID 1000 Agent executors cannot use the Runtime Supervisor's platform
  routing table.

Malformed packet validation is still mandatory. Trusted deployment networking
removes cross-service authentication; it does not make packet bytes valid.

## 15. Observability

Control-plane RPCs propagate OpenTelemetry context. Logs and spans may carry
`agent_id`, `generation`, rollout ID, operation ID, policy revision,
and trace ID. High-cardinality identifiers are not metric labels.

Runtime Egress emits periodic content-free aggregate counters for packet and
flow behavior through OTLP Metrics, plus structured control/cleanup failures
and control-plane spans. Metric attributes remain low-cardinality. It does not
create packet-level spans or log packet payloads.

Stage 1 runs one Runtime Egress replica. Its in-memory flow ownership, TUN, and
conntrack state are node-local and cannot be placed behind a generic load
balancer. Horizontal scale requires an explicit Tunnel-address shard owner and
is a later contract change, not an operator tuning flag.

Runtime Controller reports platform operation latency, observed Runtime phases,
drift, readiness failures, and delete convergence. Antnest Runtime retains its
existing HTTP/tool tracing and structured local lifecycle logs.

## 16. Delivery Sequence

### Stage 1A: Antnest Runtime -- implemented

- Root Supervisor and UID/GID 1000 one-shot executors.
- MCP `bash`, `read`, `write`, and `edit`.
- Workspace and Skill roots, cancellation, process cleanup, status, and OTLP.
- TUN and one-inner-packet-per-UDP-datagram transport.

The packet-contract and Egress-attachment alignment described in section 6 is
implemented.

### Stage 1B: Runtime Egress -- implemented and accepted

1. Replaced the obsolete Go prototype with an independent Rust crate.
2. Frozen Egress domain contracts and PostgreSQL migrations.
3. Implemented policy revision and Agent assignment logic through pure domain
   tests.
4. Implemented PID-style address allocation, quarantine, and recovery.
5. Implemented bounded UDP peer and flow indexes.
6. Implemented TUN uplink/downlink, rejection, policy barrier, and cleanup.
7. Added Runtime/Egress integration around language-neutral packet fixtures.
8. Kept network policy out of RuntimeSpec and aligned the Runtime/Egress packet
   contract atomically.
9. Accepted real Runtime-originated allow/deny traffic, policy hot updates,
   PostgreSQL restoration, Egress restart recovery, and address release in an
   isolated disposable Compose environment.

### Later integration

Runtime Controller, Agent Controller, ACP Service, and Kubernetes support are
implemented only after Runtime Egress passes its standalone acceptance. Their
interfaces in this document prevent Stage 1 components from absorbing those
future responsibilities.

## 17. Stage 1B Acceptance

- Repeating `EnsureAgentNetwork` returns one stable address for an Agent.
- Two Runtime UDP peers using one Agent address receive replies for their own
  non-conflicting flows.
- A second peer cannot steal an existing inner five-tuple.
- `allow_all` forwards a real Runtime-initiated TCP flow.
- `deny_all` fails a real Runtime-initiated TCP connection quickly.
- Policy reassignment clears old flows before acknowledgement.
- Egress restart restores allocation and policy but not stale connections.
- Agent fencing prevents new uplink packets and clears downlink ownership.
- Address release is impossible before fencing and enters durable quarantine.
- An expired quarantine slot can be reused without preserving old flow state.
- TUN, PostgreSQL, or policy initialization failure keeps Egress unready.
- Runtime and Egress emit correlated control-plane telemetry without tracing or
  logging packet payloads.
