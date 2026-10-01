# Agent Controller Observability

This document describes how Agent Controller implements the platform
[observability contract](../../../docs/observability-contract.md): tracing at
HTTP, PostgreSQL and Temporal boundaries, optional RPC content capture, span
naming, and known limits.

For retained development with Jaeger as the OTLP destination, use the opt-in
[Controller Compose overlay](../../../compose.controller-development.yaml).
It disables this service's metrics exporter because that collector accepts
traces only. Trace export remains enabled. Production metrics destinations
retain their own configuration.

All five lifecycle kinds use the official
`go.temporal.io/sdk/contrib/opentelemetry` interceptor.
SDK headers carry parent context across durable Workflow/Activity execution.
There is no PostgreSQL recovery worker or custom phase instrumentation.
See [lifecycle workflows](lifecycle-workflows.md) and the
[Workflow span lifetime contract](workflow-span-lifecycle.md).

Temporal's span names identify SDK operations and registered workflow/activity
names. Names are registration identifiers, not separately maintained business
instrumentation labels. SQL and outgoing HTTP/RPC automatically inherit the
activity context. Engine payloads/stream contents are not added to spans; the
RPC capture setting applies unchanged. A trace crossing an HTTP 202 remains
one business trace; validate only after completion plus six seconds for export.

This service implements the platform observability contract at HTTP adapters,
the PostgreSQL driver boundary, and official Workflow/Activity boundaries.

## Transaction Envelopes

`postgresql transaction` is an INTERNAL span beneath the owning request or
background attempt. BEGIN, transaction SQL and COMMIT/ROLLBACK are CLIENT
children; non-transaction SQL keeps its original parent. Batch envelopes remain;
prepare and pool acquisition do not create spans. `antnest.transaction.outcome`
distinguishes completion.

The private database pool returns a transaction handle that owns the envelope context. Query/Exec/QueryRow inherit it automatically while preserving the caller's deadlines and cancellation. Commit/Rollback finish it once; a deferred second Rollback cannot change the first outcome. No business method creates or names a span.

## Boundaries

- One inbound HTTP middleware extracts W3C trace context before SERVER creation.
  Successful readiness with an upstream parent retains that SERVER. Readiness
  checks initialization and the controller's own PostgreSQL, not other services.
- One outbound transport creates CLIENT before injection for runtime, egress,
  and identity HTTP clients. Protocol adapters supply operation names and their
  typed outcomes to the same exchange, including invalid responses in HTTP 200.
  ACP execution snapshot publication and settlement use the same transport
  through their protocol adapter.
- Synchronous RPC dispatchers record complete decoded parameters and
  results only when `ANTNEST_TELEMETRY_CAPTURE_RPC_CONTENT=true` (default false).
  The switch gates serialization. There is no whitelist, DTO reflection tree,
  size budget or omission event. Credentials inside RPC DTOs are
  included when enabled: restrict collector access and retention.
- Ordinary HTTP, Header values and watch streams never carry content in traces.
  Route registration distinguishes RPC operations from local status/streams;
  the HTTP transport does not infer protocol semantics from a URL.
- HTTP bodies remain demand-driven and closeable. SSE is not accumulated or
  recorded per chunk. An admitted HTTP response ends normally; Temporal keeps
  its operation IDs and bounded attempt spans within the originating trace.
- PostgreSQL pools created by `postgres.Open` and the dedicated LISTEN
  connection created by `postgres.OpenEventNotifier` install
  `github.com/exaring/otelpgx v0.12.0` with `otelpgx.NewTracer()` defaults.
  Reconnects retain the tracer through the saved connection configuration.
  Query/Exec/QueryRow, transaction statements and batch execution are observed
  at pgx, including new repository methods without per-method wrappers.
- Driver spans use operation names such as `SELECT`, `INSERT`, `BEGIN` and
  `COMMIT`, not repository method names. `db.query.text` retains SQL with bind
  placeholders; bind parameters and result bodies are not captured. Default
  driver metadata includes row counts, database/user/server details, but no
  full connection string. The constructor exposes only execution, batch, copy
  and connection hooks; prepare and pool acquisition do not create spans.
  This does not change pgx's actual preparation or pooling. No SQL parser,
  table-name inference or custom naming callback is installed.
