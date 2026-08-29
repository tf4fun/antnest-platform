# Runtime Egress Architecture

## 1. Domain

Runtime Egress has four durable concepts and two ephemeral concepts.

### Durable

1. **Address pool**: an IPv4 CIDR, rotating allocation cursor, and quarantine
   duration.
2. **Agent network**: the stable Tunnel IPv4 currently owned by one Agent.
3. **Policy revision**: one immutable, schema-versioned policy document.
4. **Policy assignment**: the exact policy revision currently applied to one
   Agent, guarded by a resource version.

### Ephemeral

1. **UDP peer**: the outer source `IP:port` observed with a Runtime datagram.
2. **Flow**: the first-owner association from an inner TCP five-tuple to one UDP
   peer and one policy assignment version.

Runtime generation is deliberately absent. All generations of one Agent share
its address and policy. Agent Controller prevents concurrent Agent operations
and resets flows between generations.

## 2. Trust Model

Docker or Kubernetes networking is trusted for Stage 1. The control listener is
reachable only by internal control-plane services. The UDP listener is reachable
by Runtime containers. Runtime cannot reach Egress PostgreSQL or the control
listener.

The UDP source address is a return locator, not a durable or cryptographic
identity. Egress still validates every inner packet and requires its source
address to be an active Agent Tunnel IPv4.

## 3. Rust Module Boundaries

The target crate uses the following modules:

| Module | Responsibility | Must not depend on |
| --- | --- | --- |
| `config` | Parse and validate process configuration | Database, packet engine |
| `domain` | Agent network, policy revision, assignment, and state invariants | Tokio, HTTP, SQL, Linux |
| `allocator` | PID-style slot selection and quarantine transitions | HTTP, packet bytes |
| `policy` | Validate, compile, and evaluate immutable policy snapshots | PostgreSQL, sockets |
| `packet` | Parse IPv4/TCP, derive flow keys, and build TCP rejection | Database, policy storage |
| `flow` | Bounded first-owner flow table and reverse lookup | SQL, kernel commands |
| `dataplane` | Coordinate UDP, TUN, policy snapshot, and flow ownership | HTTP DTOs, PostgreSQL |
| `repository` | Egress PostgreSQL migrations and transactional control writes | UDP, TUN |
| `control` | Map internal RPCs to application operations and stable errors | Linux implementation details |
| `kernel` | TUN, routes, nftables/NAT, and conntrack cleanup | Agent or policy semantics |
| `telemetry` | Logs and control-plane trace wiring | Packet payload logging |
| `application` | Mutation barriers and orchestration across domain ports | Axum extractors, raw SQL |

Unsafe Rust is allowed only in the Linux TUN adapter and must be wrapped by a
small safe API with Linux container tests. Packet parsing and flow logic remain
safe Rust.

The crate's public Rust modules exist only so the service binary and black-box
integration tests can share implementation code. They are not a cross-service
library API. Other Antnest services consume only the contracts under
`contracts/` and must not take a path dependency on this crate.

## 4. Persistence

The service owns these tables:

```text
schema_migrations
  version bigint primary key
  name text not null unique
  checksum text not null
  applied_at timestamptz not null

address_pools
  pool_id text primary key
  cidr cidr not null
  resolver_ipv4 inet not null
  next_slot bigint not null
  quarantine_seconds bigint not null
  resource_version bigint not null

agent_networks
  agent_id text primary key
  pool_id text not null references address_pools
  tunnel_ipv4 inet not null unique
  state text not null
  resource_version bigint not null
  quarantine_until timestamptz null
  created_at timestamptz not null
  updated_at timestamptz not null

policy_revisions
  policy_id text not null
  revision bigint not null
  schema_version bigint not null
  canonical_spec jsonb not null
  digest text not null
  created_at timestamptz not null
  primary key (policy_id, revision)

agent_policy_assignments
  agent_id text primary key references agent_networks
  policy_id text not null
  revision bigint not null
  resource_version bigint not null
  updated_at timestamptz not null
  foreign key (policy_id, revision) references policy_revisions
```

