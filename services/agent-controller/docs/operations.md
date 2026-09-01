# Agent Controller Operations

## Process Model

One binary serves internal HTTP RPC. PostgreSQL is authoritative. The current
runnable slices serve ModelProfile/Template Catalog operations, Agent create,
rebuild, disable, enable, delete, and durable lifecycle-operation inspection. Create
advances through Egress ensure, Runtime initialize, an exact Egress attachment
recheck, and atomic publication. Rebuild drains, fences, resets flows, replaces
Runtime, restores the captured policy, and publishes. Disable drains, fences,
removes compute while retaining workspace, and publishes the disabled state.
Enable ensures the existing attachment, creates compute from the frozen spec,
restores only the Disable-captured policy, and publishes a new Execution
revision. Delete drains Run occupancy, fences and resets Egress, proves Runtime
compute and workspace absent, releases the Tunnel allocation into quarantine,
then atomically publishes `deleted` and deactivates all Agent access bindings.
Run admission is served at `/rpc/agent-controller`: access resolution binds an
ACP connection to one Agent, acquire serializes on the Agent row and persists a
complete immutable execution snapshot, credential resolution is restricted to
an active admission, and finish seals one immutable terminal report. Admission
deadline expiry is not an automatic release condition. Rebuild, disable, and
delete release `blocked_unknown_effect` only after a Runtime-absence barrier;
the phase transition, admission release, Agent aggregate sequence, and
`run_admission_released` event share one PostgreSQL transaction.
Current projection reads are served from `GET /internal/agents` and
`GET /internal/agents/{agent_id}`. Lists use `(created_at, agent_id)` keyset
pagination, hide desired state `deleted` by default, and may filter by opaque
organization/owner identities and lifecycle state. Exact lookup and
`include_deleted=true` remain available for administrator and audit workflows.
These are current-state reads; ordered change replay belongs to the Agent event
journal and must not be inferred from list cursors. Callers preserve the same
filters while following a cursor; malformed, duplicate, unknown, and explicitly
empty query values fail closed.
Event consumers use `/internal/agent-events` or the per-Agent event route for
authoritative replay. The cursor is the exclusive `after_sequence`; the
consumer stores its last fully applied value in its own database. `/watch`
serves SSE backlog followed by PostgreSQL commit notifications and supports
`Last-Event-ID`, which takes precedence over the original query cursor on an
automatic EventSource reconnect, but carries no delivery acknowledgement. One
dedicated listener connection fans hints out to every local watcher; watchers
do not consume the lifecycle/query connection pool. A disconnect is
recovered by List from the consumer-owned cursor, never by assuming the last
socket write was applied.

Multiple replicas may serve reads and Run admission. Lifecycle workers claim
operations with PostgreSQL row locking; Agent-row constraints remain the final
serialization guard.

## Configuration

Required:

- `ANTNEST_AGENT_CONTROLLER_DATABASE_URL`;
- `ANTNEST_AGENT_CONTROLLER_ENCRYPTION_KEY`: base64-encoded 32-byte AES key;
- `ANTNEST_RUNTIME_CONTROLLER_URL`;
- `ANTNEST_RUNTIME_EGRESS_URL`.

The Runtime-reachable Egress endpoint is returned by Runtime Egress and is not
duplicated in Agent Controller configuration.

Optional:

- `ANTNEST_AGENT_CONTROLLER_LISTEN` (default `:8080`);
- `ANTNEST_AGENT_CONTROLLER_DEPENDENCY_TIMEOUT` (default `150s`);
- `ANTNEST_AGENT_CONTROLLER_DRAIN_TIMEOUT` (default `5m`);
- `ANTNEST_AGENT_CONTROLLER_RUN_ADMISSION_TTL` (default `30m`);
- `ANTNEST_AGENT_CONTROLLER_RECOVERY_POLL_INTERVAL` (default `2s`);
- `ANTNEST_AGENT_CONTROLLER_RECOVERY_STALE_AFTER` (default four dependency
  timeouts plus `35s`; it must not be shorter than the derived recovery lease);
