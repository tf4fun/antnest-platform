# Agent Controller Operations

This document covers the Agent Controller process model, configuration,
readiness, lifecycle recovery, tracing, retention and verification procedures.

## Rotating encryption keys

Provider API keys are stored as authenticated envelopes under an active master
key; all other configured master keys are decrypt-only. The legacy single-key
variable maps to `local-v1`, including reading pre-upgrade ciphertext. New writes
always carry a wrapped data key. See the
[shared encryption contract](../../../contracts/platform/encryption-key-rotation.md)
for exact parsing, associated data and deployment ordering.

Back up first and stop old replicas before starting the new binary and additive
migration with the existing key. This initial coordinated binary cutover avoids
mixing readers that cannot accept the migration journal or new envelopes;
rollback requires the matching pre-upgrade recovery set. Add
`kid2` to every Controller replica's `ANTNEST_AGENT_CONTROLLER_ENCRYPTION_KEYS`
ring while retaining `local-v1`, then switch every writer's
`ANTNEST_AGENT_CONTROLLER_ENCRYPTION_ACTIVE_KID` to `kid2`. Unset/empty the
single-key variable when using the ring. Once all writers have switched, run:

```sh
docker compose exec -T agent-controller /usr/local/bin/agent-controller rekey --batch-size 100
```

The command needs only the owned database URL and encryption configuration.
It starts no HTTP listener, Temporal worker, bootstrap or dependency clients.
Progress is JSON with table, active ID, committed batch count and remaining
rows. Require a final successful `remaining: 0` result before removing the old
key and recreating the service. Keep retired keys with historical backups.

Each batch locks and authenticates its rows, then updates only encryption
columns. Concurrent reads continue and concurrent Provider credential changes
serialize on the same row. Rekey never advances Provider versions, execution
revisions, timestamps or receipts. Cancellation leaves committed batches intact;
rerun with the same active key to resume. Unknown IDs, tampered records or storage
failures fail the batch and command; overlapping rotation commands are rejected.
Do not retire a key on a partial/failed result or run against old active writers.

After new envelope writes, a pre-rotation binary cannot read the database;
rollback requires its matching pre-upgrade backup and keys. Rotate/revoke leaked
Provider API keys separately; changing the wrapping key does not revoke them.

## Process Model

All lifecycle operations use [Temporal workflows](lifecycle-workflows.md).
The official SDK Worker runs inside this binary; Temporal Server is a separate
dependency. PostgreSQL does not lease or schedule lifecycle work.

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
dependency fan-out or cancel existing work. Existing admitted workflows resume
when the engine and worker are available. Inspect business progress through the
existing operation endpoint; inspect activity retries through Temporal history.
No Temporal management UI is required. Do not use workflow termination as a
substitute for the product's lifecycle cancellation/deletion policy.

