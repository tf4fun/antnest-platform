# Agent Controller Operations

## Process Model

All lifecycle operations use [Temporal workflows](lifecycle-workflows.md).
The official SDK Worker runs inside this binary; Temporal Server is a separate
dependency. The old PostgreSQL-leased executor has been removed.

`ANTNEST_TEMPORAL_ADDRESS` defaults to `127.0.0.1:7233`; Compose sets
`temporal:7233`. The namespace is `antnest`, task queue `agent-lifecycle`.
The Compose setup jobs provision an isolated role and two Temporal-owned
databases on the development PostgreSQL instance, apply official schemas and
create the namespace. They are idempotent and exit after setup. Runtime request
paths never read Temporal tables or access another service's tables.

Temporal stores workflow history for seven days after completion. Retained
Controller idempotency records still reject duplicate lifecycle execution after that
history expires. Back up both business and workflow databases. Do not delete
workflow storage while admitted operations remain open. Before upgrading an existing deployment, finish every running lifecycle
operation using the old binary; no live migration of those operations is provided.

Temporal failure blocks new lifecycle admission; it does not affect `/status`
dependency fan-out or cancel existing work. Existing accepted workflows resume
when the engine and worker are available. Inspect business progress through the
existing operation endpoint; inspect activity retries through Temporal history.
No Temporal management UI is required. Do not use workflow termination as a
substitute for the product's lifecycle cancellation/deletion policy.

One binary serves internal HTTP RPC, an embedded Temporal Worker, and bounded
Runtime-observation and Identity-offboarding consumers. The Identity consumer
only records fences and schedules lifecycle operations; it never executes
Runtime mutations directly. See [offboarding](identity-offboarding.md) for
pending-state inspection and recovery.
PostgreSQL is authoritative. Lifecycle mutations commit durable intent and
return `202 Accepted`; only the worker executes their Runtime Controller and
Runtime Egress lifecycle effects. Network policy management is a separate
synchronous read/CAS RPC path, described in [Network policy management](network-policy.md).
It never executes a lifecycle phase or opens an attachment. The current runnable slices serve ModelProfile/Template Catalog
operations, Agent create,
rebuild, disable, enable, delete, and durable lifecycle-operation inspection. Create
advances through Egress ensure, Runtime initialize, attachment open, and atomic
publication. Rebuild drains, closes the attachment, replaces Runtime, reopens
the attachment, and publishes. Disable drains, closes the attachment, removes
compute while retaining workspace, and publishes the disabled state. Enable
ensures the closed attachment, creates compute from the frozen spec, opens the
attachment, and publishes a new Execution revision. Delete drains Run occupancy,
closes the attachment, proves Runtime
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

Multiple replicas may serve reads and Run admission. Temporal dispatches lifecycle
Activities; PostgreSQL Agent-row constraints and phase CAS remain the final
business serialization guard.

## Configuration

Required:

- `ANTNEST_AGENT_CONTROLLER_DATABASE_URL`;
- `ANTNEST_AGENT_CONTROLLER_ENCRYPTION_KEY`: base64-encoded 32-byte AES key;
- `ANTNEST_RUNTIME_CONTROLLER_URL`;
- `ANTNEST_RUNTIME_EGRESS_URL`.
- `ANTNEST_IDENTITY_SERVICE_URL`.

The Runtime-reachable Egress endpoint is returned by Runtime Egress and is not
duplicated in Agent Controller configuration.

Optional:

- `ANTNEST_AGENT_CONTROLLER_LISTEN` (default `:8080`);
- `ANTNEST_AGENT_CONTROLLER_DEPENDENCY_TIMEOUT` (default `150s`);
- `ANTNEST_AGENT_CONTROLLER_DRAIN_TIMEOUT` (default `5m`);
- `ANTNEST_AGENT_CONTROLLER_RUN_ADMISSION_TTL` (default `30m`);
- `ANTNEST_AGENT_CONTROLLER_RUNTIME_OBSERVATION_POLL_INTERVAL` (default `2s`);
- `ANTNEST_AGENT_CONTROLLER_IDENTITY_REVOCATION_POLL_INTERVAL` (default `2s`);
- `ANTNEST_AGENT_CONTROLLER_SHUTDOWN_TIMEOUT` (default `15s`);
- standard OTEL environment variables using OTLP HTTP/protobuf.

