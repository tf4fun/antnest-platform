# Runtime Egress

> Implementation status: the Rust service, contracts, migrations, Linux
> container path, PostgreSQL recovery, and Runtime/Egress acceptance are
> implemented.

Runtime Egress is Antnest's privileged Agent network service. It gives each
Agent one stable Tunnel IPv4 address, stores and applies that Agent's network
policy, and forwards validated Runtime packets between UDP and a Linux TUN
device.

Rust is the required implementation language. Egress has a narrow, stable
domain but owns packet parsing, bounded flow state, Linux network integration,
and long-lived concurrent I/O. Rust makes those resource lifetimes explicit
without adding a garbage-collected pause or a second low-level helper process.

## Responsibilities

- Own a private PostgreSQL schema and migrations.
- Allocate one stable Tunnel IPv4 per Agent and quarantine released addresses.
- Store immutable policy revisions and versioned Agent-policy assignments.
- Expose exact policy revision reads so control clients can display the policy
  document without guessing from its identifier.
- Compile policy into immutable in-memory snapshots.
- Receive one complete inner IP packet per Runtime UDP datagram.
- Resolve the inner source Tunnel IP to an Agent and apply its current policy.
- Bind each inner flow to the outer Runtime UDP peer that first created it.
- Route return packets from TUN to the owning UDP peer.
- Produce fast TCP rejection for valid policy-denied traffic.
- Clear userspace flow and kernel conntrack state at policy, Runtime replacement, and
  deletion barriers.
- Export structured local logs, OTLP metrics for control RPCs and periodic
  aggregate data-plane snapshots, and OTLP traces for control RPCs only.

## Non-Responsibilities

- It does not know Runtime generations, active/candidate state, Runs, prompts,
  Tools, model providers, users, or Agent lifecycle.
- It does not create containers, Pods, volumes, routes inside Runtime, or Agent
  workspaces.
- It does not read another service's database.
- It does not persist UDP peers, packets, flows, queues, DNS cache, or conntrack.
- It does not implement an external API or end-user authentication.
- It does not add a custom identity, token, session, or tracing envelope to the
  Runtime UDP packet format.

## Interfaces

| Direction | Interface |
| --- | --- |
| Internal control | Trusted-network HTTP/JSON RPC on the control listener |
| Runtime data | One complete inner IPv4/TCP packet per UDP datagram |
| Kernel | `/dev/net/tun`, Linux routes, nftables/NAT, and conntrack cleanup |
| Persistence | Egress-owned PostgreSQL schema and role |
| Operations | `GET /status`, structured stderr logs, OTLP control spans and low-cardinality metrics |

The language-neutral control semantics are defined in
[`../../contracts/egress/control-api.md`](../../contracts/egress/control-api.md).
The Runtime packet bytes remain defined by
[`../../contracts/runtime/packet-format.md`](../../contracts/runtime/packet-format.md),
with revision and fixed constants owned by
[`../../contracts/runtime/packet-contract.json`](../../contracts/runtime/packet-contract.json).
These root contracts are an intentional versioned monorepo dependency, not a
copy of another service's implementation or storage model. Build and test this
independently deployable service from the repository root so the authoritative
language-neutral contracts are present; do not duplicate them inside the crate.

## Implementation Shape

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

The Stage 1 deployment is deliberately single-replica. PostgreSQL preserves
durable allocation and policy state, but the TUN device, flow table, UDP peers,
kernel rules, and process-local snapshot revision have exactly one writer. A
generic load balancer or a second active Egress replica is unsupported until a
separate ownership and failover design is introduced.

## Development Sequence

The rewrite follows `doc -> test -> code`:

1. Freeze this service document and the language-neutral contracts.
2. Add failing domain, allocation, packet, flow, policy, and repository tests.
3. Implement pure domain and in-memory data-plane components.
4. Implement PostgreSQL and Linux adapters.
5. Add Runtime/Egress container integration and real allow/deny traffic tests.

The local admission commands are:

```bash
cargo fmt --all --check
cargo clippy --locked --all-targets -- -D warnings
cargo test --locked
```

See [`docs/architecture.md`](docs/architecture.md),
[`docs/operations.md`](docs/operations.md),
[`docs/observability.md`](docs/observability.md), and the cross-service
[`../../docs/stage-1-runtime.md`](../../docs/stage-1-runtime.md).
