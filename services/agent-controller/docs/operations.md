# Agent Controller Operations

## Process Model

One binary serves internal HTTP RPC. PostgreSQL is authoritative. The current
runnable slices serve ModelProfile/Template Catalog operations and the Agent
create Saga. The request thread advances create through Egress ensure, Runtime
initialize, and atomic publication. The background lifecycle recovery worker
described below is not yet started by the process.

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
- `ANTNEST_AGENT_CONTROLLER_RUN_DEADLINE` (default `30m`);
- `ANTNEST_AGENT_CONTROLLER_DRAIN_TIMEOUT` (default `5m`);
- `ANTNEST_AGENT_CONTROLLER_SHUTDOWN_TIMEOUT` (default `15s`);
- standard OTEL environment variables using OTLP HTTP/protobuf.

Secrets must come from environment/secret mounts and must never be printed.

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
- Inspect `/internal/agent-operations/{request_id}` before creating a new
  operation. Stage 2 uses the idempotency request ID as the lifecycle operation
  identity; there is no second alias to lose or reconcile.
- A create transport timeout leaves the operation at the last committed phase;
  replay the exact request ID and body to continue with the same child request.
- An `unavailable` Agent requires explicit rebuild retry or deletion once those
  lifecycle commands are implemented.
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
configured loopback port. A create trace shows the bounded HTTP route,
repository phases, Runtime Egress ensure call, Runtime Controller initialize
call, and atomic publication. Once Stage 2 is complete, a Run trace must show:

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
GOCACHE=.cache/go-build GOMODCACHE=.cache/go-mod go test ./services/agent-controller/...
make test-agent-controller-postgres
OTEL_SDK_DISABLED=false OTEL_EXPORTER_OTLP_ENDPOINT=http://jaeger:4318 \
  docker compose --profile stage2 --profile observability up -d --wait \
  agent-controller-postgres agent-controller jaeger
```

Full Stage 2 E2E will additionally create an Agent, prove Runtime readiness and
one ACP Tool Run, rebuild it, and verify one trace crosses ACP, Agent
Controller, Runtime Controller, and Runtime MCP.