`schema_migrations` records every ordered migration, including bootstrap, by
version, stable name, and SHA-256 checksum. Bootstrap creates the schema,
history table, and its own history row in one transaction. Startup rejects an
unexpected schema owner and unknown, reordered, renamed, or modified applied
migrations; each missing migration and its history row commit in one
transaction. Reconciliation then inserts one configured address pool and the
immutable `allow_all` and `deny_all` policy revisions. Missing, invalid, or
unloadable assignment always compiles to deny-all.

The PostgreSQL connection driver publishes availability changes. Transport loss
immediately marks the control plane degraded but does not replace the last
packet snapshot. The next control operation reconnects, revalidates migrations,
ownership, and seed data, and restores control readiness after it succeeds.

The packet path uses an in-memory snapshot built from one consistent database
read and replaced under the data-plane consistency lock. PostgreSQL is never
queried per packet.

## 5. Address Allocation

Allocation behaves like a PID allocator:

1. Lock the requested pool row in a transaction.
2. Return the existing active Agent allocation when present.
3. Starting at `next_slot`, scan usable host slots with wraparound.
4. Skip the virtual resolver/gateway, active rows, and quarantined rows.
5. Insert the Agent network and advance the cursor in the same transaction.

Release is a barrier, not a delete:

1. Close Agent packet admission and persist deny-all.
2. Remove userspace flows and corresponding conntrack entries.
3. Transition the active allocation directly to `quarantined` with a durable
   deadline.
4. A sweeper deletes the row only after the deadline and another cleanup check.

Agent IDs are never reused. The numerical Tunnel IP may be reused only after
the old Agent row has completed quarantine.

## 6. Policy Model

Policy revisions are immutable. Stage 1 schema version 1 is:

```json
{"schema_version":1,"action":"allow_all"}
```

or:

```json
{"schema_version":1,"action":"deny_all"}
```

Later schemas may add protocol, destination CIDR, port, and domain-derived
rules. Runtime and the UDP packet format do not change when policy grows.

Assignment uses compare-and-swap on `resource_version`. One ephemeral Agent
operation lock serializes policy assignment, flow reset, fence, release, and
quarantine cleanup. The weak lock registry does not retain historical or
invalid Agent IDs. Packet admission is separate immutable data-plane state and
never waits for the operation lock.

The packet loop holds one short output barrier from classification through the
actual UDP/TUN write. Closing Agent admission and then acquiring that barrier
drains the one packet that may already be in flight. The barrier is released
before SQL or kernel cleanup, so another Agent never waits for the full control
operation.

The policy mutation barrier is:

```text
compile -> close Agent packet admission -> commit CAS
        -> clear flows -> clear conntrack
        -> publish snapshot -> explicitly reopen -> acknowledge
```

If the process exits after database commit, cold-start fail-closed recovery
loads and applies the committed assignment before becoming ready.
Any post-fence ambiguity or cleanup failure leaves that Agent fenced. A complete
retry reconciles durable assignment, kernel state, and snapshot before reopening.

## 7. Packet Contract

Stage 1 accepts one complete, unfragmented IPv4/TCP packet no larger than 1400
bytes per UDP datagram. It rejects trailing bytes, invalid total length, IP
options outside the supported contract, fragments, invalid TCP header length,
unsupported protocols, and invalid source Tunnel addresses.

Runtime and Egress consume the same language-neutral packet fixtures. Each has
its own parser implementation; no shared Rust source crate couples the two
deployables.

## 8. Uplink Algorithm

1. `recv_from` returns the datagram and outer Runtime UDP peer.
2. Parse and validate the inner packet.
3. Resolve inner source Tunnel IPv4 to an active Agent network.
4. Check that Agent's packet-admission bit without waiting.
5. Evaluate the current immutable policy snapshot.
6. On deny, create no flow and send a TCP reset to the same UDP peer.
7. Derive the canonical forward and reverse flow keys.
8. Atomically claim a missing flow for this peer. An existing flow owned by a
   different peer is a collision and cannot be replaced.
9. Recheck assignment version and flow ownership immediately before TUN write.
10. Write the complete packet to TUN.

## 9. Downlink Algorithm

1. Read one packet from TUN and validate it.
2. Resolve destination Tunnel IPv4 to an active Agent network.
3. Derive the reverse flow key.
4. Require a current flow whose assignment version matches the Agent snapshot.
5. Recheck packet admission and flow ownership immediately before `send_to`.
6. Send the complete packet as one UDP datagram to the owning peer.

