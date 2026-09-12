# Control Observability

This service implements the platform [observability contract](../../../docs/observability-contract.md)
at its control HTTP adapter and its own PostgreSQL adapter. This document is an
implementation specification; the bounded integration results below do not
claim full load or failure-mode acceptance.

## Transaction Envelopes

`postgresql transaction` is an INTERNAL span beneath the owning request or
background attempt. BEGIN, transaction SQL and COMMIT/ROLLBACK are CLIENT
children; non-transaction SQL keeps its original parent. No prepare or pool-acquire span is emitted. A batch stays one native API call;
telemetry does not split it into synthetic SQL executions. `antnest.transaction.outcome` distinguishes completion.

The private Transaction owns the envelope and parents every primitive to it. Explicit completion ends it after the native future resolves. Native Drop still only queues rollback; its outcome remains `unconfirmed`, and cancellation or unwind never claims a committed transaction. No packet/flow tracing is introduced.

## Boundaries

- One SERVER span per HTTP request, named by method and matched route template.
  W3C context is extracted before span creation, including successful `/status`.
  Query strings, baggage, credentials and unrecognized headers are not captured.
- `/status` remains a local snapshot of initialization and own repository health;
  it does not query another service or change the existing readiness response.
- The span ends on response EOF, body failure or drop. Request cancellation and
  unwinding are recorded without inventing an HTTP response. Body wrappers count
  observed bytes while preserving polling, trailers, size hints and backpressure.
- PostgreSQL has one CLIENT span per awaited database API primitive. A single
  service-local Client/Transaction wrapper owns private native handles; neither
  Deref to the native driver nor a raw-handle accessor is available to repository
  helpers. The pool lease dereferences only to this observed Client. There is no
  repository-method span, callback registry or per-method observation start/finish.
- Names and `db.operation.name` use the leading SQL word in uppercase, matching
  the Go services' otelpgx default: `SELECT`, `INSERT`, `UPDATE`, etc. Empty
  statements use `UNKNOWN`; `WITH` and leading comments are not parsed or rewritten.
  A native multi-statement batch is `BATCH`; transaction primitives are `BEGIN`,
  `COMMIT` and `ROLLBACK`. There is no table-name extraction, SQL grammar parser,
  extra query or per-business-operation annotation. This is a small private
  adapter, not a claim that tokio-postgres provides automatic OTEL hooks.
  `db.query.text` is the exact SQL passed to the API with placeholders intact.
  `db.namespace` comes from the connection database (defaulting to its configured
  user), not our schema name. User, unambiguous configured host and port come from
  tokio-postgres Config getters; multi-host destinations are omitted rather than
  guessed. DSNs, passwords, bind arguments and result rows are not collected.
- Startup/session configuration, migrations and seeding use the same wrapper as
  control and recovery/sweep queries. Acquisition itself does not produce a SQL
  span. Pool size, health, connection reuse/discard, statement/lock settings and
  the existing 5-second repository deadline are unchanged; the wrapper adds no
  timeout, retry, connection task or transaction-management query.
- Query/commit errors retain the original driver Result and export a standard
  exception event, native message and source chain. PostgreSQL SQLSTATE, detail,
  hint and error object names come from typed DbError getters, not string parsing
  or a business error dictionary. Error text can contain server-echoed data;
  this follows the accepted development diagnostic policy, not redaction. Domain
  rejections are still reported by the upstream control RPC boundary, not inferred
  from successful SQL. A cancelled in-flight future is `cancelled`, never success;
  an unpolled future produces no execution span. Transaction drop delegates to
  the driver's existing queued rollback and records `ROLLBACK` with
  `antnest.transaction.completion=unconfirmed` and a cancelled outcome (error on
  unwind), using the parent captured at begin. It does not await rollback or claim
  its success. Awaited primitive success means the native API returned Ok, not a
  separate claim of a committed business transaction.
- There is no outbound business HTTP client in Egress. OTLP exporter traffic is
  not recursively instrumented. UDP, TUN, DNS, packet and flow paths are unchanged
  and never produce packet/flow spans.

## Diagnostic Data

The single switch `ANTNEST_TELEMETRY_CAPTURE_RPC_CONTENT` defaults to false.
When enabled, the control RPC adapter records complete decoded parameters and
results, without DTO whitelists, identifier-based body filtering or a custom
16 KiB limit. Unknown fields rejected by the real protocol remain rejected;
telemetry never changes decoding. Content can include credentials as the
protocol evolves, so restrict collector access and retention.

Database SQL statement capture is independent of this RPC switch. SQL text is
always eligible for capture; bind arguments and query results are never captured.
Literal values already written into SQL remain part of its text, so application
values must continue to use bind parameters. SDK sampling and attribute limits
still apply.

HTTP and Header values are metadata-only. Local status, unmatched paths and
message streams never generate payload or omission events. Request/response
capture runs inside the registered RPC request scope; disabling it avoids
extra serialization. Standard SDK resource limits remain independent.