- The default tracer requires a recording parent. Background SQL probes do not
  create query roots. Workflow Activity queries inherit the SDK Activity span,
  optionally through a transaction envelope.

## Explicit Limits

The service adds no telemetry database/schema, tracing business port, retry or
shadow lifecycle model. Pure in-memory branch internals without a real adapter
boundary are not traced. Conversation/tool content and streaming content
previews are not registered. Outbound diagnostic bodies are omitted at the
transport; the receiving service owns optional RPC content capture. The
runtime-observation and identity-offboarding application runners still import
OpenTelemetry directly instead of receiving it from runner composition.
Export/drop pressure metrics, queue saturation tests and tail sampling are not
implemented.

SQL text is not parsed, filtered or redacted by this integration. SQL literals
remain visible, and the default library records driver error messages and
SQLSTATE, which can contain database-provided values. Omitting bind attributes
is not a guarantee that server diagnostics are secret-free. Keep sensitive
values parameterized and restrict collector access/retention.

## Span And Metric Names

Outbound HTTP CLIENT spans are named `HTTP <method> runtime-controller`,
`HTTP <method> runtime-egress` and `HTTP <method> identity-service`. Select the
operation using `rpc.method`; each HTTP request produces exactly one CLIENT.
Runtime journal reads are separate HTTP requests, not children of a synthetic
protocol CLIENT. Observation listing also has a CLIENT.

There are no `agent_controller.repository.*` spans, no
`antnest.repository.operation` dimension and no repository store decorators.
Composition passes the repository directly to application services. Queries
select the `github.com/exaring/otelpgx` scope and `db.operation.name` /
`db.query.text`; they must not treat SQL spans as business outcome spans.

There are no repository decorator metrics, lifecycle recovery counters or
custom attempt spans. The driver supplies SQL metrics; the official Temporal
SDK supplies workflow and activity telemetry.

## Asynchronous Lifecycle Causality

The SDK Update-with-Start boundary records durable intent before application
admission. HTTP returns 202 after admission; resource Activities continue in the
same trace without holding the request open. Worker replacement restores context
from SDK history rather than business database fields.

A Jaeger trace check covers Gateway -> Console -> Controller -> official Workflow
and Activity spans, including actual RPC/transaction/SQL descendants. Wait six
seconds for export after completion. After normal worker Stop and client Close, the Controller finishes any remaining
actual SDK Workflow spans with `antnest.temporal.workflow.span_end=worker_shutdown`
before provider shutdown. A replacement worker may create another span for the
same logical Workflow/Run; both original contexts remain. `workflow_return`
identifies normal SDK span End, which can still carry a workflow error. A process
killed before shutdown/export may lose an unfinished span; that remains a
gap in the trace, never a fabricated successful span.

Outbound spans use `rpc.system.name=antnest.http-json`. Lifecycle spans carry
`antnest.operation.id`, `.phase` and `.attempt` alongside the lifecycle
attributes. SERVER route names are `HTTP <method> <normalized route>`.
Successful `/status` and `/rpc/agent-controller/status` requests with an
upstream parent produce SERVER spans; unparented successful probes are
suppressed. Readiness makes no downstream calls.

## Test Coverage

Unit coverage includes complete nested RPC fields beyond 16 KiB, disabled capture without serialization, actual parent IDs, protocol failures and long SSE flushes without payload events.

`tests/integration/go/agent-controller/internal/repository/postgres/observation_integration_test.go` adds real
PostgreSQL coverage through the production constructors and the
`ANTNEST_AGENT_CONTROLLER_TEST_DATABASE_URL` fixture: query parenting, commit
and replay rollback, SQLSTATE/error status, parameter/result omission, batch
children, query/empty poll suppression without a recording parent, a new unwrapped method,
LISTEN startup/saved reconnect configuration, and SQL below SDK Activity and transaction parents. Use an isolated test database; the fixture resets this service's
schema. E2E workflow assertions require driver SQL spans and reject repository
wrapper spans.

Cancellation/upgrade edge cases, process-wide concurrency pressure and
shutdown/export failure have only synthetic test coverage. The transport does
not retain outbound content; controller SSE previews are omitted. Some
application errors still replace lower-level causes; HTTP adapters preserve
send/read/close causes, but not every lifecycle branch is cause-preserving.
RPC capture includes model pricing and provider endpoint values when enabled.
