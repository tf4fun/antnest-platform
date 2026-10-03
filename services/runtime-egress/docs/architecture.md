# Runtime Egress Architecture

This document describes the Runtime Egress domain model, process shape, module
boundaries, persistence, policy barriers, packet algorithms, concurrency, and
failure semantics.

## 1. Domain

Runtime Egress has five durable concepts and two ephemeral concepts.

### Durable

1. **Address pool**: an IPv4 CIDR, rotating allocation cursor, and quarantine
   duration.
2. **Agent network**: the stable Tunnel IPv4 currently owned by one Agent.
3. **Policy revision**: one immutable, schema-versioned policy document.
4. **Policy assignment**: the exact desired policy revision assigned to one
   Agent, guarded by a resource version.
5. **Runtime attachment**: the independent, versioned lifecycle gate. Saving an
   allow policy cannot open a closed attachment.

### Ephemeral

1. **UDP peer**: the outer source `IP:port` observed with a Runtime datagram.
2. **Flow**: the first-owner association from an inner TCP five-tuple to one UDP
   peer and one policy assignment version.

Runtime generation is deliberately absent. All generations of one Agent share
its address and policy. Agent Controller prevents concurrent Agent operations
and resets flows between generations.

### Process shape

The Rust crate is one process and one failure domain:

```text
control HTTP -> application -> policy / allocator -> PostgreSQL
                                  |
Runtime UDP -> packet -> flow -> policy snapshot -> TUN -> Linux NAT
               ^          |
               `----------`------------------------ return UDP
```

The control path may allocate and open database transactions. The packet path
must not query PostgreSQL, spawn commands, serialize JSON, or wait for a global
service lock. Agent admission is a non-blocking snapshot lookup: a fenced Agent
is dropped and counted without delaying packets owned by another Agent. A
short output barrier drains at most the packet already being written when a
fence begins; it is released before database or kernel work starts.

The deployment is deliberately single-replica. PostgreSQL preserves durable
allocation and policy state, but the TUN device, flow table, UDP peers, kernel
rules, and process-local snapshot revision have exactly one writer. A generic
load balancer or a second active Egress replica is unsupported until a separate
ownership and failover design is introduced.

## 2. Trust Model

Docker or Kubernetes networking is trusted. The control listener
binds one explicit control-network address and is reachable only by internal
control-plane services; a wildcard control bind is rejected. The UDP listener
binds the single advertised Runtime-network address rather than a wildcard, so
joining control and external networks does not expose the packet socket on
those interfaces. Runtime cannot reach Egress PostgreSQL or the control
listener.

The UDP source address is a return locator, not a durable or cryptographic
identity. Egress still validates every inner packet and requires its source
address to be an active Agent Tunnel IPv4.

## 3. Rust Module Boundaries

The crate uses the following modules:

| Module | Responsibility | Must not depend on |
| --- | --- | --- |
| `config` | Parse and validate process configuration | Database, packet engine |
| `domain` | Agent network, policy revision, assignment, and state invariants | Tokio, HTTP, SQL, Linux |
| `allocator` | PID-style slot selection and quarantine transitions | HTTP, packet bytes |
| `policy` | Validate, compile, and evaluate immutable policy snapshots, including the non-bypassable special/private-address baseline and resolver exception | PostgreSQL, sockets |
| `packet` | Parse IPv4/TCP, derive flow keys, and build TCP rejection | Database, policy storage |
| `flow` | Bounded first-owner flow table and reverse lookup | SQL, kernel commands |
| `dataplane` | Coordinate UDP, TUN, compiled-policy decisions, and flow ownership; it never reimplements destination policy | HTTP DTOs, PostgreSQL |
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
`contracts/` and must not take a path dependency on this crate. Conversely, the
crate depends on the root contracts as an intentional versioned monorepo
dependency rather than a copy, so it is built and tested from the repository
root.

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
unexpected existing schema owner before issuing any DDL or DML, then rejects
unknown, reordered, renamed, or modified applied migrations; each missing
migration and its history row commit in one transaction. Reconciliation then
inserts one configured address pool and the immutable `allow_all` and
`deny_all` policy revisions. An Agent absent from the active in-memory snapshot
is denied by default. Invalid or unloadable persisted rows make the initial
snapshot fail before listeners open; Egress never guesses policy from corrupt
authority data.

