# Stage 1 Runtime And Egress Architecture

Stage 1 establishes the isolated Agent execution and network data planes.
`antnest-runtime`, Runtime Egress, and the thin Docker Runtime Controller form
this layer. Runtime Controller implements a Docker adapter; a Kubernetes
adapter is planned and not implemented. The design is greenfield: no legacy
service or wire compatibility is kept. Agent Controller and ACP Service appear
here only where their boundaries constrain the Stage 1 contracts.

The [Agent Controller architecture](../services/agent-controller/docs/architecture.md)
and the [ACP execution API](../contracts/agent-acp/execution-api.md) are
authoritative for Agent rebuild, Run admission, ACP Sessions, and execution
configuration. Stage 1 does not define candidate/active Runtime rollout or
Agent environment epochs.

Both Stage 1 data-plane services are implemented in Rust. Runtime Egress has a
small but privileged Linux packet hot path, long-lived concurrent I/O, and
strict ownership lifetimes; Rust provides the clearest fit without introducing
a cross-language framework or shared implementation library.

This document is the canonical cross-component design for the Runtime, Egress,
and thin physical Runtime Controller foundation. A future change must update
this document before changing those contracts or implementations.

## 1. Goals

Stage 1 provides a small, durable foundation for Agent management:

1. Run one Agent in an isolated Linux Runtime with a persistent workspace.
2. Route all Agent-executor network traffic through a separately managed
   Egress data plane.
3. Give one Agent one stable Tunnel IPv4 address across explicit Runtime
   replacements.
4. Keep network policy independent from Runtime generation and deployment.
5. Clear stale Egress flow ownership before a replacement Runtime starts using
   the same Tunnel address.
6. Keep deployment-platform details outside Agent and Egress domain models.
7. Preserve enough durable state to recover configuration after process
   restart without persisting packets, peers, flows, or conntrack.

Stage 1 does not provide an external API, end-user authentication, Channel
integration, model execution, Agent prompts, Memory, Skill Registry, active-
active Egress, zero-trust Runtime tunnels, or transparent connection survival
across Egress restart.

## 2. Design Invariants

1. Agent Controller is the sole authority for Agent lifecycle intent, Runtime
   configuration, explicit rebuild, and publication of execution configuration.
   Agent ACP Service decides Run admission from that published configuration.
2. Runtime Controller owns the logical Runtime Environment lifecycle and maps
   `Initialize`, `Update`, `Disable`, `Enable`, and `Delete` to one deployment
   platform. Physical generations are private implementation details.
3. Runtime Egress is the sole authority for Agent Tunnel addresses, address
   reuse, policy definitions, policy assignments, and packet decisions.
4. Antnest Runtime owns only local bootstrap, MCP tools, process containment,
   filesystem side effects, TUN, and packet transport.
5. One Agent has one stable Tunnel IPv4. All of its Runtime generations receive
   the same network attachment.
6. Runtime Controller maintains at most one non-absent compute resource per
   Agent; it contains no candidate/active rollout state.
7. Before requesting Update, Agent Controller fences the Agent network and
   requires Egress to clear old flows and conntrack. Runtime Controller then
   removes old compute before creating its replacement.
8. Network policy changes never create a Runtime generation.
9. No component reads or writes another component's database tables.
10. RPC retries reuse the original logical identifier and payload digest.

## 3. Component Boundaries