Downlink never creates a flow. Unknown, expired, stale, malformed, or
unsolicited packets are dropped.

## 10. Flow Lifecycle

The flow table is bounded globally and per Agent. The first structurally valid
allowed outbound packet claims a flow, so retransmitted or mid-connection
packets do not require a special SYN branch. Idle flows expire during packet
processing; policy changes, Runtime rollout, fence, and release remove all
flows for that Agent explicitly.

The table maintains forward lookup, reverse lookup, Agent ownership, and peer
ownership under one consistency boundary. Capacity rejection and flow collision
fail fast without evicting an unrelated active flow.

At Runtime rollout, Agent Controller first confirms the old Runtime absent and
then calls `ResetAgentFlows`. Candidate receives no Agent work until reset is
acknowledged. Egress therefore does not model active/candidate generations.

## 11. Kernel Adapter

At startup, the Linux adapter:

1. creates the Egress TUN device;
2. assigns the virtual resolver/gateway address and pool route;
3. verifies that the deployment platform enabled IPv4 forwarding in the
   container network namespace;
4. installs idempotent nftables forwarding and masquerade rules;
5. prepares conntrack cleanup for individual Agent addresses.

Docker or Kubernetes owns namespace sysctls; the service never mutates them at
runtime. Startup and control operations may invoke bounded `ip`, `nft`, and
`conntrack` commands. The packet path never spawns a command. Kernel commands
include a deadline, terminate and reap the child on timeout, continuously drain
but retain only bounded stderr, discard stdout, and use deterministic
Antnest-owned table and chain names.

The virtual resolver is a bounded DNS-over-TCP proxy to one deployment-provided
upstream. Egress does not hard-code a public DNS service or persist DNS cache;
resolver selection remains a deployment concern while Agent DNS still follows
the governed TCP data path.

## 12. Concurrency

- UDP receive, TUN receive, control HTTP, expiry, and quarantine sweeping are
  separate Tokio tasks under one cancellation tree.
- The Linux TUN adapter uses readiness-aware nonblocking file-descriptor I/O;
  an empty device reports ordinary backpressure rather than a task failure.
- One packet loop owns UDP and TUN I/O; a short process-local consistency lock
  coordinates its pure in-memory state with control mutations. The lock never
  covers SQL, kernel commands, or socket I/O.
- A separate output barrier covers only one packet classification/write and is
  used briefly to establish the fence boundary; it never covers SQL or kernel
  commands.
- Compiled policy values are immutable and snapshots are replaced under that
  consistency boundary.
- Agent operation locks are sharded; packet admission is non-blocking, so a
  mutation may drain one current output but does not stall packet processing
  for the duration of that Agent's control operation.
- All queues and buffers are bounded; overload drops packets rather than
  growing memory without limit.
- OTLP traces are restricted to trusted control RPCs. Packet, flow, DNS, and
  maintenance paths never emit per-packet logs or OTLP spans; they emit only
  bounded local aggregates and task-level fatal events.
- A fatal UDP, TUN, or kernel-state failure cancels the process. Container
  restart is the recovery mechanism.

## 13. Failure Semantics

- Cold start is fail-closed until database snapshot, TUN, UDP, policy engine,
  and kernel rules are ready.
- Warm database loss leaves the last applied data-plane snapshot active but
  rejects control mutations and address allocation.
- Egress restart clears userspace flows and Antnest-owned conntrack. Existing
  connections fail; new Runtime packets relearn return peers.
- A control RPC timeout is resolved by inspection and identical retry.
- A failed cleanup keeps the Agent fenced and prevents address quarantine from
  completing.
- Unknown or malformed packets never mutate durable or flow state.

## 14. Extension Rules

1. New policy capabilities start as a new immutable policy schema version.
2. New inner packet protocols update the shared packet contract and fixtures
   before Runtime or Egress code.
3. Data-plane hot paths cannot gain database or control-HTTP dependencies.
4. Egress never gains Runtime-generation lifecycle state.
5. Horizontal Egress scaling requires explicit address-pool sharding and is not
   approximated with a stateless load balancer.
