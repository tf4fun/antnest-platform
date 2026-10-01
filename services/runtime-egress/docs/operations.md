# Runtime Egress Operations

This document covers how to deploy and run Runtime Egress: privileges,
configuration guidance, deployment shape, status, PostgreSQL, kernel ownership,
telemetry, recovery, verification, and release.

## 1. Process And Privileges

Runtime Egress is one Rust process. The container requires `NET_ADMIN` and
`/dev/net/tun`. The Linux adapter also requires the `ip`, `nft`, and
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

The full list of environment variables, defaults, and validation rules is in
the [service README](../README.md#configuration). Configuration is immutable
after startup. Agent policy changes use the control API and PostgreSQL rather
than environment variables.

The OTLP collector must be reachable from the Runtime Egress service network.
The development Compose topology attaches Runtime Egress and Jaeger to a
dedicated internal `observability` network for this purpose. That network is
not an Agent packet egress route; packet forwarding keeps the dedicated
`egress` network as its default gateway.

Packet revision and inner MTU come only from
`contracts/runtime/packet-contract.json`. The current revision is returned in
network attachments; MTU has no deployment variable or negotiation field.
`ANTNEST_EGRESS_UDP_ADVERTISE` must be a stable, usable unicast IPv4 address with
a non-zero port and must remain reachable across an Egress process restart. It
is also the bind address; there is deliberately no separate wildcard-listen
setting or NAT-style advertised endpoint.

Egress never selects a public resolver implicitly. Docker Compose points
`ANTNEST_EGRESS_DNS_UPSTREAM` at Docker's embedded resolver (`127.0.0.11:53`); a
Kubernetes or production deployment supplies its cluster or enterprise
resolver. That resolver must accept DNS over TCP because Runtime executors use
`options use-vc`, keeping DNS on the governed TCP-only packet path.

Policy schema version 1 `allow_all` is external-only: special-use and private
IPv4 destinations remain denied, except TCP port 53 on the virtual resolver. An
enterprise service on an internal address requires a later explicit policy
schema; operators must not work around this boundary by attaching Runtime
containers to control networks.

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

The control listener must bind the Egress address on the control network, never
`0.0.0.0` or `[::]`. A multi-homed container does not gain port isolation merely
by joining separate Docker networks: a wildcard listener would also accept
connections arriving from the Runtime-facing interface. Compose therefore
assigns the control interface a stable private address and binds only that
address. Kubernetes must provide the equivalent fixed Pod address or bind and
filter the control port with NetworkPolicy before the service becomes ready.

Egress runs exactly one active replica. Do not place multiple replicas behind a
generic TCP/UDP load balancer: packet flows, UDP return peers, TUN, conntrack,
and kernel policy are process-local. Process or container restart is
supported; active-active ownership and failover are not part of the contract.

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
states. `control_plane_ready` describes shared control infrastructure, not the
health of every Agent. Repository connection health is its runtime authority:
loss of all validated live database connections marks it false while the last
published data plane remains ready. Losing one pooled connection, a pool wait
timeout, or an individual RPC error is not automatically a global outage.
Ordinary Agent reads are not proof of a packet-gate repair. A cleanup
failure fences only the affected Agent and leaves global readiness unchanged;
its request error, health event, and aggregate fenced-Agent metric expose the
local degradation. A newly validated live database connection restores global
control readiness; successful RPC results alone do not change that state.
`snapshot_revision` is a process-local monotonic publication counter, not a
durable policy version.

For policy inspection, read the Agent assignment and then
`GET /internal/policies/{encoded_policy_id}/revisions/{revision}`. The returned
`spec` and `digest` describe that exact immutable revision; neither the policy
name nor the latest revision is a substitute. Built-in IDs contain `/` and must
be encoded as a single segment, for example `builtin%2Fallow-all`.

After a failed mutation, a successful assignment GET is not proof that traffic
has resumed. Retry the original versioned mutation to settle its barrier; a
version conflict requires a fresh read and an explicit decision. Ensure may
restore an already-open attachment, and attachment open may restore a hard
fence, but both must finish flow/conntrack cleanup first. Healthy Ensure does
not reset connections. Do not use global `/status` to infer per-Agent application.

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
rotation are deployment responsibilities; a restored database must pass the
startup migration and ownership checks before control traffic is admitted.

Migrations run before listeners open. Bootstrap and all later applied versions,
names, and SHA-256 checksums must match the embedded ordered catalog exactly.
Egress retries only initial PostgreSQL connection failures, within the
configured startup timeout. A migration, persisted-pool mismatch, or initial
snapshot failure terminates immediately; these are not hidden behind retries.
Packet tasks never hold a PostgreSQL transaction.

Control operations use a bounded pool of validated PostgreSQL connections. No
repository-wide lock is held while SQL is running, so one Agent's row-lock wait
does not block unrelated Agent reads or mutations. Pool acquisition, connection
establishment, SQL statements, and PostgreSQL lock waits are bounded; expiry is
reported as a scoped, retryable failure through the owning control request, and
the timed-out connection is retired. Global control readiness becomes false
only when no validated pooled connection remains live; one Agent's statement,
lock, or persisted-row failure does not alter it. The pool is fixed at eight
connections, and pool acquisition, connection establishment, and complete
repository operations each have a five-second client-side deadline, with
shorter PostgreSQL statement and lock deadlines. These are implementation
limits, not deployment configuration knobs.

## 6. Kernel Ownership

Antnest-owned TUN, nftables table/chains, routes, and conntrack cleanup are
named deterministically. Startup reconciles them idempotently. The process does
not attempt fragile best-effort kernel teardown during shutdown; container
network-namespace destruction is the cleanup boundary.

Attachment close reports success only after userspace writers drain, the
matching conntrack cleanup succeeds, durable `closed` is committed, and the
probe-only route is published. Release first validates and quarantines the
current network version, then removes the route and reconciles bounded cleanup;
an already-quarantined retry repeats cleanup safely. Flow reset is an internal
part of these Egress operations, not a public lifecycle RPC.

## 7. Telemetry

Control HTTP requests produce SERVER spans and low-cardinality request metrics.
The common middleware includes `/status` and keeps the incoming W3C parent even
for successful probes. PostgreSQL query/execute and transaction API boundaries
produce CLIENT children with SQL text, never bind arguments or rows; SQL capture
is independent of the RPC content switch. Unconfirmed drop rollback is not success;
kernel cleanup remains within the control request. The OTLP target allowlist
accepts only control HTTP and the own-database observation module. Packet
transport, DNS forwarding, packet rejection, and flow maintenance never create
spans. See [Control Observability](observability.md) for projections and limits.

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
- malformed and unsupported packets as separate counters;
- UDP/TUN packet and byte counts;
- Agent-attributed Runtime-peer UDP output failures;
- unattributed destination-level UDP receive errors from asynchronous ICMP;
- DNS proxy accepted, rejected, completed, failed, and byte counts;
- service, data-plane, and control-plane readiness;
- the number of currently fenced Agents and health transitions;
- quarantine allocations removed and Agent-local cleanup failures.

Readiness changes emit one low-frequency `health_transition` event containing
only component, previous state, next state, reason, transition number, and
snapshot revision. Agent-local cleanup failures may carry the opaque Agent ID in
logs and control spans, but Agent IDs are never metric labels.

An attributed Runtime-peer output failure emits at most one
`runtime_peer_output_unavailable` diagnostic event per Agent in each 30-second
window. The bounded recent-Agent cache is sampling state, not an availability
authority, so no recovery event is inferred from packet traffic. Events contain
only the opaque Agent ID and stable error classification; aggregate metrics
remain free of Agent labels and packet traffic never creates spans.

Individual packet drops never emit logs, even when debug logging is enabled.

DNS-over-TCP admission is bounded twice: 128 connections for the whole process
and 8 for each source tunnel address. The per-source guard prevents one Runtime
from starving every other Agent. These limits are implementation-owned safety
constants; neither source addresses nor Agent IDs appear as metric labels.

The stderr layer accepts only `antnest_runtime_egress` crate targets, so
`RUST_LOG` cannot enable PostgreSQL, HTTP, or other dependency payload logs.
Control RPC failures remain control-plane spans and structured logs. Background
cleanup and task failures retain their structured local logs; own-database
operations, including recovery/sweeps, use the same database boundary.
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
- Losing all validated live PostgreSQL connections marks control readiness
  degraded; an individual connection/Agent SQL failure does not necessarily
  change shared readiness. A subsequent control operation reconnects and
  revalidates migrations and seed data. The resulting validated connection
  restores repository health; packet forwarding never waits for that recovery.

## 9. Verification

Run these checks serially from the repository root:

```bash
cargo fmt --manifest-path services/runtime-egress/Cargo.toml --all --check
cargo clippy --manifest-path services/runtime-egress/Cargo.toml --locked --all-targets -- -D warnings
cargo test --manifest-path services/runtime-egress/Cargo.toml --locked
make test-egress-postgres
docker build -f services/runtime-egress/Dockerfile -t antnest/runtime-egress:local .
```

The policy-read HTTP tests cover exact revisions, built-in opaque IDs, stable
errors, side-effect-free inspection, and incoming W3C parent/error attributes.
The control-service tests inject cleanup failures and verify recovery with
actual data-plane packet decisions, including a failed allow request that must
not override the persisted deny policy. `make test-egress-postgres`
additionally checks persisted revisions through the HTTP router after database
reconnection. It provisions an isolated test database; use a test-owned
Compose project and port for this destructive profile, then remove its
resources.

Linux container tests must cover real TUN creation, real PostgreSQL
migrations, policy allow/deny traffic, flow reset, restart recovery, and
address quarantine/reuse.

## 10. Release And Rollback

Promote one immutable Egress image together with the exact control, policy, and
packet contract revisions it was tested against. Roll out only one active
replica. Before promotion, restore a production-like backup into an isolated
database and run startup migration, ownership, snapshot recovery, and policy
allow/deny checks.

Rollback means stopping the failed image and starting the previous immutable
image against a database schema that the previous image recognizes. Applied
migrations are forward-only: a release that changes persistent schema must
document and verify backward-readable rollout before promotion. If that cannot
be guaranteed, restore the pre-release database backup rather than editing
migration history. After rollback, require `/status` readiness and repeat the
allow/deny path before routing Runtime traffic.
