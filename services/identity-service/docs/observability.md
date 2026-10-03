# Identity Observability

This document describes how Identity Service implements the shared
[observability contract](../../../docs/observability-contract.md) at HTTP,
JSON RPC/SCIM, OIDC adapter, and PostgreSQL driver execution boundaries.
Business services do not call tracing APIs or an injected telemetry port.

## Transaction Envelopes

`postgresql transaction` is an INTERNAL span beneath the owning request or
background attempt. BEGIN, transaction SQL and COMMIT/ROLLBACK are CLIENT
children; non-transaction SQL keeps its original parent. Batch envelopes remain.
Prepare and pool acquisition do not create spans: they are not a second SQL
execution. `antnest.transaction.outcome` distinguishes completion.

The private database pool returns a transaction handle that owns the envelope
context. Query/Exec/QueryRow inherit it automatically while preserving the
caller's deadlines and cancellation. Commit/Rollback finish it once; a deferred
second Rollback cannot change the first outcome. No business method creates or
names a span.

## Capture Policy

`ANTNEST_TELEMETRY_CAPTURE_RPC_CONTENT=false` is the only content switch.
When enabled, the RPC dispatcher records complete decoded parameters and
results as JSON in `antnest.request` / `antnest.response` events. Issued `caller_context` is always omitted from response capture. Other DTO
content retains the existing capture behavior; no 16 KiB limit or collection
projection is added.
Disabled capture does not serialize DTOs. Standard SDK limits still apply.

This is a development diagnostic capability: login passwords, access tokens
and other credentials inside RPC DTOs are included when enabled. Restrict
collector access and retention. Never commit exported traces containing them.

HTTP, OIDC and SCIM record metadata and errors only: no Header values, bodies,
omission events or stream aggregation. RPC capture occurs once at the receiving
dispatcher, not again in its HTTP transport. Completion logs never carry bodies.
Only W3C trace context is propagated, not external baggage.

## Boundaries

One inbound SERVER span extracts the upstream context, including successful
`/status`. Readiness checks local initialization/stopping state and Identity's
own PostgreSQL only. One outbound CLIENT span is created before injection and
ends on response EOF/close, cancellation or transport failure. HTTP wrappers
do not pre-read or aggregate streams, and preserve flushing and upgrades.
OIDC semantic validation has an INTERNAL adapter span, not a duplicate CLIENT;
HTTP 200 does not hide OAuth or signature/claims failures.

RPC and SCIM writers observe errors before mapping their wire responses. Error
summaries retain safe code, phase and up to four cause types; arbitrary error
strings and database Detail are excluded. PostgreSQL observation is separate
from these protocol summaries. `repository.ParsePoolConfig` installs
`github.com/exaring/otelpgx` v0.12.0 with `otelpgx.NewTracer()` before the
production pool is created. The same connection config covers queries, batches,
transaction statements and connections acquired from the pool. Migrations and
bootstrap use that pool.

Driver CLIENT titles retain the SDK's default operations (`SELECT`, `INSERT`,
`BEGIN`, `COMMIT`, `ROLLBACK`). No SQL parser, table-name inference, extra schema
query or naming callback is installed. Inspect the original SQL attribute when
the accessed tables matter. Driver query hooks do not expose a compiled SQL AST.
`db.query.text` contains the statement with placeholders, without bind parameters
or result sets. The default connection metadata does not include a full connection
string. Connection and batch spans retain the driver's parent relationships.
Only execution, batch, copy and connection tracer hooks are exposed; prepare and
pool acquisition hooks are deliberately absent, without changing pgx's actual
prepare or pooling behavior. A query requires a recording parent; unparented
startup work does not manufacture a root span for every SQL statement.

Driver failures retain the default exception/status information and
`pgx.sql_state`. Driver error messages and SQL literals can contain server-supplied
or application-supplied text; they are not the bounded protocol error summaries.
Restrict access to traces accordingly. No parameter capture option, handwritten
SQL parser, per-query naming callback, whitelist or truncation is installed.
Error normalization preserves the original cause and the public error
code/message.

## Span And Metric Names

- Inbound SERVER spans are named `HTTP <METHOD> <route>`.
- OIDC CLIENT spans are named `HTTP <METHOD> <hostname>`, without path, query,
  or full-URL attributes.
- OIDC INTERNAL spans are `identity.oidc.discover` and
  `identity.oidc.exchange_verify`. They are semantic adapter operations, not
  duplicate CLIENT spans.
- Database CLIENT spans come from instrumentation scope
  `github.com/exaring/otelpgx` with `db.system.name=postgresql`. Select them by
  scope, operation, and parent relationship rather than by repository method
  name or fixed span count. There are no `identity.repository.<operation>`
  spans.
- Database SQLSTATE is `pgx.sql_state`; protocol error summaries expose
  `db.response.status_code`.
- HTTP `antnest.result` uses `rejected` for 4xx rejections and `cancelled` for
  cancellation, and `antnest.outcome` is also recorded. An aborted request is
  not reported as a transmitted HTTP 500.
- `db.client.operation.duration` and `db.client.operation.errors` measure
  driver operations, not business results. There are no
  `antnest.identity.repository.operations` or
  `antnest.identity.repository.duration` series. Business rejection and
  protocol outcomes are observed at the HTTP/RPC/SCIM boundaries.

## Limits

Pure in-memory decisions without an adapter boundary are not separately
traced. There are no per-chunk or per-token spans, and observability adds no
retry, schema, audit store or diagnostic database. Revocation feed rows store
the originating trace parent. Readiness does not perform recursive probes.

## Test Coverage

Service tests cover switch-off without serialization, full nested RPC fields,
content beyond 16 KiB, unchanged credential wire responses, HTTP/SCIM/stream
content exclusion, remote parent IDs, HTTP-200 protocol failures, body lifetime,
cancellation, SQLSTATE and exporter-disabled propagation.

PostgreSQL tests use the isolated-schema fixture and the production pool
configuration constructor. `TestPostgresDriverObservationAutomaticExecution`
covers unparented and non-recording-parent work, an unwrapped query function,
QueryRow/Query/Exec, commit/rollback, batch statements, a dedicated connection,
SQLSTATE errors, exact execution counts, parent IDs and bind/result exclusion.
`TestIdentityProtocolHappyPath` checks driver children of local login, SCIM User
creation and OIDC callback SERVER spans, together with its protocol and replay
assertions. Lock-admission probes compose with the production driver tracer.

Run the checks serially from the repository root:

```sh
make fmt-check
make lint
go test -p=1 ./services/identity-service/...
go test -race -p=1 ./services/identity-service/...
make test-identity-postgres
```

Cross-service parent trees and Jaeger scenarios are outside this service's
test suite.