| Component | Responsibility | Explicit non-responsibilities |
| --- | --- | --- |
| Agent Controller | Agent desired state, Runtime configuration, explicit rebuild, deletion, execution configuration publication, and workflow recovery | Run admission, physical generations, containers, Pods, packet forwarding, network policy storage, MCP implementation |
| Runtime Controller | Logical Runtime Environment lifecycle; private compute/workspace realization; deployment-platform credentials, resource association, platform observation normalization, and a bounded observation journal | Agent policy, Run admission, work dispatch, Egress allocation |
| Runtime Egress | Agent network allocation, policy revisions and assignments, UDP/TUN forwarding, rejection, flow ownership, conntrack cleanup, and address quarantine | Runtime creation, Agent lifecycle, Runs, Tools, prompts, Runtime generations |
| Antnest Runtime | Immutable bootstrap, status, MCP tools, UID/GID isolation, workspace access, TUN setup, and raw-IP-over-UDP transport | Durable state, policy decisions, containers, databases, Agent lifecycle |
| ACP Service | Run admission, Runs, ACP Sessions, Agent loop, execution settlement, and MCP calls made under an immutable Run snapshot | Runtime rebuild, Tunnel allocation, deployment-platform resources |

Runtime Controller contains its platform adapter in process. Stage 1 does not
add another Provider service hop. Different platform implementations must
expose the same language-neutral Runtime Controller contract.

```text
Management -----> Agent Controller -----> Runtime Controller -----> Docker/Kubernetes
                         |
                         |---------------> Runtime Egress control plane
                         `---------------> ACP Service (execution configuration, settlement)