The dispatcher preserves stable error codes, phase, safe messages and typed
causes before HTTP mapping. Expected 4xx refusals are `rejected`, not server
faults. Protocol errors retain their HTTP status, including HTTP 200. Control error
responses keep their existing safe messages; database spans retain native diagnostics. Existing application errors
return `Result`; instrumentation belongs to adapters, not a telemetry port.

## Verification And Limits

Existing service tests cover incoming parents, complete RPC DTOs, switch-off without
extra serialization, large/new nested values, unchanged wire responses, HTTP
and stream content exclusion, readiness errors and packet paths without spans.

Database regression tests must verify the platform contract, not the old Rust
API-primitive labels. The private
wrapper tests use `ANTNEST_EGRESS_TEST_DATABASE_URL` from the existing isolated
PostgreSQL fixture and temporary session tables. They exercise Client and
Transaction primitives, SQL/parent identity, SQLSTATE (including deferred commit
failure and aborted transactions), native drop rollback, cancellation, statement
timeout, exact SQL, bind/result exclusion and native error diagnostics. The `postgres_repository` target
also checks all production Repository methods for the exact primitive sequence
and span count, including early-return rollback and domain rejection. Unit tests
cover unpolled/cancelled futures, unwind and typed driver-source retention.

The coordinator must run the normal service unit/Clippy/formatting and admission
gates serially, plus `make test-egress-postgres`. That target provisions the
isolated database and runs both the private real-DB tests and production
Repository integration binary serially. Fixture provisioning, credentials and
all verification remain coordinator-owned.

Pending integration evidence: collector export failures/queue pressure,
concurrent-memory pressure and bounded shutdown under load.
Sampling/retention can remove linked upstream evidence.
This service has no SSE/WS business RPC, durable control attempt runner or
operation/session IDs; none are invented for tracing. Kernel cleanup still uses
the existing string-error interface; its original value is retained in-process
but only a registered safe cause is exported. Local validation/schema-conversion
errors that do not execute SQL do not invent database spans.
Legacy background health/sweep lifecycle logs remain in the application; ordinary
HTTP result logging is now owned by the common boundary. Startup/schema conversion
errors may still use legacy string storage rather than typed driver sources. The
normal query/transaction and connection error paths retain typed PostgreSQL sources.
Readiness still returns the existing JSON protocol, including HTTP 200 for a
`degraded` snapshot. The common response adapter records `service_not_ready`
without changing the HTTP status or readiness JSON.

## Integration

- HTTP operation queries use `HTTP METHOD /matched/template`, replacing `egress.control`;
  SERVER kind is explicit. No INTERNAL operation names were removed.
- `antnest.policy.revision` is a string; existing Agent/policy IDs and
  `failure.stage` / `failure.cause` remain. New project errors use the shared
  `antnest.error.*` fields. 4xx outcomes are `rejected`, not server errors.
- Include `/status` spans in upstream-context expectations. Readiness JSON/status
  semantics did not change; there are still no recursive health calls.
- Database CLIENT names use SQL operations; expect one child per actual wrapper
  call, not one per repository method. Drop rollback is explicitly
  unconfirmed. There are no packet/flow spans or new data-plane OTLP paths.
- `http-body = 1.0.1` is a direct dependency, with its locked dependency list
  synchronized. It was already present transitively.
- Final formatting, compilation, unit/integration results and live Jaeger
  coverage are recorded in the [platform rollout](../../../docs/observability-rollout.md).

## SQL Alignment Acceptance: 2026-09-12

- Full macOS suite: 107 passed; Linux image suite: 108 passed. The ten opt-in
  PostgreSQL cases were separately executed, not counted as passing while ignored.
- Private real-PostgreSQL transaction cases: 3 passed; production Repository
  cases: 7 passed. These include errors, cancellation and database timeouts.
- Observability script suite: 126 passed. Root `make fmt-check lint` passed,
  including both Rust Clippy checks with warnings denied.
- Image `sha256:9a3e692d775bcb4d7775ddebf799cf0765cfb9a9fc100a4e846422d832214a3d`
  was deployed and is healthy. Only the isolated test database was removed.
- [Live Gateway-to-Egress trace](http://127.0.0.1:16686/trace/08e698fc4975c209da3a2c84d32862db):
  21 spans, zero warnings or missing parents; four HTTP hops, each once. The
  Egress request owns four direct SELECTs and one committed transaction containing
  BEGIN, three SELECTs and COMMIT. Namespace is `antnest_egress`, SQL titles are
  operations, and no prepare/acquire or packet spans are emitted.

Reproduce with `node scripts/observability/exercise-egress-database.mjs
--confirm-development --agent AGENT_ID` from the platform root. The script reads
development login settings locally, submits the current policy and version,
asserts unchanged persisted configuration, verifies the trace, and logs out.
Use an idle test Agent: assigning the same policy can still reset active flows;
this is not a data-plane no-op or network continuity test. Historical lifecycle
traces retain their old database titles and are not new-image SQL acceptance.

The [business-flow review](../../../docs/business-flow-trace-review.md) separates
these evidence boundaries and records the remaining simplification questions.
