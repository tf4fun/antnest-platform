# Runtime Egress

Runtime Egress is Antnest's privileged Agent network service. It gives each
Agent one stable Tunnel IPv4 address, stores and applies that Agent's network
policy, and forwards validated Runtime packets between UDP and a Linux TUN
device. It is written in Rust.

Egress has a narrow, stable domain but owns packet parsing, bounded flow state,
Linux network integration, and long-lived concurrent I/O. Rust makes those
resource lifetimes explicit without a garbage-collection pause or a second
low-level helper process. The control path may use PostgreSQL; the packet path
never queries the database, spawns commands, or waits on a global lock.

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
- Clear userspace flow and kernel conntrack state at policy, Runtime
  replacement, and deletion barriers.
- Export structured local logs, OTLP metrics for control RPCs and periodic
  aggregate data-plane snapshots, and OTLP traces for control HTTP requests and
  Egress-owned PostgreSQL calls.

## Non-responsibilities

- It does not know Runtime generations, active/candidate state, Runs, prompts,
  Tools, model providers, users, or Agent lifecycle.
- It does not create containers, Pods, volumes, routes inside Runtime, or Agent
  workspaces.
- It does not read another service's database.
- It does not persist UDP peers, packets, flows, queues, DNS cache, or conntrack.
- It does not implement an external API or end-user authentication.
- It does not add a custom identity, token, session, or tracing envelope to the
  Runtime UDP packet format.
- It does not run as more than one active replica.

## Interfaces

| Direction | Interface | Purpose |
| --- | --- | --- |
| Inbound | Control HTTP/JSON on `ANTNEST_EGRESS_CONTROL_LISTEN`: `/internal/agent-networks/{agent_id}`, `/internal/agent-network-attachments/{agent_id}`, `/internal/agent-networks/{agent_id}/release`, `/internal/policies/{policy_id}/revisions/{revision}`, `/internal/agent-policy-assignments/{agent_id}` | Trusted-network RPCs for address allocation, attachment gates, release, policy revisions, and assignments |
| Inbound | `GET /status` on the control listener | Local process, data-plane, and control-plane readiness |
| Inbound | UDP on `ANTNEST_EGRESS_UDP_ADVERTISE` | One complete inner IPv4/TCP packet per datagram from Runtime |
| Outbound | UDP to the owning Runtime peer | Return packets and local TCP rejections |
| Kernel | `/dev/net/tun`, Linux routes, nftables/NAT, conntrack | Packet forwarding, masquerade, and per-Agent cleanup |
| Outbound | DNS over TCP to `ANTNEST_EGRESS_DNS_UPSTREAM` | Virtual resolver proxy for Agent DNS |
| Outbound | PostgreSQL | Egress-owned schema and role |
| Outbound | OTLP HTTP | Control spans and low-cardinality metrics when enabled |

The control semantics are defined in
[`../../contracts/egress/control-api.md`](../../contracts/egress/control-api.md).
The Runtime packet bytes are defined by
[`../../contracts/runtime/packet-format.md`](../../contracts/runtime/packet-format.md),
with revision and fixed constants owned by
[`../../contracts/runtime/packet-contract.json`](../../contracts/runtime/packet-contract.json).
These root contracts are an intentional versioned monorepo dependency. Build
and test the service from the repository root so they are present; do not copy
them into the crate.

## Configuration

Configuration is read from the environment at startup and is immutable
afterwards. Durations accept a positive integer with an optional `ms`, `s`, `m`,
or `h` suffix; a bare number means seconds.