ACP Service ----------- MCP ------------> snapshot-selected Antnest Runtime
Antnest Runtime ---- raw IP over UDP ---> Runtime Egress ----> destination network
```

## 4. Identity And Lifetime

### 4.1 Agent

`agent_id` is globally unique and is never reused. It owns the persistent
workspace, network address, policy assignment, and ordered Runtime generations.

### 4.2 Runtime Environment and private generation

The cross-service identity is `agent_id`. Each successful lifecycle mutation
returns an opaque `runtime_revision`; callers use it as compare-and-swap input
for the next mutation and must not infer ordering from it.

Runtime Controller privately allocates a positive, monotonically increasing
compute generation for Initialize, Update, and Enable. `(agent_id, generation)`
and the effective deployment digest fence Docker/Kubernetes resources and
platform observations, but neither value crosses the business RPC boundary.
The digest includes behavior-affecting Controller configuration rather than
only caller JSON.

### 4.3 Runtime execution

`execution_id` is a fresh random identity generated by Runtime PID 1 on every
process start. It distinguishes two process lifetimes that use the same Agent,
generation, platform resource, and endpoint.

It is not a credential. It is a consistency check used by `/status`, Runtime
observations, Agent execution binding, Run snapshots, and MCP requests.
An MCP request whose expected execution ID differs from the serving Runtime is
rejected before Tool execution.

The Runtime implementation, status contract, MCP execution fence, Controller
observations, and tests are maintained as one lockstep contract.

### 4.4 Agent network

One active Agent owns one Tunnel IPv4. The address remains unchanged while
Runtime generations are prepared, replaced, or deleted. It is released only
after the Agent is deleted and every Runtime is confirmed absent.

The outer Runtime UDP `IP:port` is an ephemeral return locator. It is neither a
durable identity nor an authentication credential.

## 5. Runtime Deployment Contract

Agent Controller constructs a Runtime configuration request containing:

- Runtime image reference and resource limits;
- `tunnel_ipv4`, virtual resolver IPv4 address, and literal IPv4 Egress UDP
  endpoint;
- exact packet contract revision selected by Egress.

Runtime Controller injects `agent_id`, its private generation, the fixed
Runtime listener, workspace and system-Skill paths, mounts, and healthcheck.

Runtime Controller computes the canonical deployment digest after applying its
behavior-affecting platform configuration. The caller neither supplies nor
reimplements that digest.

Runtime Controller serializes the language-neutral object defined by
`contracts/runtime/runtime-spec.schema.json` once and supplies it as
`ANTNEST_RUNTIME_SPEC`. Antnest Runtime does not reconstruct the same contract
from a second collection of field-specific environment variables.

It contains no network mode, policy ID, policy revision, allow/deny rules,
allocator cursor, Egress token, reservation, or generation network lease.

Runtime Controller maps this description to deterministic Docker or Kubernetes
resources. Platform labels contain `agent_id`, `generation`, and the
specification digest. These labels are the reconstructible current-state
association. Runtime Controller may persist only idempotent deployment-
operation state and a bounded Runtime observation journal in its own private
database; it must not duplicate Agent desired state. Runtime and Egress use the
fixed inner MTU defined by `contracts/runtime/packet-contract.json`; it is a
protocol constant rather than deployment input.

Workspace lifecycle is not a separate RPC. Initialize creates or adopts it;
Update and Disable retain it; Enable reuses it; Delete removes it after compute
is conclusively absent.

## 6. Runtime Contract Alignment

The implemented Rust Runtime remains the baseline for privilege separation,
MCP, filesystem roots, cancellation, process cleanup, status, telemetry, and
authenticated packet transport.

The Runtime Controller layer extends, but does not reinterpret, that baseline:

- PID 1 creates one `execution_id` per process lifetime.
- `/status` returns `agent_id`, `generation`, `execution_id`, and readiness.
- Runtime Controller reports a Runtime as healthy only after the deployment
  platform reports Healthy and a bounded `/status` check returns the matching
  execution identity. Lifecycle commands do not wait for this check; see
  [creation and observation](../services/runtime-controller/docs/creation-and-observation.md).
- Every MCP request carries the execution ID expected by the Run snapshot, for
  example in `X-Antnest-Expected-Execution-ID`.
- Runtime rejects a stale expected execution ID before dispatching a Tool.

The header is an internal consistency token, not service authentication. Workload authentication and expected execution identity are distinct checks;
network placement alone grants neither authority.

The implemented Egress design applies the following Runtime contract decision:

- UID/GID 1000 traffic always enters TUN and reaches Runtime Egress.
- Runtime no longer implements a local `restricted` versus `unrestricted`
  policy decision.
- Runtime receives one complete network attachment and knows no Agent policy.
- Egress produces allow, reject, or drop decisions.

`runtime-spec.schema.json`, Runtime network bootstrap, packet fixtures, and
Runtime tests contain no `network.mode`; policy belongs exclusively to Egress.

Egress matches the Runtime packet scope:
one complete, unfragmented IPv4/TCP packet per UDP datagram with a fixed inner
MTU of `1400`. Inner UDP, IPv6, fragmentation, and unsolicited inbound flows require a
later explicit contract revision.

RuntimeSpec and Egress attachments carry packet revision 2. UDP transports an
`ANT2` key selector and one unmodified WireGuard message; a selector alone is
not authentication. Decrypted inner packets retain the fixed IPv4/TCP contract.
The embedded engine owns handshake, encryption, session rekey and bounded replay
rejection. No raw revision 1 fallback exists. See the
[authenticated transport contract](authenticated-runtime-tunnel.md) for key
ownership, coordinated cutover and recovery.

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

There is no durable active/candidate peer state. Agent Controller clears all
Agent flows after the old Runtime is absent and before creating its replacement.

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
assignment update while the Runtime attachment is open performs:

1. validate and compile the immutable target revision;
2. close that Agent's data-plane admission gate;
3. update the assignment with resource-version compare-and-swap;
4. atomically publish the compiled snapshot;
5. clear the Agent's userspace flows and kernel conntrack;
6. reopen data-plane admission;
7. acknowledge the control request.

An acknowledged update means no later packet can be admitted by the previous
assignment. When the attachment is closed, the assignment CAS persists desired
policy but does not open packet admission; the next explicit attachment open
applies it. A policy update never calls Runtime Controller or changes Runtime
generation.

## 11. Lifecycle Workflows

### 11.1 Initial creation

1. Agent Controller persists the Agent, frozen Runtime configuration and durable
   operation, then returns admission. Its worker alone performs the following effects.
2. It calls Egress `EnsureAgentNetwork`, obtains the stable closed attachment, and
   copies that attachment into the Runtime configuration without reinterpretation.
3. It calls Runtime Controller `InitializeRuntime`. Runtime Controller creates
   the Agent workspace, privately allocates generation 1, injects platform
   invariants, and creates compute. The command completes as `provisioned`
   once the platform confirms create/start; it does not wait for health or
   Runtime `/status`.
4. Agent Controller opens the same attachment with its own resource-version
   CAS and verifies unchanged allocation/configuration facts. It stores the
   opaque `runtime_revision` and commits the configured Agent without an
   executable binding. Ensure alone never opens traffic.
5. Independently, Runtime Controller observes platform health and verifies
   Runtime `/status`. Agent Controller's observation worker reconciles pending
   Agents against these observations. A matching healthy observation appends
   an ExecutionRevision and publishes the executable configuration to ACP,
   which then admits Runs.

A definitive Initialize failure retains a non-executable `failed` Environment
and its resource ownership; compute and workspace may still exist. Exact retry
returns that terminal failure, not a second Initialize. Explicit Delete uses
the retained revision and removes owned compute and workspace. An unpublished
Agent binding is not proof of resource absence. Uncertain effects instead retain
the operation for exact-request reconciliation.

### 11.2 Explicit Runtime replacement

1. Agent Controller publishes the closed Agent configuration to ACP and
   requests Agent-level settlement. ACP stops admitting new Runs and settles
   active work.
2. It closes the Runtime attachment with attachment resource-version CAS.
   Egress owns packet fencing and flow/conntrack cleanup as one barrier, without
   changing desired network policy.
3. It calls Runtime Controller `UpdateRuntime` with the current
   `runtime_revision` and complete replacement configuration.
4. Runtime Controller removes the current compute resource, privately allocates
   the next generation, reuses the workspace, and creates replacement compute.
5. Agent Controller stores the returned revision, explicitly opens the same
   attachment with CAS after confirmed platform replacement, and commits the
   target configuration without an executable binding. The new executable
   binding is published after a matching healthy observation, as in initial
   creation.

There is intentionally no compute resource during Runtime Controller's
replacement. Failure to reset Egress, delete old compute, or create replacement
compute leaves the Agent without an executable binding, so ACP admits no Runs.

### 11.3 Disable and enable

Disable publishes the closed configuration and requests ACP settlement, closes
the network attachment, and calls `DisableRuntime` with the current revision.
Runtime Controller removes compute and retains workspace. Enable ensures the
closed attachment and uses the Agent's frozen configuration for
`EnableRuntime`; Runtime Controller verifies workspace ownership, allocates a
new private generation, and creates compute. Agent Controller then restores the
attachment; the new executable binding is published only after a matching
healthy observation. Neither command is equivalent to Agent deletion.

### 11.4 Unexpected Runtime restart

1. Docker or Kubernetes health policy restarts the failed process or resource.
2. Runtime Controller consumes platform List/Watch facts and records a Runtime
   observation; Watch is a latency path, not the recovery authority.
3. The restarted Runtime generates a new execution ID and becomes Healthy.
4. Runtime Controller verifies `/status` and records the new execution.
5. A Run pinned to the old execution ID is rejected before its next Tool
   dispatch; it is not transparently reconnected or replayed.
6. Agent Controller records the platform observation. Unexpected loss of an
   already published execution requires explicit lifecycle recovery before
   another executable binding is published.

### 11.5 Agent deletion

1. Persist deletion intent and close operation admission.
2. Publish the closed configuration and request ACP settlement with
   cancellation of current work. Ambiguous side effects become `unknown` and
   are never automatically replayed.
3. Fence the Agent network and clear flows and conntrack.
4. Call Runtime Controller `DeleteRuntime` with the current revision. Runtime
   Controller deletes compute and then its owned workspace as one lifecycle
   operation.
5. Release the network allocation into Egress quarantine with its network
   resource-version CAS; Egress requires the attachment to remain closed.
6. Publish `deleted` only after Runtime absence and network release are proven.

An address is never released while platform deletion is ambiguous.

## 12. Minimal Internal RPC Surface

```text
Runtime Controller
  InitializeRuntime(request_id, agent_id, configuration)
  UpdateRuntime(request_id, agent_id, expected_revision, configuration)
  DisableRuntime(request_id, agent_id, expected_revision)
  EnableRuntime(request_id, agent_id, expected_revision, configuration)
  DeleteRuntime(request_id, agent_id, expected_revision)
  InspectRuntime(agent_id)
  ListRuntimes()
  ListRuntimeObservations(after_sequence)
  WatchRuntimeObservations(after_sequence)

