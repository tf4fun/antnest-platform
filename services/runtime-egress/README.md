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

Startup rejects published PostgreSQL passwords using the connection driver parser under the [development secret policy](../../contracts/platform/development-secrets.md). Only exact `ANTNEST_ALLOW_PUBLIC_DEV_SECRETS=true` allows those passwords, with a variable-only WARN; other gates remain independent.

## Responsibilities

- Own a private PostgreSQL schema and migrations.
- Allocate one stable Tunnel IPv4 per Agent and quarantine released addresses.
- Store immutable policy revisions and versioned Agent-policy assignments.
- Expose exact policy revision reads so control clients can display the policy
  document without guessing from its identifier.
- Compile policy into immutable in-memory snapshots.
- Authenticate revision 2 WireGuard datagrams using the embedded BoringTun engine.
- Verify generation keys and replay state before decoding the inner IPv4 source;
  require the selected Agent allocation and Controller-bound outer IPv4 before policy.
- Bind each inner flow to the outer Runtime UDP peer that first created it.
- Route return packets from TUN to the owning UDP peer.
- Produce fast TCP rejection for valid policy-denied traffic.
- Clear userspace flow and kernel conntrack state at policy, Runtime
  replacement, and deletion barriers.
- Export structured local logs, OTLP metrics for control RPCs and periodic
  aggregate data-plane snapshots, and OTLP traces for control HTTP requests and
  Egress-owned PostgreSQL calls.

## Non-responsibilities

- It owns current/candidate transport-key identity, but not compute lifecycle, Runs, prompts,
  Tools, model providers, users, or Agent lifecycle.
- It does not create containers, Pods, volumes, routes inside Runtime, or Agent
  workspaces.
- It does not read another service's database.
- It persists the bound Runtime IPv4 with the attachment; UDP source ports,
  packets, flows, queues, DNS cache and conntrack remain process-local.
- It does not implement an external API or end-user authentication.
- It uses the versioned `ANT2` key-selection prefix and unmodified WireGuard messages;
  the prefix alone grants no authority. There is no raw-packet fallback.
- It does not run as more than one active replica.

## Interfaces

| Direction | Interface                                                                                                                                                                                                                                                                                            | Purpose                                                                                                                      |
| --------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| Inbound   | Control HTTP/JSON on `ANTNEST_EGRESS_CONTROL_LISTEN`: `/internal/agent-networks/{agent_id}`, `/internal/agent-network-attachments/{agent_id}`, `/internal/agent-networks/{agent_id}/release`, `/internal/policies/{policy_id}/revisions/{revision}`, `/internal/agent-policy-assignments/{agent_id}` | Verified Agent Controller workload RPCs for address allocation, attachment gates, release, policy revisions, and assignments |
| Inbound   | `GET/HEAD /status` on the separate loopback `ANTNEST_EGRESS_HEALTH_LISTEN`                                                                                                                                                                                                                           | Local process, data-plane, and control-plane readiness                                                                       |
| Inbound   | UDP on `ANTNEST_EGRESS_UDP_ADVERTISE`                                                                                                                                                                                                                                                                | Authenticated WireGuard messages; decrypted inner IPv4/TCP from Runtime                                                                 |
| Outbound  | UDP to the owning Runtime peer                                                                                                                                                                                                                                                                       | Return packets and local TCP rejections                                                                                      |
| Kernel    | `/dev/net/tun`, Linux routes, nftables/NAT, conntrack                                                                                                                                                                                                                                                | Packet forwarding, masquerade, and per-Agent cleanup                                                                         |
| Outbound  | DNS over TCP to `ANTNEST_EGRESS_DNS_UPSTREAM`                                                                                                                                                                                                                                                        | Virtual resolver proxy for Agent DNS                                                                                         |
| Outbound  | PostgreSQL                                                                                                                                                                                                                                                                                           | Egress-owned schema and role                                                                                                 |
| Outbound  | OTLP HTTP                                                                                                                                                                                                                                                                                            | Control spans and low-cardinality metrics when enabled                                                                       |

The control semantics are defined in
[`../../contracts/egress/control-api.md`](../../contracts/egress/control-api.md).
The Runtime packet bytes are defined by
[`../../contracts/runtime/packet-format.md`](../../contracts/runtime/packet-format.md),
with revision and fixed constants owned by
[`../../contracts/runtime/packet-contract.json`](../../contracts/runtime/packet-contract.json).
These root contracts are an intentional versioned monorepo dependency. Build
and test the service from the repository root so they are present; do not copy
them into the crate.

Eight lifecycle/policy routes require Agent Controller workload authority,
including reads. The private key preparation route requires Runtime Controller
authority. The [revision 5 authentication profile](../../contracts/egress/service-authentication.md)
defines exact token/mTLS admission and startup validation. Source addresses,
user bearer tokens, Cookies, caller context and unsigned identity headers grant
no authority. Anonymous requests fail with 401; another verified workload fails
with 403. Admission precedes path, body, database and packet-gate effects.
Business requests reject queries, unexpected bodies and implicit HEAD reads.
JSON mutations require one UTF-8 JSON object, at most 4 KiB, within five seconds;
duplicate members and unknown fields are rejected.