- `ANTNEST_AGENT_CONTROLLER_SHUTDOWN_TIMEOUT` (default `15s`);
- standard OTEL environment variables using OTLP HTTP/protobuf.

The online lifecycle command timeout is ten dependency timeouts plus `30s`.
The recovery attempt timeout is four dependency timeouts plus `5s`; its lease
adds a `30s` finalization grace. The larger online budget covers the longest
complete Saga, while the recovery budget covers the largest single durable
phase and may make progress across multiple claims. These values are derived
from the dependency timeout so operators cannot configure a lease shorter than
the code path it fences.

Secrets must come from environment/secret mounts and must never be printed.

Stage 2 is a pre-release, empty-database build. `0001_initial.sql` is the
authoritative baseline rather than a compatibility migration chain. When its
checksum changes, drop and recreate the development or acceptance database;
do not bypass the checksum guard. Numbered forward migrations begin once a
released database must be preserved.

## Readiness

`GET /status` returns ready when PostgreSQL is reachable and its migrations
were accepted at startup. Runtime Controller and Runtime Egress outages are
reported by the affected create request and do not make the process unready;
otherwise a downstream outage would cause an unrelated restart loop.

Dependency failures after startup are reported per business request and in
metrics; liveness remains process-level so the deployment platform does not
turn a downstream outage into a restart loop.

## Lifecycle Failure Recovery

- Retry an uncertain lifecycle command with the original request ID.
- A supervised recovery worker resumes stale `running` operations. It claims
  one operation at a time with `FOR UPDATE SKIP LOCKED`, a bounded lease, and a
  monotonically increasing fencing attempt. Multiple replicas may run the same
  worker safely.
- The stale threshold prevents the worker from racing a normally active request
  before its dependency timeout. A claimed attempt has a shorter execution
  timeout than its lease. Failure releases the claim with bounded exponential
  backoff; successful progress resets the backoff.
- Recovery reloads the persisted operation and invokes the same create,
  rebuild, disable, enable, or delete phase handler. One claim invokes exactly
  one phase handler and then releases or atomically clears its lease; a handler
  may persist prerequisite evidence before the final phase CAS, so this does
  not mean one SQL statement. Runtime mutations reuse their stored child
  request IDs. Egress ensure/fence/reset/release operations are convergent, and
  policy replacement remains protected by resource-version CAS. If a lease
  expires and execution overlaps, those dependency guarantees plus repository
  phase CAS decide the winner; the expired attempt cannot mutate, release, or
  reschedule a newer claim.
- Parent-context cancellation and fatal recovery invariants stop the worker
  immediately instead of issuing another release write. In those two cases the
  bounded lease expires naturally and makes the operation claimable again; a
  terminal operation is protected by a database constraint from retaining a
  recovery owner or lease.
- A fatal recovery-store or state-machine invariant error stops the service;
  retryable dependency failures remain inside the worker and use bounded
  backoff. Shutdown stops new claims, starts HTTP draining immediately, and
  waits for both the active recovery attempt and HTTP server within the same
  bounded deadline.
- Inspect `/internal/agent-operations/{request_id}` before creating a new
  operation. Stage 2 uses the idempotency request ID as the lifecycle operation
  identity; there is no second alias to lose or reconcile.
- A create transport timeout leaves the operation at the last committed phase;
  replay the exact request ID and body to continue with the same child request.
- A rebuild transport timeout follows the same rule. Before Runtime replacement,
  a conclusive failure restores the captured policy and old executable binding.
  After replacement, replay the exact command until policy restoration, network
  readiness, and publication are conclusive.
- A rebuild in `drain` has made no external mutation. It advances only after no
  active Run executor occupies the Agent.
- A draining Agent is revisited by the worker after the active Run settles; no
  manual request replay is required.
- An enable timeout before Runtime readiness is retried with the same request
  ID. After Runtime readiness, policy restoration remains a durable phase and
  must complete before the Agent becomes available.
