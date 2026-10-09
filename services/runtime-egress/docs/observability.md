# Control Observability

This document specifies how Runtime Egress implements the platform
[observability contract](../../../docs/observability-contract.md) at its
control HTTP adapter and its own PostgreSQL adapter: span boundaries, SQL span
naming, diagnostic data, error mapping, and known limits. Packet, flow, and DNS
paths are outside this model and never produce spans.

The aggregate `antnest.egress.dns.answers.filtered` monotonic counter counts
answer records removed by resolver policy, including unusable CNAMEs and AAAA
records. Queries answered locally without reaching the upstream (AAAA and
non-public reverse lookups) remove no records and are not counted. Repeated snapshots do not double-count. It has no attributes, query
names, addresses or Agent identifiers; DNS filtering adds no per-query logs.

## Transaction Envelopes

`postgresql transaction` is an INTERNAL span beneath the owning request or
background attempt. BEGIN, transaction SQL, and COMMIT/ROLLBACK are CLIENT
children; non-transaction SQL keeps its original parent. No prepare or
pool-acquire span is emitted. A batch stays one native API call; telemetry does
not split it into synthetic SQL executions. `antnest.transaction.outcome`
distinguishes completion.

The private Transaction owns the envelope and parents every primitive to it.
Explicit completion ends it after the native future resolves. Native Drop still
only queues rollback; its outcome remains `unconfirmed`, and cancellation or
unwind never claims a committed transaction.

## Boundaries

- One SERVER span per HTTP request, named by method and matched route template.
  W3C context is extracted before span creation, including successful `/status`.
  Query strings, baggage, credentials, and unrecognized headers are not captured.
- `/status` on the separate loopback health listener remains a local snapshot of initialization and own repository health;
  it does not query another service or change the readiness response.
- The span ends on response EOF, body failure, or drop. Request cancellation and
  unwinding are recorded without inventing an HTTP response. Body wrappers count
  observed bytes while preserving polling, trailers, size hints, and backpressure.
- PostgreSQL has one CLIENT span per awaited database API primitive. A single
  service-local Client/Transaction wrapper owns private native handles; neither
  Deref to the native driver nor a raw-handle accessor is available to repository
  helpers. The pool lease dereferences only to this observed Client. There is no
  repository-method span, callback registry, or per-method observation start/finish.
- Span names and `db.operation.name` use the leading SQL word in uppercase,
  matching the otelpgx default used by the Go services: `SELECT`, `INSERT`,
  `UPDATE`, and so on. Empty statements use `UNKNOWN`; `WITH` and leading
  comments are not parsed or rewritten. A native multi-statement batch is
  `BATCH`; transaction primitives are `BEGIN`, `COMMIT`, and `ROLLBACK`. There is
  no table-name extraction, SQL grammar parser, extra query, or
  per-business-operation annotation. tokio-postgres has no automatic
  OpenTelemetry hooks; this small private adapter provides the spans.
  `db.query.text` is the exact SQL passed to the API with placeholders intact.
  `db.namespace` comes from the connection database (defaulting to its configured
  user), not the schema name. User, an unambiguous configured host, and port come
  from tokio-postgres Config getters; multi-host destinations are omitted rather
  than guessed. DSNs, passwords, bind arguments, and result rows are not collected.
- Startup/session configuration, migrations, and seeding use the same wrapper as
  control and recovery/sweep queries. Acquisition itself does not produce a SQL
  span. Pool size, health, connection reuse/discard, statement/lock settings, and
  the 5-second repository operation deadline are unaffected; the wrapper adds no
  timeout, retry, connection task, or transaction-management query.
- Query/commit errors retain the original driver Result and export a standard
  exception event, native message, and source chain. PostgreSQL SQLSTATE, detail,
  hint, and error object names come from typed DbError getters, not string
  parsing or a business error dictionary. Error text can contain server-echoed
  data; it follows the platform development diagnostic policy and is not
  redacted. Domain rejections are reported by the upstream control RPC boundary,
  not inferred from successful SQL. A cancelled in-flight future is `cancelled`,
  never success; an unpolled future produces no execution span. Transaction drop
  delegates to the driver's queued rollback and records `ROLLBACK` with
  `antnest.transaction.completion=unconfirmed` and a cancelled outcome (error on
  unwind), using the parent captured at begin. It does not await rollback or
  claim its success. Awaited primitive success means the native API returned Ok,
  not a claim that a business transaction committed.
- Egress has no outbound business HTTP client. OTLP exporter traffic is not
  recursively instrumented. UDP, TUN, DNS, packet, and flow paths never produce
  spans.

