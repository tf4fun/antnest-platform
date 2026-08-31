# Agent Controller Operations

## Process Model

One binary serves internal HTTP RPC and runs a durable lifecycle-operation
worker. PostgreSQL is authoritative. A process restart resumes non-terminal
operations from their persisted phase and reuses the same child request IDs.

Multiple replicas may serve reads and Run admission. Lifecycle workers claim
operations with PostgreSQL row locking; Agent-row constraints remain the final
serialization guard.

## Configuration

Required:

- `ANTNEST_AGENT_CONTROLLER_DATABASE_URL`;
- `ANTNEST_AGENT_CONTROLLER_ENCRYPTION_KEY`: base64-encoded 32-byte AES key;
- `ANTNEST_RUNTIME_CONTROLLER_URL`;
- `ANTNEST_EGRESS_CONTROL_URL`;
- `ANTNEST_RUNTIME_EGRESS_ADVERTISE_IPV4`: Runtime-reachable Egress address is
  normally returned by Egress and is not duplicated here.

Optional:

- `ANTNEST_AGENT_CONTROLLER_LISTEN` (default `:8080`);
- `ANTNEST_AGENT_CONTROLLER_OPERATION_POLL_INTERVAL` (default `500ms`);
- `ANTNEST_AGENT_CONTROLLER_DEPENDENCY_TIMEOUT` (default `10s`);
- `ANTNEST_AGENT_CONTROLLER_RUN_DEADLINE` (default `30m`);
- `ANTNEST_AGENT_CONTROLLER_DRAIN_TIMEOUT` (default `5m`);
- `ANTNEST_AGENT_CONTROLLER_SHUTDOWN_TIMEOUT` (default `15s`);
- standard OTEL environment variables using OTLP HTTP/protobuf.

Secrets must come from environment/secret mounts and must never be printed.

## Readiness

`GET /status` returns ready only when:

1. PostgreSQL is reachable and migrations are current;
2. Runtime Controller reports ready;
3. Runtime Egress control plane reports ready;
4. the lifecycle worker has completed its initial recovery scan.

Dependency failures after startup are reported per business request and in
metrics; liveness remains process-level so the deployment platform does not
turn a downstream outage into a restart loop.

## Failure Recovery

- Retry an uncertain lifecycle command with the original request ID.
- Inspect `/internal/agent-operations/{request_id}` before creating a new
  operation. Stage 2 uses the idempotency request ID as the lifecycle operation
  identity; there is no second alias to lose or reconcile.
- An `unavailable` Agent requires explicit rebuild retry or deletion.
- A draining Agent with a settled Run is resumed by the worker.
- An unresolved Run remains fail-closed until rebuild/delete proves its Runtime
  absent.
- Never edit operation phases or Agent projection rows by hand. Repair the
  dependency and replay the durable operation.

## OpenTelemetry And Jaeger

Set:

```text
OTEL_SDK_DISABLED=false
OTEL_EXPORTER_OTLP_ENDPOINT=http://jaeger:4318
OTEL_EXPORTER_OTLP_PROTOCOL=http/protobuf
OTEL_SERVICE_NAME=agent-controller
```

The Compose `observability` profile starts Jaeger and exposes its UI on the
configured loopback port. A Stage 2 trace must show:

```text
ACP session/prompt
  -> Agent Controller acquire_run
  -> model / Runtime MCP work
  -> Agent Controller finish_run
```

Lifecycle traces must show each Saga phase and both downstream control calls.
Each worker attempt starts a new span linked to the persisted initial request
trace and previous attempt; a process restart never fabricates one continuous
parent/child timeline. Trace identities are correlation data, not metric
labels. No packet-level or secret-bearing spans are emitted.

## Retention And Backup

Back up the Agent Controller database independently. Events, immutable
configuration/execution revisions, terminal operations, and terminal
admissions are retained according to organization audit policy. Deleting an
Agent does not immediately erase those facts. A future retention job may purge
the closed aggregate after the configured policy window.

## Verification

Run heavy checks serially:

```sh
go test ./services/agent-controller/...
make test-agent-controller-postgres
docker compose --profile stage2 --profile observability up -d --wait
make e2e-stage2
```

The E2E profile starts from empty service databases, creates a ModelProfile and
Template, creates an Agent, proves Runtime readiness and one ACP Tool Run,
rebuilds it, and verifies a single trace crosses ACP, Agent Controller,
Runtime Controller, and Runtime MCP.