Runtime Egress
  EnsureAgentNetwork(agent_id)
  InspectAgentNetwork(agent_id)
  SetAgentNetworkAttachment(agent_id, state, expected_resource_version)
  ReleaseAgentNetwork(agent_id, expected_resource_version)
  CreatePolicyRevision(policy_id, revision, spec)
  AssignAgentPolicy(agent_id, policy_ref, expected_resource_version)
```

The Agent Controller and ACP surfaces are defined by the
[Agent Controller control contract](../contracts/agent-controller/control-api.md)
and the [ACP execution API](../contracts/agent-acp/execution-api.md). Runtime MCP and Runtime
`/status` remain their standard internal HTTP interfaces.
The names above describe business operations; exact Egress HTTP paths and
separate attachment/network CAS versions are in its
[control contract](../contracts/egress/control-api.md).

Runtime observations and Agent events use monotonic sequence numbers. Watch may
disconnect, duplicate, or lag; List plus sequence and `InspectRuntime` provide
recovery correctness.

### 12.1 Observation And Agent Event Ownership

Runtime Controller records only normalized deployment facts:

```text
RuntimeObservation
  sequence
  optional agent_id and runtime_revision (absent for service-wide recovery facts)
  execution_id, when known
  kind
  observed_at
  diagnostic_summary