Activities use a 15-minute attempt timeout, 30-second heartbeat timeout and
5-second heartbeats. Retry delays grow from 1 second to at most 1 minute.
These are SDK execution settings, not a second database scheduling mechanism.

Secrets must come from environment/secret mounts and must never be printed.

Startup applies the service-owned numbered forward migration chain, currently
`0001` through `0009`. Stored history must be an exact prefix with matching
names/checksums; drift fails startup. Add a new migration for a schema change
rather than editing an applied migration or bypassing validation. Dropping and
recreating a database is only an explicitly authorized disposable-development
reset, never the normal upgrade procedure. Back up before changing versions.

Provider P1 is an explicit fresh-MVP-schema baseline (2026-09-11): `0001`
now separates connections, credential versions and model parameters. It has no
in-place conversion of pre-P1 data. An old schema history intentionally fails
checksum validation; never bypass that check. Recreate only an explicitly approved
disposable instance when the matching Console consumer is ready. The running
8090 acceptance instance has not been upgraded or reset by this batch.

## Readiness

`GET /status` returns ready when PostgreSQL is reachable and its migrations
were accepted at startup. Runtime Controller and Runtime Egress outages are
recorded on the affected lifecycle operation and do not make the process unready;
otherwise a downstream outage would cause an unrelated restart loop.

Dependency failures after startup are reported per business request and in
metrics; liveness remains process-level so the deployment platform does not
turn a downstream outage into a restart loop.

Runtime observation synchronization failure is retryable background
degradation and does not stop HTTP or lifecycle execution. The consumer keeps
its last committed cursor, retries from that sequence, and reconciles
`GET /internal/runtimes` before resetting an expired cursor. An
`agent_runtime_restarted` or `agent_runtime_missing` event means the prior
execution binding is no longer runnable. Missing-compute failures identify
`runtime_missing` (inventory reconciliation) or `runtime_deleted` (platform
event); they are not mislabeled as process restarts. The workspace is not deleted
by this consumer. Recovery requires an explicit lifecycle operation, not retries
of the old Run. Observation does not resolve an already admitted uncertain Tool
effect. Synchronization is eventual; there is no platform probe on every Run.

An enabled Agent invalidated by observation can use the existing Rebuild RPC.
Admission resolves its immutable last-successful execution and matching spec
as recovery lineage, not as an executable binding. The normal asynchronous
drain/fence/update/open/publish phases install the replacement; new Runs remain
denied until publication. Stale admission, revoked identity and quarantined
`lifecycle_invariant_failed` records are rejected. Initial construction failures
without successful execution history are not eligible for this recovery path.

A definite failure before replacement keeps the Agent unavailable and its
historical source intact. Correct the reported dependency/configuration problem
before submitting a fresh Rebuild request. An uncertain effect keeps the
original operation running; inspect/replay that request instead of creating a
second operation. Neither historical source lookup nor an unchanged logical
Runtime head clears an unresolved Run effect: exact replacement evidence is
still required. Do not repair availability by editing the database or
reattaching an old endpoint; that bypasses lifecycle admission.

Current closeout limitation: the unavailable-Agent Console recovery action and
real Docker live/cold-loss integration are not yet accepted. Disable still
requires an available source; it is not an alternative unavailable-Agent
recovery command.

Identity Service is checked before initial Agent creation and before Agent
access resolution. Missing or inactive organization membership fails closed;
an Identity transport failure is retryable and does not create or admit work.

## Lifecycle Execution And Recovery

- Retry an uncertain lifecycle command with the original request ID and exact
  body. Browser clients retain one organization-scoped idempotency key until a
  conclusive HTTP response is observed.
- Temporal owns scheduling, retry and Worker recovery for every lifecycle kind.
  HTTP and identity-triggered commands use the same orchestration facade.
- Each Activity reloads immutable business snapshots, calls one phase handler,
  and retains stable downstream child request IDs. Phase CAS and Agent/source
  guards remain mandatory; SDK retries do not imply exactly-once execution.
- Graceful shutdown drains HTTP and stops the SDK Worker. Heartbeats and
  cancellation live at the SDK adapter; pending work resumes on another Worker.
- Confirmed invariant failures atomically mark the operation failed, make the
  Agent unavailable and append an audit event. Unknown external effects stay
  pending and retry rather than being incorrectly compensated.
- Inspect `/internal/agent-operations/{request_id}` before creating a new
  operation. Stage 2 uses the idempotency request ID as the lifecycle operation
  identity; there is no second alias to lose or reconcile.
