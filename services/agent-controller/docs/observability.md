# Agent Controller Observability

For retained development with Jaeger as the OTLP destination, use the opt-in
[Controller Compose overlay](../../../compose.controller-development.yaml)
and [deployment instructions](../../../docs/controller-development-sync-20260921.md).
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
existing RPC capture setting is unchanged. A trace crossing an HTTP 202 remains
one business trace; validate only after completion plus six seconds for export.

This service implements the platform observability contract at HTTP adapters,
the PostgreSQL driver boundary, and official Workflow/Activity boundaries.
Acceptance is coordinator-owned; changes in this document are implementation
guarantees to verify, not a claim of a passing deployment or Jaeger profile.

## Transaction Envelopes

`postgresql transaction` is an INTERNAL span beneath the owning request or
background attempt. BEGIN, transaction SQL and COMMIT/ROLLBACK are CLIENT
children; non-transaction SQL keeps its original parent. Batch envelopes remain;
prepare and pool acquisition do not create spans. `antnest.transaction.outcome`
distinguishes completion.

The private database pool returns a transaction handle that owns the envelope context. Query/Exec/QueryRow inherit it automatically while preserving the caller's deadlines and cancellation. Commit/Rollback finish it once; a deferred second Rollback cannot change the first outcome. No business method creates or names a span.

## Boundary Plan

- One inbound HTTP middleware extracts W3C trace context before SERVER creation.
  Successful readiness with an upstream parent retains that SERVER. Readiness
  checks initialization and the controller's own PostgreSQL, not other services.
- One outbound transport creates CLIENT before injection for runtime, egress,
  and identity HTTP clients. Protocol adapters supply operation names and their
  typed outcomes to the same exchange, including invalid responses in HTTP 200.
  ACP execution snapshot publication and settlement use the same transport
  through their protocol adapter.
- Existing synchronous RPC dispatchers record complete decoded parameters and
  results only when `ANTNEST_TELEMETRY_CAPTURE_RPC_CONTENT=true` (default false).
  The switch gates serialization. There is no whitelist, DTO reflection tree,
  custom 16 KiB budget or omission event. Credentials inside RPC DTOs are
  included when enabled: restrict collector access and retention.
- Ordinary HTTP, Header values and watch streams never carry content in traces.
  Route registration distinguishes RPC operations from local status/streams;
  the HTTP transport does not infer protocol semantics from a URL.
- HTTP bodies remain demand-driven and closeable. SSE is not accumulated or
  recorded per chunk. An accepted HTTP response ends normally; Temporal keeps
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

No new database/schema, tracing business port, retry or shadow lifecycle model
is introduced. Pure in-memory branch internals without a real adapter boundary
are not reconstructed. Conversation/tool content and streaming content previews
are not registered. Outbound diagnostic bodies are omitted at the transport;
the receiving service owns optional RPC content capture. Existing runtime-observation and
identity-offboarding application runners still contain OTel coupling and need
a separately reviewed relocation to runner composition. Export/drop pressure
metrics, queue saturation tests, tail sampling and live
Jaeger/root integration profiles remain coordinator work.

SQL text is not parsed, filtered or redacted by this integration. SQL literals
remain visible, and the default library records driver error messages and
SQLSTATE, which can contain database-provided values. Omitting bind attributes
is not a guarantee that server diagnostics are secret-free. Keep sensitive
values parameterized and restrict collector access/retention. The existing
HTTP/RPC error helpers and optional RPC content switch are unchanged.

Formatting, lint, service tests and PostgreSQL integration checks must run
serially under the coordinator. This driver migration has not been executed or
deployed by the delegated worker; admission results belong in the rollout below.

## Integration Changes

The old HTTP CLIENT names `agent_controller.runtime.<operation>`,
`agent_controller.egress.<operation>` and
`agent_controller.identity.<operation>` are replaced by
`HTTP <method> runtime-controller`, `HTTP <method> runtime-egress` and
`HTTP <method> identity-service`. Select the old operation suffix using
`rpc.method`; HTTP requests still produce exactly one CLIENT. Runtime journal
reads are actual separate HTTP requests, not children of a synthetic protocol
CLIENT. Observation listing now also has a CLIENT.

`agent_controller.repository.*` spans and their
`antnest.repository.operation` dimensions are removed, along with the
Catalog, Lifecycle, Run, Recovery, AgentQuery, AgentEvent and IdentityRevocation
store decorators. Composition passes the repository directly to application
services. Queries must select the `github.com/exaring/otelpgx` scope and
`db.operation.name` / `db.query.text`; they must not treat SQL spans as business
outcome spans. Business errors and idempotent replay behavior are unchanged.

The decorator metrics `antnest.agent_controller.repository.operations`,
`antnest.agent_controller.repository.operation.duration`,
All former lifecycle recovery counters and custom attempt spans are removed.
The driver supplies SQL metrics; the official Temporal SDK supplies workflow
and activity telemetry.

## Asynchronous Lifecycle Causality

The SDK Update-with-Start boundary records durable intent before application
admission. HTTP returns 202 after admission; resource Activities continue in the
same trace without holding the request open. Worker replacement restores context
from SDK history rather than business database fields.

Jaeger acceptance checks Gateway -> Console -> Controller -> official Workflow
and Activity spans, including actual RPC/transaction/SQL descendants. Wait six
seconds for export after completion. After normal worker Stop and client Close, the Controller finishes any remaining
actual SDK Workflow spans with `antnest.temporal.workflow.span_end=worker_shutdown`
before provider shutdown. A replacement worker may create another span for the
same logical Workflow/Run; both original contexts remain. `workflow_return`
identifies normal SDK span End, which can still carry a workflow error. A process
killed before shutdown/export may lose an unfinished span; that remains an
evidence gap, never a fabricated successful span.

Outbound `rpc.system=http_json` is replaced by
`rpc.system.name=antnest.http-json`. Existing lifecycle attributes remain;
`antnest.operation.id`, `.phase`, `.attempt` are added alongside them. The
SERVER route names remain `HTTP <method> <normalized route>`. Root assertions
must no longer expect successful parented `/status` and
`/rpc/agent-controller/status` to be absent. Unparented successful probes
remain suppressed. There are no new downstream readiness calls.

Regression coverage includes complete nested/new RPC fields beyond 16 KiB, disabled capture without serialization, actual parent IDs, protocol failures and long SSE flushes without payload events.

`tests/integration/go/agent-controller/internal/repository/postgres/observation_integration_test.go` adds real
PostgreSQL coverage through the production constructors and the existing
`ANTNEST_AGENT_CONTROLLER_TEST_DATABASE_URL` fixture: query parenting, commit
and replay rollback, SQLSTATE/error status, parameter/result omission, batch
children, query/empty poll suppression without a recording parent, a new unwrapped method,
LISTEN startup/saved reconnect configuration, and SQL below SDK Activity and transaction parents. Use an isolated test database; the existing fixture resets this service's
schema. E2E workflow assertions now require driver SQL and reject old wrapper
spans. These tests still require coordinator execution, including repeated runs.

Remaining limits include synthetic test coverage for cancellation/upgrade
edge cases, process-wide concurrency pressure and shutdown/export failure.
The transport does not retain outbound content; controller SSE previews are
omitted. Some existing application errors still replace lower-level causes;
this change preserves send/read/close causes at HTTP adapters but does not
claim every lifecycle branch is cause-preserving. RPC capture includes model pricing and provider endpoint values when enabled.

Admission results and integration status are recorded in the platform
[service rollout](../../../docs/observability-rollout.md).