```

Before a Runtime-scoped fact enters the journal, Runtime Controller privately
matches its platform generation and digest to one opaque revision. Physical
identity is retained for adapter diagnosis but omitted from the RPC message.

Platform List and `InspectRuntime` are current-state authority. Watch lowers
latency. A Watch gap produces service-wide `observation_gap`, current-state
reconciliation, then service-wide `reconciled`; this remains observable when
List is empty. Runtime Controller must not invent a restart cause, count, or
missing intermediate transition. A failed Runtime status check is
`status_unverified`, not a fabricated platform-unhealthy fact.

Agent Controller decides whether a platform fact requires an explicit rebuild.
Runtime Controller never updates an Agent binding or creates an Agent semantic
event. Runtime observations remain infrastructure facts; Agent Controller and
ACP Service own all Agent and Session consequences.

## 13. Failure And Recovery Semantics

- A timed-out mutation is inspected and retried with the same identifier. A
  timeout never causes an inverse mutation or a new generation automatically.
- Runtime Controller mutations are serialized per Agent across service
  replicas. Runtime compute and workspace deletion therefore cannot race.
  The advisory-lock session is monitored while the mutation runs, and a
  database constraint admits only one `running` or `unknown` request per Agent.
  If the session is lost, only that request ID may reconcile the ambiguous
  operation; a different request cannot overtake it. Each recovery claims a
  private attempt number, and only the newest attempt can commit terminal state.
  each private `(agent_id, generation)` is durably claimed by one revision and deployment digest even
  after compute deletion.
- One Runtime Controller replica owns platform List/Watch leadership. Durable
  observation commits wake every replica through PostgreSQL notification;
  consumers still recover solely from journal sequence and platform state.
- Runtime failure after a Tool may have started produces an `outcome_unknown`;
  the Tool is not automatically replayed. Runtime loss outside an in-flight
  Tool fails the pinned Run as `runtime_lost`.
- Every MCP request is fenced by the expected execution ID. This closes the
  interval in which a platform restart is already serving at the old endpoint
  but its Watch event has not yet reached Agent Controller.
- Agent Controller persists workflow phase before issuing a side effect and
  resumes non-terminal workflows by inspecting child components.
- Runtime Controller restart reconstructs state from deterministic platform
  names and labels, then resumes observation from its journal and platform
  List/Watch. A gap is a service-wide recovery fact, never fabricated as a
  known restart cause or count.
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
`agent_id`, `generation`, execution ID, Runtime operation ID, policy revision,
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
restart observations, Watch gaps, drift, readiness failures, and delete
convergence. Antnest Runtime retains its existing HTTP/tool tracing and
structured local lifecycle logs.

## 16. Component Scope

### Antnest Runtime

Antnest Runtime is implemented in Rust and provides:

- a root Supervisor and UID/GID 1000 one-shot executors;
- MCP `bash`, `read`, `write`, and `edit`;
- workspace and Skill roots, cancellation, process cleanup, status, and OTLP;
- TUN and one-inner-packet-per-UDP-datagram transport, aligned with the packet
  contract and Egress attachment described in section 6.

### Runtime Egress

Runtime Egress is an independent Rust crate and provides:

- Egress domain contracts and private PostgreSQL migrations;
- policy revisions and Agent assignments, implemented as pure domain logic;
- PID-style address allocation, quarantine, and recovery;
- bounded UDP peer and flow indexes;
- TUN uplink/downlink, rejection, the policy barrier, and cleanup;
- Runtime/Egress integration around language-neutral packet fixtures.

Network policy stays out of RuntimeSpec; the Runtime/Egress packet contract is
versioned as one unit.

### Runtime Controller

Runtime Controller is one thin Go service with an in-process Docker adapter.
It provides:

- Runtime `execution_id`, status output, and expected-execution MCP fencing,
  maintained as one lockstep contract;
- deterministic `Initialize`, `Update`, `Disable`, `Enable`, `Inspect`, and
  `Delete` without Agent rollout or Tool dispatch semantics;
- platform health and List/Watch consumption, bounded `/status` verification,
  and a bounded observation journal;
- Watch-gap recovery through List/Inspect.

### Outside Stage 1

Agent Controller and Agent ACP Service build on these boundaries. A
Kubernetes adapter is planned and not implemented. These interfaces prevent
Stage 1 components from absorbing Agent management or execution
responsibilities.

## 17. Verification Requirements

### 17.1 Runtime and Egress

The standalone `tests/e2e/e2e-stage1.sh` harness acts as the lifecycle caller;
it must follow the same Egress contract as Agent Controller. Allocation and an
allow policy do not open traffic. After Runtime readiness, the harness reads the
current management-network IPv4 from Docker and opens the attachment explicitly
with that peer, exercises policy changes without recreating Runtime,
then closes the attachment and removes compute before releasing the address.
Network allocation, attachment, and policy-assignment CAS versions are distinct;
the release request uses the network version, never the policy-assignment version.
Control-plane isolation is checked after successful open-attachment outbound
requests, so a globally closed gate cannot make it pass. Closing an already-open
attachment must also block a new outbound request before compute is removed;
this check alone does not claim established-connection drain coverage.

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

### 17.2 Runtime Controller

- Repeating any lifecycle command with the same request is idempotent; reusing
  its request ID with different content conflicts.
- Stale `runtime_revision` values are rejected before a platform mutation.
- Disable removes compute but retains workspace; Enable creates a new private
  generation over that workspace; Delete removes both.
- A Runtime is reported healthy only after platform Healthy and a bounded
  status verification; lifecycle commands do not wait for it.
- Restarting Runtime PID 1 without changing generation produces a new
  execution ID and an ordered observation.
- Runtime rejects MCP calls carrying a stale expected execution ID before Tool
  dispatch.
- A disconnected Watch resumes through sequence plus List/Inspect without
  losing current-state convergence or inventing a restart cause.
- Docker adapter code is private to Runtime Controller and there is no
  separate Runtime Provider service.