## Configuration

Configuration is read from the environment at startup and is immutable
afterwards. Durations accept a positive integer with an optional `ms`, `s`, `m`,
or `h` suffix; a bare number means seconds.

| Variable                                        | Required      | Default                            | Description                                                                                                       |
| ----------------------------------------------- | ------------- | ---------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `ANTNEST_EGRESS_DATABASE_URL`                   | yes           | none                               | Egress-owned PostgreSQL connection URL                                                                            |
| `ANTNEST_EGRESS_DATABASE_TLS_MODE`              | no            | `require`                          | `require` validates against native trust roots; `disable` is for isolated local development only                  |
| `ANTNEST_EGRESS_DATABASE_STARTUP_TIMEOUT`       | no            | `30s`                              | Maximum cold-start wait for PostgreSQL reachability                                                               |
| `ANTNEST_EGRESS_DATABASE_RETRY_DELAY`           | no            | `250ms`                            | Delay between cold-start connection attempts                                                                      |
| `ANTNEST_EGRESS_CONTROL_LISTEN`                 | no            | `127.0.0.1:8081`                   | Control listener; explicit unicast IPv4 with a non-zero port, on an IP different from `UDP_ADVERTISE`             |
| `ANTNEST_EGRESS_HEALTH_LISTEN`                  | no            | `127.0.0.1:8082`                   | Separate loopback IPv4 health listener with a non-zero port; cannot equal the control endpoint                    |
| `ANTNEST_SERVICE_AUTH_MODE`                     | yes           | none                               | Exact `token` or `mtls`; no implicit development mode                                                             |
| `ANTNEST_SERVICE_AUTH_CALLERS_FILE`             | in token mode | none                               | Read-only receiver JSON file, at most 8 KiB; known caller names map to one or two distinct `sha256:` token hashes |
| `ANTNEST_SERVICE_AUTH_ALLOW_INSECURE_TRANSPORT` | no            | none                               | Exact `true` permits development token HTTP; absent or exact `false` requires TLS; incompatible with mTLS         |
| `ANTNEST_TLS_CA_FILE`                           | with TLS      | none                               | PEM workload trust roots                                                                                          |
| `ANTNEST_TLS_CERT_FILE`                         | with TLS      | none                               | PEM chain; valid server certificate with exactly one URI SAN `antnest://service/runtime-egress`                   |
| `ANTNEST_TLS_KEY_FILE`                          | with TLS      | none                               | Matching private key; mount read-only outside Agent workspaces                                                    |
| `ANTNEST_TLS_SERVER_NAME`                       | with TLS      | none                               | DNS name validated against the Egress server certificate                                                          |
| `ANTNEST_EGRESS_UDP_ADVERTISE`                  | yes           | none                               | Usable unicast IPv4 `address:port` used both as the UDP bind address and in Runtime network attachments           |
| `ANTNEST_EGRESS_TUNNEL_CIDR`                    | no            | `100.64.0.0/10`                    | Agent Tunnel IPv4 pool                                                                                            |
| `ANTNEST_EGRESS_RESOLVER_IPV4`                  | no            | `100.64.0.1`                       | Virtual resolver/gateway address; must be usable inside the pool                                                  |
| `ANTNEST_EGRESS_QUARANTINE`                     | no            | `5m`                               | Released-address quarantine duration                                                                              |
| `ANTNEST_EGRESS_MAX_FLOWS`                      | no            | `65536`                            | Global flow bound; must be non-zero                                                                               |
| `ANTNEST_EGRESS_MAX_AGENT_FLOWS`                | no            | `1024`                             | Per-Agent flow bound; must be non-zero and not exceed the global bound                                            |
| `ANTNEST_EGRESS_FLOW_IDLE`                      | no            | `5m`                               | Inactive flow expiry                                                                                              |
| `ANTNEST_EGRESS_DNS_UPSTREAM`                   | yes           | none                               | DNS-over-TCP recursive upstream; production should use one with no view of internal names. Compose retains `127.0.0.11:53`; protected answers are filtered. |
| `ANTNEST_EGRESS_TUN_NAME`                       | no            | `antnest-egress0`                  | Linux TUN name; 1-15 ASCII letters, digits, `-`, or `_`                                                           |
| `ANTNEST_EGRESS_COMMAND_TIMEOUT`                | no            | `5s`                               | Bound for each `ip`, `nft`, and `conntrack` command                                                               |
| `RUST_LOG`                                      | no            | `info,hyper=warn,reqwest=warn`     | Log filter; only `antnest_runtime_egress` targets reach stderr                                                    |
| `OTEL_SDK_DISABLED`                             | no            | `true`                             | `true` or `1` disables OTLP export while keeping local trace correlation                                          |
| `ANTNEST_TELEMETRY_CAPTURE_RPC_CONTENT`         | no            | `false`                            | `true` records complete control RPC JSON, which can include secrets                                               |
| `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT`            | no            | `http://127.0.0.1:4318/v1/traces`  | OTLP HTTP traces endpoint                                                                                         |
| `OTEL_EXPORTER_OTLP_METRICS_ENDPOINT`           | no            | `http://127.0.0.1:4318/v1/metrics` | OTLP HTTP metrics endpoint                                                                                        |
| `OTEL_EXPORTER_OTLP_ENDPOINT`                   | no            | `http://127.0.0.1:4318`            | Fallback OTLP HTTP base URL; `/v1/traces` and `/v1/metrics` are appended                                          |