PostgreSQL access uses a small bounded connection pool. The pool mutex protects
only the idle-client queue and is never held across a SQL await, so a lock wait
for one Agent cannot serialize unrelated Agent control operations. Connection
acquisition, transport establishment, statements, and lock waits all have
finite deadlines. Each complete repository operation also has a client-side
deadline; expiry discards that connection instead of returning a client with an
unknown in-flight request to the pool. Every newly established client
revalidates migrations, ownership, and seed data before entering the pool.

The connection drivers publish aggregate availability changes. Losing one
pooled connection does not degrade the control plane while another validated
connection remains live. Losing the last live connection immediately marks the
control plane degraded but does not replace the last packet snapshot. A later
validated connection restores control readiness. A statement, lock, or
persisted-row decoding failure belongs to its current control RPC and does not
change global readiness while validated connections remain live.

Global readiness represents shared infrastructure only. A failed conntrack
cleanup leaves that Agent fenced and observable but cannot make unrelated Agent
control or packet paths unready. Health transitions pass through one structured
event path, while the periodic metrics snapshot reports global readiness and the
aggregate fenced-Agent count without Agent labels.

Repository pool health is the sole authority for global control readiness.
Individual RPC outcomes, including pool acquisition timeout, SQL timeout, and
connection failure, return their scoped error but never flip readiness directly;
the pool's validated-live-connection transition does that once for the process.

Quarantine reclamation has the same failure boundary. Each expired Agent is
cleaned independently; a kernel cleanup failure leaves only that Agent fenced
and retained while the sweep continues with the remaining candidates. Database
unavailability remains a shared control-plane failure.

The packet path uses an in-memory snapshot built from one consistent database
read and replaced under the data-plane consistency lock. PostgreSQL is never
queried per packet.

Packet-loop failures are classified by ownership. Loss of the shared UDP
listener or TUN device is fatal and lets the container platform restart Egress.
An explicit peer refusal, host-unreachable response, or peer-path MTU failure
removes only that Agent's flows for that peer, increments an aggregate counter,
and leaves the shared packet loop running. Shared UDP interface/route errors and
output deadline expiry are fatal; swallowing them as peer-local loss would leave
Egress reporting ready while every Agent loses downlink traffic.

## 5. Address Allocation

Allocation behaves like a PID allocator:

1. Lock the requested pool row in a transaction.
2. Return the existing active Agent allocation when present.
3. Starting at `next_slot`, scan usable host slots with wraparound.
4. Skip the virtual resolver/gateway, active rows, and quarantined rows.
5. Insert the Agent network and advance the cursor in the same transaction.

Release is a barrier, not a delete:

1. Require a closed attachment and validate the network resource-version CAS.
2. Commit the active allocation as `quarantined` with a durable deadline;
   desired policy is not rewritten. Stale release has no live side effect.
3. Remove the probe-only route and repeat bounded userspace/conntrack cleanup;
   an exact release retry reconciles cleanup from durable quarantine.
4. A sweeper deletes the row only after the deadline and another cleanup check.

Agent IDs are never reused. The numerical Tunnel IP may be reused only after
the old Agent row has completed quarantine.

## 6. Policy Model

Policy revisions are immutable. Schema version 1 is:

```json
{"schema_version":1,"action":"allow_all"}
```

or:

```json
{"schema_version":1,"action":"deny_all"}
```

The policy universe excludes platform and special-use address space. In schema
version 1, `allow_all` means all externally routable IPv4 destinations plus TCP
DNS to the configured virtual resolver; it never permits loopback, link-local,
private, shared Tunnel, multicast, documentation, benchmarking, or reserved
destinations. This invariant prevents an Agent from routing through Egress back
into Docker/Kubernetes control networks or another Runtime's unauthenticated
MCP listener.

Later schemas may add protocol, destination CIDR, port, and domain-derived
rules, including explicit enterprise-internal destinations. Runtime and the UDP
packet format do not change when policy grows.

Assignment uses compare-and-swap on `resource_version`. One ephemeral Agent
operation lock serializes policy assignment, flow reset, fence, release, and
quarantine cleanup. The weak lock registry does not retain historical or
invalid Agent IDs. Each immutable route snapshot carries its admission gate:
`open`, `probe_only`, or `hard_fenced`. Route identity, policy, and gate are
therefore replaced atomically instead of being split across a route map and a
second fence set. Packet admission never waits for the operation lock.

A same-policy/revision assignment on an open, already-applied, unfenced route
validates the request through the Repository CAS but does not reset flows or
conntrack. Stale versions still conflict. A matching database value alone is
insufficient: a fenced or unapplied route follows the full repair barrier below.

The packet loop holds one short output barrier from classification through the
actual UDP/TUN write. Closing Agent admission and then acquiring that barrier
drains the one packet that may already be in flight. The barrier is released
before SQL or kernel cleanup, so another Agent never waits for the full control
operation.

