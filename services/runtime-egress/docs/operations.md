# Runtime Egress Operations

## 1. Process And Privileges

Runtime Egress is one Rust process. The container requires `NET_ADMIN` and
`/dev/net/tun`. The initial Linux adapter also requires the `ip`, `nft`, and
`conntrack` binaries. It must not receive the Docker socket or Kubernetes
credentials. The deployment declaration must set
`net.ipv4.ip_forward=1` in the Egress network namespace; startup verifies this
value and fails closed instead of attempting to mutate a platform-owned
sysctl.

PostgreSQL and the control listener are reachable only on the control network.
Runtime containers reach only the UDP listener through the Runtime management
network. The Egress container also has an ordinary external network path for
NAT and DNS upstream traffic.

## 2. Configuration

| Variable | Required | Default | Meaning |
| --- | --- | --- | --- |
| `ANTNEST_EGRESS_DATABASE_URL` | yes | none | Egress-owned PostgreSQL connection URL |
| `ANTNEST_EGRESS_DATABASE_TLS_MODE` | no | `require` | `require` uses native trust roots; `disable` is restricted to isolated local development |
| `ANTNEST_EGRESS_DATABASE_STARTUP_TIMEOUT` | no | `30s` | Maximum cold-start wait for PostgreSQL reachability |
| `ANTNEST_EGRESS_DATABASE_RETRY_DELAY` | no | `250ms` | Delay between cold-start connection attempts |
| `ANTNEST_EGRESS_CONTROL_LISTEN` | no | `0.0.0.0:8081` | Trusted internal control HTTP listener |
| `ANTNEST_EGRESS_UDP_LISTEN` | no | `0.0.0.0:8092` | Runtime packet UDP listener |
| `ANTNEST_EGRESS_UDP_ADVERTISE` | yes | none | Literal reachable UDP address returned to Runtime Controller |
| `ANTNEST_EGRESS_TUNNEL_CIDR` | no | `100.64.0.0/10` | Agent Tunnel IPv4 pool |
| `ANTNEST_EGRESS_RESOLVER_IPV4` | no | `100.64.0.1` | Reserved virtual resolver/gateway address |
| `ANTNEST_EGRESS_QUARANTINE` | no | `5m` | Released-address quarantine duration |
| `ANTNEST_EGRESS_MAX_FLOWS` | no | `65536` | Global flow bound |
| `ANTNEST_EGRESS_MAX_AGENT_FLOWS` | no | `1024` | Per-Agent flow bound |
| `ANTNEST_EGRESS_FLOW_IDLE` | no | `5m` | Inactive flow expiry |
| `ANTNEST_EGRESS_DNS_UPSTREAM` | yes | none | Deployment-provided DNS-over-TCP upstream used by the virtual resolver |
| `ANTNEST_EGRESS_TUN_NAME` | no | `antnest-egress0` | Runtime Egress-owned Linux TUN name |
| `ANTNEST_EGRESS_COMMAND_TIMEOUT` | no | `5s` | Bound for Linux reconciliation and cleanup commands |
| `RUST_LOG` | no | service default | Structured log filter for Runtime Egress targets only |
| `OTEL_SDK_DISABLED` | no | `true` | Disable OTLP export while retaining local correlation |
| `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT` | no | `http://127.0.0.1:4318/v1/traces` | Preferred OTLP HTTP traces endpoint |
| `OTEL_EXPORTER_OTLP_METRICS_ENDPOINT` | no | `http://127.0.0.1:4318/v1/metrics` | Preferred OTLP HTTP metrics endpoint |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | no | none | Fallback OTLP HTTP endpoint |

Configuration is immutable after startup. Agent policy changes use the control
API and PostgreSQL rather than environment variables.

Packet revision and inner MTU come only from
`contracts/runtime/packet-contract.json`. The current revision is returned in
network attachments; MTU has no deployment variable or negotiation field.
`ANTNEST_EGRESS_UDP_ADVERTISE` must be a stable, usable unicast IPv4 address with
a non-zero port and must remain reachable across an Egress process restart.

Egress never selects a public resolver implicitly. Docker Compose points this
setting at Docker's embedded resolver (`127.0.0.11:53`); a Kubernetes or
production deployment supplies its cluster or enterprise resolver. That
resolver must accept DNS over TCP because Runtime executors use `options
use-vc`, keeping DNS on the governed TCP-only packet path.

`ANTNEST_EGRESS_DATABASE_TLS_MODE=require` is the production default and
validates PostgreSQL against the container's native certificate roots. The
`disable` mode is explicit so a copied development connection string cannot
silently disable transport security in production.

## 3. Deployment Shape

Egress runs independently from Runtime and Agent Controller. It needs a private
control network for PostgreSQL and control RPCs, a Runtime-facing UDP network,
and an external route for NAT and the configured DNS upstream. Only the control
and UDP listeners are exposed to those private networks; neither is a public
host API.

Stage 1 runs exactly one active Egress replica. Do not place multiple replicas
behind a generic TCP/UDP load balancer: packet flows, UDP return peers, TUN,
conntrack, and kernel policy are process-local. Process or container restart is
supported; active-active ownership and failover are not yet part of the
contract.

A minimal Docker deployment must provide the equivalent of:

```bash
docker run --rm \
  --name antnest-runtime-egress \
  --cap-drop ALL \
  --cap-add NET_ADMIN \
  --device /dev/net/tun \
  --sysctl net.ipv4.ip_forward=1 \
  --pids-limit 256 \
  --memory 512m \
  --cpus 1 \
  --stop-timeout 10 \
  --env-file runtime-egress.env \
  antnest/runtime-egress:<immutable-tag>
```