Packet revision and inner MTU come only from the packet contract and have no
environment variables. Deployment guidance for these settings is in
[Operations](docs/operations.md#2-configuration).

Selecting any TLS field requires all four fields, even when development HTTP is
allowed; invalid TLS cannot fall back to plaintext. TLS handshakes have a
five-second deadline and at most 16 pending handshakes. mTLS uses only a verified
client certificate's exact workload URI; a token or forwarded header cannot
override it. Authentication files and TLS configuration are validated before
database, kernel or listener startup. Receiver hashes and trust material are
loaded once; rotate them with the documented overlap and service restart.

`runtime-egress --healthcheck` reads only the configured loopback health
endpoint, without workload credentials or database configuration. Ready and
degraded status both preserve HTTP 200 and the existing four-field document;
the probe exits zero only when the JSON `status` is `ready`.
On the control listener, anonymous `/status` returns 401 and an authenticated
Controller receives 404.

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
- Agent Controller is the lifecycle/policy client; RC privately prepares generation keys. Runtime containers send packets over
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
node tests/e2e/service-authentication/egress/run.mjs
```

- `make rust-clippy` runs Clippy with warnings denied for this crate and the
  Runtime crate.
- `make test-rust` runs `cargo test --locked` for this crate and the Runtime
  crate.
- `make test-egress-postgres` provisions an isolated PostgreSQL instance and
  runs the ignored database tests serially (`--lib --test postgres_repository
-- --ignored --test-threads=1`).
- The isolated authentication Docker harness builds the production
  `services/runtime-egress/Dockerfile`, creates temporary credentials and its
  own database/networks, and removes its resources. The image build stage runs
  `cargo fmt`, Clippy and `cargo test` on Linux, including the Linux
  command-process test. The gate covers all control routes, real CAS/replay,
  receiver rotation, local health, database loss and normal shutdown/restart.
  Actual Controller-to-Egress compatibility remains the final integration batch.

Scoped tracing tests call the service-owned, test-only
`src/test_tracing.rs` stabilizer before creating a dispatcher. It keeps an
uninstalled dispatcher alive and warms the OpenTelemetry provider-drop callsite
so parallel tests cannot disable each other's captures or deadlock during
provider cleanup. `tests/tracing_registry.rs` runs in its own test binary and
fixes the first-registration order with a joined thread, checking both events
and spans and preserving subscriber filters. The default `cargo test` runner
remains parallel; privilege tests still require exact UID, GID and capabilities.

Unit and isolated component tests live in this service under `tests/`. Real
TCP, UDP, PostgreSQL, and Linux command-process integration sources live in
[`tests/integration/runtime-egress`](../../tests/integration/runtime-egress)
and are registered as Cargo test targets, so the commands above compile and run
them. The Linux command-process test does not run on a non-Linux host.

Storage-encryption test masters are generated with OS-backed cryptographic
entropy. Shared fixtures retain one master only for the current test process
so recovery can reuse it; wrong-key checks use an independently generated
master. These keys are never persisted or installed into Docker services.

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
- [Control authentication](../../contracts/egress/service-authentication.md) -
  exact receiver/transport profile and delivery boundaries. UDP inner-source
  binding (#34) and resolver/private-answer restrictions (#36) are independent
  work; authenticated HTTP does not fix those packet/DNS limitations.

## Authenticated tunnel deployment

Revision 2 embeds BoringTun 0.7.1 in this process. No WireGuard daemon, kernel
WireGuard module or additional production container is required. TUN and the
independent nft destination backstop retain their existing roles.

`ANTNEST_EGRESS_TUNNEL_KEY_FILE` defaults to
`/run/antnest-egress-auth/tunnel-master`. It must be a regular, nonsymlink,
root-owned `0600` file containing exactly 32 random nonzero bytes, mounted
read-only. Load occurs before database/kernel/listener effects. Back it up with
the encrypted Egress database; losing or changing it makes startup fail closed.

RC may register only the recipient-limited private generation tuple. Egress
seals it with ChaCha20-Poly1305 and Agent/key ID/Runtime revision/inner-IP AAD.
The key route is always excluded from RPC content capture. Open CAS needs both
RC-reported outer IPv4 and an already prepared key ID. At most current plus one
candidate exists per Agent; cutover retires the source context, and release
removes all keys. Restart restores static keys from Egress-owned storage and
creates fresh ephemeral protocol sessions. Packet forwarding never reads SQL.

The Egress owning batch covers unit/contract/socket/PostgreSQL/Docker evidence.
Controller consumption and deployment wiring remain pending in the separate
[#111 integration batch](../../docs/authenticated-runtime-tunnel.md#delivery-batches-and-evidence).