The policy mutation barrier is:

```text
compile -> close Agent packet admission -> clear flows -> clear conntrack
        -> commit CAS
        -> publish snapshot -> explicitly reopen -> acknowledge
```

If the process exits after database commit, cold-start fail-closed recovery
loads and applies the committed assignment before becoming ready.
Any post-fence ambiguity or cleanup failure leaves that Agent fenced. A complete
retry reconciles durable assignment, kernel state, and snapshot before reopening.
Ensure follows this cleanup barrier when restoring an already-open route, but
does not touch connections on a healthy, already-applied route. Attachment open
also completes cleanup before its CAS, including same-state retries. Neither
operation treats a matching durable version as proof that a hard fence is safe
to remove. Reconciliation applies the persisted policy, not an uncommitted
target from a failed mutation.

The control read of an immutable policy revision returns its canonical spec and
digest through the existing repository port. It has no mutation barrier because
the addressed revision cannot change, and it does not copy policy into another
service's database. Consumers read the assignment's exact revision rather than
guessing its action from the policy ID. Desired policy inspection is not a
packet-gate health probe; a control failure remains unresolved until a complete
mutation retry settles the barrier.

## 7. Packet Contract

The packet contract accepts one complete, unfragmented IPv4/TCP packet no
larger than 1400 bytes per UDP datagram. It rejects trailing bytes, invalid total length, IP
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
processing; policy changes, attachment closure, and release remove all
flows for that Agent explicitly.

The table maintains forward lookup, reverse lookup, Agent ownership, and peer
ownership under one consistency boundary. Capacity rejection and flow collision
fail fast without evicting an unrelated active flow.

At Runtime replacement, Agent Controller closes the Runtime attachment before
requesting replacement. Egress first installs `hard_fenced`, drains packet
writers, and clears userspace and conntrack flows. Only then does it commit
durable `closed` and publish `probe_only`. Opening after Runtime readiness
applies the current desired policy. Egress therefore models neither
active/candidate generations nor Runtime lifecycle phases.

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
the governed TCP data path. Admission has both a process-wide connection limit
and a per-source tunnel-address limit. A single Runtime therefore cannot consume
all DNS proxy slots, while metrics remain aggregate and never use an Agent or
tunnel address as a label.

Runtime readiness uses no Egress control RPC. Once Agent Controller has created
the network allocation, Runtime sends the canonical TCP SYN defined by the
shared packet contract through the raw-packet UDP endpoint to `192.0.2.1:9`.
For a closed attachment, only the `probe_only` gate may return the local
correlated RST+ACK; every near miss remains fenced. For an open attachment the
immutable special-use-address baseline produces the same local rejection. The
reply proves the assigned Runtime-to-Egress packet path without creating a
flow, reaching an upstream, or adding a session protocol to the data plane.

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
- OTLP traces are restricted to control HTTP (including local `/status`) and
  Egress-owned PostgreSQL query/execute and transaction API boundaries. A single
  private-handle Client/Transaction wrapper observes SQL without exposing a native
  handle to repository helpers; pool and operation-deadline semantics stay local
  to the existing adapter. Packet, flow and DNS paths never
  emit per-packet logs or spans; they emit only bounded local aggregates and
  task-level fatal events. Recovery/sweep storage operations use the same
  database boundary, not per-packet or per-flow observation.
- A shared UDP socket can receive delayed ICMP errors without the originating
  peer. Known destination-level ICMP errors are counted and dropped without
  mutating any Agent flow; they can neither kill Egress nor be charged to an
  arbitrary current peer. Local socket, TUN, or kernel-state failures remain
  fatal and container restart is the recovery mechanism.

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
6. Dependency updates, in particular to hashing libraries, must preserve
   persisted policy digests and migration checksums.

## Service authentication rollout

The [platform authentication contract](../../../contracts/platform/service-authentication.md)
and this service's [planned caller catalog](../../../contracts/egress/callers.json) define verified
workload identity and route-specific caller context. Listener enforcement is
pending in [#32](https://github.com/tf4fun/antnest-platform/issues/32), [#34](https://github.com/tf4fun/antnest-platform/issues/34), [#36](https://github.com/tf4fun/antnest-platform/issues/36); this foundation does not change the current HTTP
authorization behavior. Follow the [rollout ledger](../../../contracts/platform/service-authentication-rollout.json)
and run the shared route/media-type checks in the owning-service batch before
the cross-service Docker security acceptance.