One binary serves internal HTTP RPC, an embedded Temporal Worker, and bounded
Runtime-observation, Identity-offboarding and current execution-publication consumers. The Identity consumer
only records fences and schedules lifecycle operations; it never executes
Runtime mutations directly. See [offboarding](identity-offboarding.md) for
pending-state inspection and recovery.
PostgreSQL is authoritative. Lifecycle mutations commit durable intent and
return `202 Accepted`; only the worker executes their Runtime Controller and
Runtime Egress lifecycle effects. Network policy management is a separate
synchronous read/CAS RPC path, described in [Network policy management](network-policy.md).
It never executes a lifecycle phase or opens an attachment. The service serves
ModelProfile/Template Catalog operations, Agent create, rebuild, disable, enable,
delete, and durable lifecycle-operation inspection. Create
advances through Egress ensure, Runtime initialize, attachment open, and atomic
publication. Rebuild drains, closes the attachment, replaces Runtime, reopens
the attachment, and publishes. Disable drains, closes the attachment, removes
compute while retaining workspace, and publishes the disabled state. Enable
ensures the closed attachment, creates compute from the frozen spec, opens the
attachment, and completes with a configured Runtime. Independent observation
publishes its first healthy Execution revision. Delete requests Agent-level ACP settlement,
closes the attachment, proves Runtime
compute and workspace absent, releases the Tunnel allocation into quarantine,
then atomically publishes `deleted` and deactivates all Agent access bindings.
Management clients can read `GET /internal/execution-synchronization?organization_id=...`
without contacting ACP. A null record means no configuration revision exists;
an older applied revision means a newer configuration has not been confirmed.
An equal applied revision is a past acknowledgement, not ACP health or
proof that credentials remain loaded after a restart. Database read failures
are errors, never a synchronized result. See the
[read contract](../../../contracts/agent-controller/control-api.md#execution-configuration-synchronization).

Configuration commits notify the execution publisher; startup and periodic passes
resend the current organization snapshot. Lifecycle drain confirms a closed
configuration at ACP, then waits for or cancels execution through its Agent-level
settlement RPC. It never reads Run/Tool state or writes execution audit.
Controller exposes no Run resolve, access, acquire, credential or finish RPCs.
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

The service targets one Controller instance. Temporal dispatches lifecycle
Activities; PostgreSQL management locks and phase/Agent-ownership CAS remain the
business serialization guard. Horizontal deployment is not supported.

## Configuration

The complete list of environment variables, defaults and validation rules is
in the [service README](../README.md#configuration). Required:

- `ANTNEST_AGENT_CONTROLLER_DATABASE_URL`;
- `ANTNEST_AGENT_CONTROLLER_ENCRYPTION_KEY`: canonical base64 for a 32-byte AES key;
- `ANTNEST_RUNTIME_CONTROLLER_URL`;
- `ANTNEST_RUNTIME_EGRESS_URL`;
- `ANTNEST_IDENTITY_SERVICE_URL`;
- `ANTNEST_AGENT_ACP_CONTROL_URL` (dedicated execution configuration/settlement control origin).

The Runtime-reachable Egress endpoint is returned by Runtime Egress and is not
duplicated in Agent Controller configuration. `ANTNEST_SKILL_REGISTRY_URL` is
optional and uses an outgoing receiver-specific service credential. Shared exact
service-authentication settings are mandatory; see the
[authentication contract](../../../contracts/agent-controller/service-authentication.md).
Nonempty legacy workspace URL or Registry bearer configuration fails startup.
OpenTelemetry uses the standard OTEL environment variables with OTLP
HTTP/protobuf only.

Activities use a 15-minute attempt timeout, 30-second heartbeat timeout and
5-second heartbeats. Retry delays grow from 1 second to at most 1 minute.
These are SDK execution settings, not a second database scheduling mechanism.

Secrets must come from environment/secret mounts and must never be printed.

Startup applies the service-owned numbered forward migration chain embedded from
`internal/repository/postgres/migrations/`. Stored history must be an exact prefix with matching
names/checksums; drift fails startup. Add a new migration for a schema change
rather than editing an applied migration or bypassing validation. Dropping and
recreating a database is only an explicitly authorized disposable-development
reset, never the normal upgrade procedure. Back up before changing versions.

Migration `0001` separates Provider connections, credential versions and model
parameters. It has no in-place conversion from an earlier schema, so a database
created by an older schema history fails checksum validation. Never bypass that
check.

## Readiness

`GET /status` returns ready when PostgreSQL is reachable and its migrations
were validated at startup. Runtime Controller and Runtime Egress outages are
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
Admission resolves its configured Spec and Runtime; matching last-successful
execution is optional recovery history, not an executable binding. The normal
asynchronous drain/fence/update/open/publish phases install the replacement;
new Runs remain denied until independent healthy observation publishes execution.
Stale admission, revoked identity and quarantined `lifecycle_invariant_failed`
records are rejected. A completed construction that has never become healthy
can still be rebuilt, disabled or deleted. An initial construction failure with
no committed configured target remains a failed operation, not a pending Runtime.

A definite failure before replacement keeps the Agent unavailable and its
source configuration intact. Correct the reported dependency/configuration problem
before submitting a fresh Rebuild request. An uncertain effect keeps the
original operation running; inspect/replay that request instead of creating a
second operation. Neither a source lookup nor an unchanged logical Runtime
head clears an unresolved Run effect: an exact replacement result is still
required. Do not repair availability by editing the database or
reattaching an old endpoint; that bypasses lifecycle admission.

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
  operation. The idempotency request ID is the lifecycle operation
  identity; there is no second alias to lose or reconcile.
- A create transport timeout may occur before or after intent commit. Replay
  the exact request ID and body to obtain the same operation. The replay never
  executes a lifecycle phase; the worker converges the same durable child
  requests.
- A rebuild transport timeout follows the same rule. Before Runtime replacement,
  a conclusive failure reopens the attachment and preserves the old executable
  binding. After replacement, replay the exact command until attachment opening,
  network configuration, and creation publication are conclusive; readiness is
  observed separately.
- A rebuild in `drain` has already published closed execution permission to ACP.
  It advances only after ACP confirms Agent-level settlement under the original
  persisted deadline; no Runtime mutation has happened yet.
- A draining Agent is revisited by the worker after the active Run settles; no
  manual request replay is required.
- An enable creation timeout is retried with the same request ID. Attachment
  opening remains a durable lifecycle phase. The completed operation may still
  have a `created/enabled` Agent with Runtime `unknown` or `waiting`: inspect Runtime health and the independent
  observation consumer, not Temporal retries. Healthy observation alone publishes
  the execution binding. Policy changes made while
  disabled remain durable in Runtime Egress and are applied when the attachment
  opens.
- ACP retains execution-stop protection. Controller only consumes the settlement
  outcome and performs the requested Runtime barrier; it never releases a Run or
  synthesizes a Run audit event. A barrier-required outcome or identity revocation
  must not reopen the old attachment after a management failure.
- A stable deleted inspection for the exact source Runtime revision during
  rebuild/disable is an authoritative source-absence result. Controller stores
  that proof, projects the Agent unavailable and appends one management failure
  event atomically. Replaying the terminal operation changes neither sequence.
  A plain `runtime_not_found` response is ambiguous and leaves the operation
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

Migration `0006` permits unresolved delete sources only before the Runtime
barrier. It does not turn stored `agent_runtime_unassigned` claims into
verified absence or repair deletions that were previously marked complete
without proof. That reason is not accepted as absence authority.

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
Egress ensure, Runtime Controller initialize, and atomic publication. A Run
trace shows:

```text
Gateway authentication and ACP forwarding
  -> ACP protocol authorization using its synchronized Agent configuration
  -> ACP Session / Run persistence
  -> model / Runtime MCP work
  -> ACP local execution audit and terminal result
```

No per-Run Controller or Identity RPC belongs below ACP. Configuration publication
and Agent lifecycle settlement have their own management request chains.
Controller does not own execution tickets, terminal reports or Session overrides.

Lifecycle tracing is provided by official SDK interceptors and common RPC/SQL
boundaries. Gateway -> Console -> admission -> Workflow -> Activities remains
one causal trace. Wait six seconds after terminal state before opening Jaeger.
There are no application-specific recovery spans or traceparent scheduling
columns. See [lifecycle workflows](lifecycle-workflows.md) for deployment
prerequisites.

## Retention And Backup

Back up the Agent Controller database independently. Events, immutable
configuration/execution revisions and terminal management operations are
retained according to organization audit policy. ACP backs up and retains its
own Session/Run records and execution audit; Controller holds no execution copy. Deleting an
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
and deletes the Agent with its external Runtime resources. Lifecycle traces
preserve Gateway ancestry through official Temporal workflow/Activity
instrumentation, Agent Controller, Runtime Egress and Runtime Controller.
Execution traces pass through Gateway, ACP and Runtime MCP; neither Controller
belongs in the Tool data path. `make e2e-stage3` runs the stage 3 Docker
deployment scenario; `make e2e-managed-mcp-v1` and `make e2e-managed-mcp-v2`
exercise managed MCP configuration. Single-node Docker
operation is described in
[Docker single-node operations](../../../docs/docker-single-node-operations.md).

## Creation And Readiness

A completed create/rebuild/enable operation means the configured Runtime exists,
not that MCP is already healthy. Agent `created/enabled`, Runtime `unknown/waiting`, with no active operation
means readiness is pending. Run admission remains closed; management operations
are still available. `agent_created`/`agent_rebuilt`/`agent_enabled` describe
lifecycle completion; `agent_ready` describes later executable availability.

The worker reconciles pending Agents even when no new Runtime event arrives.
Owner revocation, concurrent lifecycle changes, consumed restart observations
and mismatched Runtime revisions fence stale publication. Once an available
execution is invalidated, it is not automatically resurrected.

Lifecycle completion without readiness requires a Runtime Controller contract
that completes initialize/update/enable with `provisioned/unknown`.