- A policy changed independently after Disable is not overwritten by Enable;
  resolve the policy conflict and replay the original enable request.
- An unresolved Run remains fail-closed until rebuild/delete proves its Runtime
  absent. Disable provides the same proof when Runtime Controller confirms the
  source Runtime is disabled with no running compute. The event-journal append
  counter records the resulting `run_admission_released` fact, and lifecycle
  repository spans identify the barrier by bounded expected/next phase
  attributes.
- A stable deleted inspection for the exact source Runtime revision during
  rebuild/disable is an authoritative source-absence result. Agent Controller
  atomically stores that proof, releases any matching unresolved admission,
  projects the Agent unavailable, and appends the release fact before the
  lifecycle-failure fact. If no blocked admission exists, no release event is
  synthesized. Replaying the terminal operation changes neither sequence. A
  plain `runtime_not_found` response is ambiguous and leaves the operation
  running and fenced for inspection or replay.
- Delete intent is irreversible. A timeout or ambiguous Runtime/Egress effect
  leaves the same delete operation running; replay the original request ID.
  `deleted` is never published before Runtime absence and Egress quarantine are
  proven. `runtime_not_found` and `agent_network_not_found` are authoritative
  absence proofs, not failures that recreate resources.
- Never edit operation phases or Agent projection rows by hand. Repair the
  dependency and replay the durable operation.

## OpenTelemetry And Jaeger

Set:

```text
OTEL_SDK_DISABLED=false
OTEL_EXPORTER_OTLP_ENDPOINT=http://jaeger:4318
OTEL_EXPORTER_OTLP_PROTOCOL=http/protobuf
OTEL_TRACES_EXPORTER=otlp
OTEL_METRICS_EXPORTER=none
OTEL_LOGS_EXPORTER=none
OTEL_SERVICE_NAME=agent-controller
```

The Compose `observability` profile starts Jaeger and exposes its UI on the
configured loopback port. A create trace shows the bounded HTTP route,
repository phases, Runtime Egress ensure call, Runtime Controller initialize
call, and atomic publication. Once Stage 2 is complete, a Run trace must show:

```text
ACP session/prompt
  -> Agent Controller acquire_run
  -> model / Runtime MCP work
  -> Agent Controller finish_run
```

Lifecycle traces must show each Saga phase and all downstream control calls.
Create has two Egress calls by design: initial allocation and the exact active
attachment barrier immediately before publication.
Request-driven work propagates W3C context through both dependency clients and
correlates retries by durable request ID. Each background recovery attempt
creates a new trace with Span Links to the initial request and previous recovery
attempt; it never fabricates one continuous parent/child timeline across
process restarts. The initial link is the Agent Controller server span, not a
raw unvalidated inbound header. Recovery metrics use only operation kind,
phase, and bounded outcome labels; request, Agent, worker, and trace identities
remain span/log correlation data. No packet-level or secret-bearing spans are
emitted.

## Retention And Backup

Back up the Agent Controller database independently. Events, immutable
configuration/execution revisions, terminal operations, and terminal
admissions are retained according to organization audit policy. Deleting an
Agent does not immediately erase those facts. A future retention job may purge
the closed aggregate after the configured policy window.

## Verification

Run heavy checks serially:

```sh
GOCACHE=.cache/go-build GOMODCACHE=.cache/go-mod go test ./services/agent-controller/...
make test-agent-controller-postgres
OTEL_SDK_DISABLED=false OTEL_EXPORTER_OTLP_ENDPOINT=http://jaeger:4318 \
  OTEL_TRACES_EXPORTER=otlp OTEL_METRICS_EXPORTER=none OTEL_LOGS_EXPORTER=none \
  docker compose --profile stage2 --profile observability up -d --wait \
  agent-controller-postgres agent-controller jaeger
```

Full Stage 2 E2E will additionally create an Agent, prove Runtime readiness and
one ACP Tool Run, rebuild it, and verify one trace crosses ACP, Agent
Controller, Runtime Controller, and Runtime MCP.