- A create transport timeout may occur before or after intent commit. Replay
  the exact request ID and body to obtain the same operation. The replay never
  executes a lifecycle phase; the worker converges the same durable child
  requests.
- A rebuild transport timeout follows the same rule. Before Runtime replacement,
  a conclusive failure reopens the attachment and preserves the old executable
  binding. After replacement, replay the exact command until attachment opening,
  network readiness, and publication are conclusive.
- A rebuild in `drain` has made no external mutation. It advances only after no
  active Run executor occupies the Agent.
- A draining Agent is revisited by the worker after the active Run settles; no
  manual request replay is required.
- An enable timeout before Runtime readiness is retried with the same request
  ID. After Runtime readiness, attachment opening remains a durable phase and
  must complete before the Agent becomes available. Policy changes made while
  disabled remain durable in Runtime Egress and are applied when the attachment
  opens.
- An unresolved Run remains fail-closed until rebuild/delete proves its Runtime
  absent. Disable provides the same proof when Runtime Controller confirms the
  source Runtime is disabled with no running compute. The event-journal append
  counter records the resulting `run_admission_released` fact. The durable
  lifecycle operation and journal identify the barrier; driver SQL spans show
  its database work under the request or SDK Activity.
- A stable deleted inspection for the exact source Runtime revision during
  rebuild/disable is an authoritative source-absence result. Agent Controller
  atomically stores that proof, releases any matching unresolved admission,
  projects the Agent unavailable, and appends the release fact before the
  lifecycle-failure fact. If no blocked admission exists, no release event is
  synthesized. Replaying the terminal operation changes neither sequence. A
  plain `runtime_not_found` response is ambiguous and leaves the operation
  running with its attachment closed for inspection or replay.
- Delete intent is irreversible. A timeout or ambiguous Runtime/Egress effect
  leaves the same delete operation running; replay the original request ID.
  A failed build with no published Runtime revision is not an absence proof.
  The worker closes the network, resolves the Runtime Controller Environment,
  then atomically freezes its cleanup revision/proof before deleting resources.
  A transitional Environment keeps deletion pending; no newer revision is
  adopted after the cleanup target was frozen. Readiness failure from Initialize
  is terminal and visible with its recorded diagnostic, rather than retried
  indefinitely as a generic HTTP 503.
  `deleted` is never published before Runtime absence and Egress quarantine are
  proven. `runtime_not_found` and `agent_network_not_found` are authoritative
  absence proofs, not failures that recreate resources.
- Never edit operation phases or Agent projection rows by hand. Repair the
  dependency and replay the durable operation.

Migration 6 preserves existing checksums and permits unresolved delete sources
only before the Runtime barrier. It does not turn historical
`agent_runtime_unassigned` claims into verified absence or repair historical
false-completed deletions. That reason is no longer accepted as authority.
This batch validates fresh instances; older affected development data requires
separate reconciliation or an explicitly authorized blank-instance reset.

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
configured loopback port. The create admission trace shows the bounded HTTP
route, Identity owner resolution, and atomic lifecycle-intent commit. The
durable lifecycle attempts correlated by request ID collectively show Runtime
Egress ensure, Runtime Controller initialize, and atomic publication. Once
Stage 2 is complete, a Run trace must show:

```text
ACP session/prompt
  -> Agent Controller resolve_agent_access -> Identity resolve_principal
  -> Agent Controller acquire_run -> Identity resolve_principal
  -> model / Runtime MCP work
  -> Agent Controller finish_run
```

Lifecycle tracing is provided by official SDK interceptors and common RPC/SQL
boundaries. Gateway -> Console -> admission -> Workflow -> Activities remains
one causal trace. Wait six seconds after terminal state before opening Jaeger.
No application-specific recovery spans or traceparent scheduling columns remain.
See [lifecycle workflows](lifecycle-workflows.md) for rollout prerequisites.

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
  postgres agent-controller jaeger
```

`make e2e-stage2` builds an isolated blank deployment, creates an Agent, proves
Runtime readiness and one ACP Runtime Tool Run, verifies workspace effects,
and deletes the Agent with its external Runtime resources. Lifecycle evidence
is a request-ID-correlated set of independently rooted attempt traces through
Agent Controller, Runtime Egress, and Runtime Controller. Execution remains one
business trace through Agent ACP Service, Agent Controller Run admission, and
Runtime MCP. Runtime Controller is intentionally absent from the Tool data
path.