## Diagnostic Data

The single switch `ANTNEST_TELEMETRY_CAPTURE_RPC_CONTENT` defaults to false.
When enabled, the control RPC adapter records complete decoded parameters and
results after workload admission and strict carrier validation. The business
JSON limit is 4 KiB; telemetry adds no separate truncation or decoding rule.
Unknown and duplicate fields rejected by the real protocol remain rejected.
Workload, user Authorization, Cookie, caller-context and unsigned identity
headers are never payload data and are removed before business handling.
Authentication, media and pre-decode refusals record only bounded error
classification, route/status and observed sizes, even with capture enabled.
Restrict collector access and retention for admitted business content.

Database SQL statement capture is independent of this RPC switch. SQL text is
always eligible for capture; bind arguments and query results are never captured.
Literal values already written into SQL remain part of its text, so application
values must continue to use bind parameters. SDK sampling and attribute limits
still apply.

HTTP and header values are metadata-only. Local status, unmatched paths, and
message streams never generate payload or omission events. Request/response
capture runs inside the registered RPC request scope; disabling it avoids
extra serialization. Standard SDK resource limits remain independent.

The dispatcher preserves stable error codes, phase, safe messages, and typed
causes before HTTP mapping. Expected 4xx refusals are `rejected`, not server
faults. Protocol errors retain their HTTP status, including HTTP 200. Control
error responses keep their safe messages; database spans retain native
diagnostics. Application errors return `Result`; instrumentation belongs to
adapters, not a telemetry port.

## Tests

Service tests cover incoming parents, complete RPC DTOs, switch-off without
extra serialization, large and new nested values, unchanged wire responses, HTTP
and stream content exclusion, readiness errors, and packet paths without spans.

Database tests verify the platform contract. The private wrapper tests use
`ANTNEST_EGRESS_TEST_DATABASE_URL` from the isolated PostgreSQL fixture and
temporary session tables. They exercise Client and Transaction primitives,
SQL/parent identity, SQLSTATE (including deferred commit failure and aborted
transactions), native drop rollback, cancellation, statement timeout, exact SQL,
bind/result exclusion, and native error diagnostics. The `postgres_repository`
target also checks every production Repository method for the exact primitive
sequence and span count, including early-return rollback and domain rejection.
Unit tests cover unpolled and cancelled futures, unwind, and typed driver-source
retention.

`make test-egress-postgres` provisions the isolated database and runs both the
private real-database tests and the production Repository integration binary
serially.

`tests/e2e/observability/exercise-egress-database.mjs` exercises the database
spans end to end. Run it from the repository root with
`node tests/e2e/observability/exercise-egress-database.mjs --confirm-development --agent AGENT_ID`.
The script reads development login settings locally, submits the current policy
and version, asserts unchanged persisted configuration, verifies the trace, and
logs out. Use an idle test Agent: assigning the same policy can still reset
active flows, so this is neither a data-plane no-op nor a network continuity
test.

## Limits

- Automated tests do not cover collector export failures, queue pressure,
  concurrent memory pressure, or bounded shutdown under load.
- Sampling and retention can remove linked upstream spans.
- The service has no SSE/WS business RPC, durable control attempt runner, or
  operation/session IDs; none are invented for tracing.
- Kernel cleanup uses a string-error interface. Its original value is retained
  in-process, but only a registered safe cause is exported.
- Local validation and schema-conversion errors that do not execute SQL do not
  create database spans.
- Background health and sweep lifecycle logs are emitted by the application;
  ordinary HTTP result logging is owned by the common boundary.
- Startup and schema-conversion errors may use string storage rather than typed
  driver sources. Normal query/transaction and connection error paths retain
  typed PostgreSQL sources.
- Readiness returns the existing JSON protocol, including HTTP 200 for a
  `degraded` snapshot. The common response adapter records `service_not_ready`
  without changing the HTTP status or readiness JSON.

## Consumer Expectations

- HTTP operation spans are named `HTTP METHOD /matched/template` with SERVER kind.
- `antnest.policy.revision` is a string; Agent/policy IDs and
  `failure.stage` / `failure.cause` are recorded. Project errors use the shared
  `antnest.error.*` fields. 4xx outcomes are `rejected`, not server errors.
- `/status` spans appear in upstream-context traces. There are no recursive
  health calls.
- Database CLIENT spans are named by SQL operation; expect one child per wrapper
  call, not one per repository method. Drop rollback is explicitly unconfirmed.
- The database namespace is `antnest_egress` in the development Compose
  topology.
- There are no packet or flow spans and no data-plane OTLP paths.