The image supplies `ip`, `nft`, and `conntrack`. Production deployment must
attach explicit private and external networks, a restart policy, and a
termination grace period of at least ten seconds for the five-second task drain
and five-second telemetry flush. Kubernetes uses the same
capability/device/sysctl boundary;
NetworkPolicy must permit only PostgreSQL, Agent Controller control RPCs,
Runtime UDP, the DNS upstream, OTLP when enabled, and intended external egress.

## 4. Status

`GET /status` returns one document with:

- process status;
- data-plane readiness;
- control mutation availability;
- applied snapshot revision.

The listener opens only after PostgreSQL snapshot loading, UDP bind, TUN, DNS,
and kernel reconciliation succeed, so `data_plane_ready=true` summarizes those
cold-start prerequisites rather than exposing a second set of component
states. During a warm database outage, a failed control mutation or
reconciliation marks `control_plane_ready=false` while the last published data
plane remains ready. A later successful control operation restores it.
`snapshot_revision` is a process-local monotonic publication counter, not a
durable policy version.

## 5. PostgreSQL

Runtime Egress owns its schema, migration history, role, and credentials. A
development deployment may share a physical PostgreSQL server, but no other
service may query or mutate Egress tables.

Provision a dedicated database and role before startup, for example:

```sql
CREATE ROLE runtime_egress LOGIN PASSWORD '<managed-secret>';
CREATE DATABASE runtime_egress OWNER runtime_egress;
```

The service creates and owns only the `runtime_egress` schema in that database
and rejects a schema owned by a different role. Backups, PITR, and credential
rotation are deployment responsibilities; restore acceptance requires a clean
startup migration/ownership check before control traffic is admitted.

Migrations run before listeners open. Bootstrap and all later applied versions,
names, and SHA-256 checksums must match the embedded ordered catalog exactly.
Egress retries only initial PostgreSQL
connection failures, within the configured startup timeout. A migration,
persisted-pool mismatch, or initial snapshot failure terminates immediately;
these are not hidden behind retries. Packet tasks never hold a PostgreSQL
transaction.

## 6. Kernel Ownership

Antnest-owned TUN, nftables table/chains, routes, and conntrack cleanup are
named deterministically. Startup reconciles them idempotently. The process does
not attempt fragile best-effort kernel teardown during shutdown; container
network-namespace destruction is the cleanup boundary.

`ResetAgentFlows`, policy assignment, fence, and release report success only
after userspace writers have drained and the matching conntrack cleanup command
has succeeded.

## 7. Telemetry

Control RPC requests produce OpenTelemetry spans and low-cardinality request
metrics, and carry their database and kernel work as part of that request span.
The OTLP trace layer accepts only the
control HTTP module and only `/internal/` business routes. `/status`, packet
transport, DNS forwarding, packet rejection, flow maintenance, and packet
events never enter OTLP traces.

Callers propagate W3C `traceparent` and optional `tracestate`; invalid context is
ignored and `baggage` is not consumed. Each control span and completion log
records `service.name`, normalized route,
method, status, duration, W3C-derived `trace_id`/`span_id`, and the stable
`error.type` returned by the control contract. Successful calls leave
`error.type` empty.

Structured logs include stable operation, policy, and failure codes. Packet
payloads, raw prompts, credentials, and complete destination URLs are never
logged.

Every 30 seconds one content-free structured local log and one OTLP metric
snapshot record:

- active flows, collisions, expirations, and reverse misses;
- policy allows and rejections;
- malformed and unsupported packets;
- UDP/TUN packet and byte counts;
- DNS proxy accepted, rejected, completed, failed, and byte counts.

Individual packet drops never emit logs, even when debug logging is enabled.
The stderr layer accepts only `antnest_runtime_egress` crate targets, so
`RUST_LOG` cannot enable PostgreSQL, HTTP, or other dependency payload logs.
Control RPC failures remain control-plane spans and structured logs. Background
cleanup, database availability, and task failures remain structured local logs.
Packet payloads never enter either signal.

Agent IDs, Runtime peer addresses, and destination addresses are not metric
labels.

## 8. Recovery

- Container restart is the recovery mechanism for fatal TUN, UDP, or kernel
  failures.
- Cold restart installs a deny barrier, clears stale Antnest conntrack, loads
  one consistent database snapshot, publishes it, and only then becomes ready.
- Existing transport connections are not preserved across restart.
- Runtime does not need rebuilding after Egress restart; its next outbound
  connection establishes new ephemeral flow state.
- Address quarantine and policy assignment survive restart.
- A warm PostgreSQL disconnect immediately marks control readiness degraded.
  The next control operation reconnects,
  revalidates migrations and seed data, and restores control readiness on
  success; packet forwarding never waits for that recovery.

## 9. Development Admission

The Rust rewrite is admitted only when all of the following pass serially:

```bash
cargo fmt --all --check
cargo clippy --locked --all-targets -- -D warnings
cargo test --locked
docker build -f services/runtime-egress/Dockerfile -t antnest/runtime-egress:local .
```

Linux container acceptance additionally requires real TUN creation, real
PostgreSQL migrations, policy allow/deny traffic, flow reset, restart recovery,
and address quarantine/reuse.

## 10. Release And Rollback

Promote one immutable Egress image together with the exact control, policy, and
packet contract revisions it passed. Roll out only one active replica. Before
promotion, restore a production-like backup into an isolated database and run
startup migration, ownership, snapshot-recovery, and Stage 1 allow/deny
acceptance.

Rollback means stopping the failed image and starting the previous immutable
image against a database schema that the previous image recognizes. Applied
migrations are forward-only: a release that changes persistent schema must
document and verify backward-readable rollout before promotion. If that cannot
be guaranteed, restore the pre-release database backup rather than editing
migration history. After rollback, require `/status` readiness and repeat the
allow/deny path before routing Runtime traffic.