| Variable | Required | Default | Description |
| --- | --- | --- | --- |
| `ANTNEST_EGRESS_DATABASE_URL` | yes | none | Egress-owned PostgreSQL connection URL |
| `ANTNEST_EGRESS_DATABASE_TLS_MODE` | no | `require` | `require` validates against native trust roots; `disable` is for isolated local development only |
| `ANTNEST_EGRESS_DATABASE_STARTUP_TIMEOUT` | no | `30s` | Maximum cold-start wait for PostgreSQL reachability |
| `ANTNEST_EGRESS_DATABASE_RETRY_DELAY` | no | `250ms` | Delay between cold-start connection attempts |
| `ANTNEST_EGRESS_CONTROL_LISTEN` | no | `127.0.0.1:8081` | Control HTTP listener; must be an explicit IPv4 address with a non-zero port, never a wildcard |
| `ANTNEST_EGRESS_UDP_ADVERTISE` | yes | none | Usable unicast IPv4 `address:port` used both as the UDP bind address and in Runtime network attachments |
| `ANTNEST_EGRESS_TUNNEL_CIDR` | no | `100.64.0.0/10` | Agent Tunnel IPv4 pool |
| `ANTNEST_EGRESS_RESOLVER_IPV4` | no | `100.64.0.1` | Virtual resolver/gateway address; must be usable inside the pool |
| `ANTNEST_EGRESS_QUARANTINE` | no | `5m` | Released-address quarantine duration |
| `ANTNEST_EGRESS_MAX_FLOWS` | no | `65536` | Global flow bound; must be non-zero |
| `ANTNEST_EGRESS_MAX_AGENT_FLOWS` | no | `1024` | Per-Agent flow bound; must be non-zero and not exceed the global bound |
| `ANTNEST_EGRESS_FLOW_IDLE` | no | `5m` | Inactive flow expiry |
| `ANTNEST_EGRESS_DNS_UPSTREAM` | yes | none | DNS-over-TCP upstream socket address used by the virtual resolver |
| `ANTNEST_EGRESS_TUN_NAME` | no | `antnest-egress0` | Linux TUN name; 1-15 ASCII letters, digits, `-`, or `_` |
| `ANTNEST_EGRESS_COMMAND_TIMEOUT` | no | `5s` | Bound for each `ip`, `nft`, and `conntrack` command |
| `RUST_LOG` | no | `info,hyper=warn,reqwest=warn` | Log filter; only `antnest_runtime_egress` targets reach stderr |
| `OTEL_SDK_DISABLED` | no | `true` | `true` or `1` disables OTLP export while keeping local trace correlation |
| `ANTNEST_TELEMETRY_CAPTURE_RPC_CONTENT` | no | `false` | `true` records complete control RPC JSON, which can include secrets |
| `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT` | no | `http://127.0.0.1:4318/v1/traces` | OTLP HTTP traces endpoint |
| `OTEL_EXPORTER_OTLP_METRICS_ENDPOINT` | no | `http://127.0.0.1:4318/v1/metrics` | OTLP HTTP metrics endpoint |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | no | `http://127.0.0.1:4318` | Fallback OTLP HTTP base URL; `/v1/traces` and `/v1/metrics` are appended |

Packet revision and inner MTU come only from the packet contract and have no
environment variables. Deployment guidance for these settings is in
[Operations](docs/operations.md#2-configuration).

## Dependencies

- PostgreSQL database and role owned by this service. Cold start retries the
  connection until `ANTNEST_EGRESS_DATABASE_STARTUP_TIMEOUT`, then exits; the
  listeners open only after migrations and the initial snapshot succeed. Losing
  every validated connection later marks the control plane degraded while the
  last packet snapshot keeps forwarding.
- Linux with `NET_ADMIN`, `/dev/net/tun`, `net.ipv4.ip_forward=1` in the
  container namespace, and the `ip`, `nft`, and `conntrack` binaries. Missing
  kernel prerequisites stop startup.
- A DNS-over-TCP upstream supplied by the deployment.
- Agent Controller is the control client. Runtime containers send packets over
  UDP. Egress does not call either service.
- An OTLP collector is optional and used only when `OTEL_SDK_DISABLED` is not
  `true` or `1`. It is not part of `/status` readiness.

## Build and test

Run from the repository root:

```bash
cargo fmt --manifest-path services/runtime-egress/Cargo.toml --all --check
cargo clippy --manifest-path services/runtime-egress/Cargo.toml --locked --all-targets -- -D warnings
cargo test --manifest-path services/runtime-egress/Cargo.toml --locked
make test-egress-postgres
docker compose build runtime-egress
```

- `make rust-clippy` runs Clippy with warnings denied for this crate and the
  Runtime crate.
- `make test-rust` runs `cargo test --locked` for this crate and the Runtime
  crate.
- `make test-egress-postgres` provisions an isolated PostgreSQL instance and
  runs the ignored database tests serially (`--lib --test postgres_repository
  -- --ignored --test-threads=1`).
- `docker compose build runtime-egress` builds `antnest/runtime-egress:local`
  from `services/runtime-egress/Dockerfile` with the repository root as the
  build context. The image build stage also runs `cargo fmt`, Clippy, and
  `cargo test` on Linux, which includes the Linux command-process test.

Unit and isolated component tests live in this service under `tests/`. Real
TCP, UDP, PostgreSQL, and Linux command-process integration sources live in
[`tests/integration/runtime-egress`](../../tests/integration/runtime-egress)
and are registered as Cargo test targets, so the commands above compile and run
them. The Linux command-process test does not run on a non-Linux host.

Test-only variables:

- `ANTNEST_EGRESS_TEST_DATABASE_URL` - connection URL for the isolated
  PostgreSQL fixture used by the ignored database tests.

## Documentation

- [Architecture](docs/architecture.md) - domain model, persistence, policy
  barriers, packet algorithms, concurrency, and failure semantics.
- [Operations](docs/operations.md) - privileges, deployment shape, status,
  PostgreSQL, kernel ownership, telemetry, recovery, and release.
- [Control Observability](docs/observability.md) - control HTTP and PostgreSQL
  span model, diagnostic data, and limits.
- [Stage 1 Runtime](../../docs/stage-1-runtime.md) - cross-service Runtime and
  Egress design.
- [Observability contract](../../docs/observability-contract.md) - platform
  telemetry rules.
- [Egress control API](../../contracts/egress/control-api.md) - control RPC
  contract.
