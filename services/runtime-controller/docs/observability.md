# Runtime Controller Observability

This service implements the boundary policy in
[`../../../docs/observability-contract.md`](../../../docs/observability-contract.md).
Implementation and coordinator acceptance are separate: the changes described
here require serial formatting, lint, unit, architecture and integration gates.

## Transaction Envelopes

`postgresql transaction` is an INTERNAL span beneath the owning request or
background attempt. BEGIN, transaction SQL and COMMIT/ROLLBACK are CLIENT
children; non-transaction SQL keeps its original parent. Batch envelopes remain;
prepare and pool acquisition do not create spans. `antnest.transaction.outcome`
distinguishes completion.

`database/sql` can initiate rollback on cancellation without calling a repository's cleanup. The production connector wraps native `driver.Tx`, so the envelope ends only after that driver's Commit/Rollback returns. Query and prepared-statement calls keep the transaction context while preserving caller cancellation. The adapter adds no retry or rollback of its own.

## Boundary Contract

- One HTTP SERVER span covers every route, including successful upstream-context
  `/status`, unmatched requests and observation SSE until delivery ends. Route
  names contain the method once and never contain instance paths or queries.
- One shared HTTP transport creates CLIENT before injecting W3C trace context,
  for Docker Engine and Runtime status calls. It ends on EOF, close, cancellation
  or transport failure, without reading ahead or buffering streams. Runtime
  status verification is an INTERNAL adapter operation and observes protocol
  failures even when HTTP returned 200.
- Existing lifecycle dispatcher and platform boundaries retain operation IDs,
  opaque revision, private generation/attempt and physical IDs. Persistence is
  instrumented at the pgx execution boundary, not by repository method.
  No domain telemetry port, lifecycle state machine or database is added.
- `/status` checks local initialization and own persistence only. The existing
  `platform_ready` wire field describes adapter initialization, not a fresh
  Docker permission/health probe. Runtime verification remains part of real
  lifecycle and inspection requests, not Controller readiness.

## PostgreSQL Execution

`postgres.OpenDatabase` is shared by production startup and the PostgreSQL
integration fixture. It installs `github.com/exaring/otelpgx v0.12.0` with
`otelpgx.NewTracer()` on the pgx connection configuration before `stdlib.OpenDB`.
Both the query pool (20 open / 5 idle) and dedicated advisory-lock pool
(8 open / 8 idle) keep their existing ownership and 30-minute connection lifetime.
Reserved `sql.Conn` connections and native pgx connections used by LISTEN inherit
that tracer; no alternate uninstrumented production connector remains.

- SQL execution spans use the library's low-cardinality operation names, such
  as `SELECT`, `INSERT`, `BEGIN`, `COMMIT`, `ROLLBACK` and `LISTEN`, with CLIENT
  kind and instrumentation scope `github.com/exaring/otelpgx`.
- `db.query.text` retains the SQL statement with placeholders. Bind parameters,
  returned row contents and notification payloads are not captured. The library
  retains rows-affected counts and connection metadata (host, port, user and
  database), not a full connection string. No custom naming, parameter option,
  SQL parser, whitelist or truncation is installed.
- Query, batch, copy and transaction execution use the same connection
  instrumentation. The constructor does not expose prepare/pool-acquire tracer
  hooks; this does not change actual preparation or pooling. Connection and batch-container spans need not carry
  `db.query.text`; trace assertions must distinguish them from SQL execution.
- A recording parent is required by the default tracer. Background startup,
  probes and queries with only a non-recording remote context do not gain a new
  root SQL span. Existing lifecycle, platform event and reconciliation spans
  remain the owners of their SQL children.
- Advisory-lock acquisition, probes and release are SQL operations, not a span
  around the locked callback. LISTEN's SQL span ends before notification waiting;
  there is no database span or wrapper metric lasting the whole listener session.
  The observation Hub, journal health, notifications and platform monitor keep
  their existing business behavior.
- `telemetry.ObserveRepository`, `runtime.repository.*` spans and the old
  `runtime.repository.operations` / `runtime.repository.operation.duration`
  metrics are removed. Driver metrics use `db.client.operation.duration` and
  `db.client.operation.errors`; they measure driver operations, not business
  repository methods. No pgxpool stats collector is installed over `database/sql`.

The RPC content switch does not enable SQL bind/result capture. SQL literals
remain in query text, and default otelpgx exception/status text records database
errors, which can contain server-supplied values. This is not a guarantee of
database-diagnostic redaction; collector access and retention must account for
that exposure. Business errors, idempotency checks and SQL error chains remain
unchanged. A successful SQL query returning no rows is not a driver error merely
because the repository maps it to `ErrNotFound`.

## RPC Content

`ANTNEST_TELEMETRY_CAPTURE_RPC_CONTENT=false` is the only content switch.
Enabled RPC adapters record complete decoded parameters/results as JSON,
including MCP arguments/environment, endpoints and diagnostic details.
There is no field whitelist, custom payload budget or omission event.
This development capability can include credentials: restrict collector access
and retention. Disabled capture does not serialize DTOs.

Ordinary HTTP, status, Header values, SSE and Docker event streams carry only
metadata, counts, lifecycle and errors. RPC identity is bound at registration,
not inferred by the transport. Operation outcome observation remains independent
of content capture, including failed results returned inside HTTP 200.

New runtimes inherit `ANTNEST_TELEMETRY_CAPTURE_RPC_CONTENT` through the existing
`RuntimeOTEL` mapping, with no RuntimeSpec field or per-runtime override.
Standard OTEL export settings remain separate; exporter credential/header
environment variables remain excluded. Applying changed process configuration
to a Runtime still follows the existing deployment lifecycle.

## Coordinator Verification

Worker changes are not test or deployment evidence. The new
`TestRepositoryTelemetry*` cases use the existing
`ANTNEST_RUNTIME_CONTROLLER_TEST_DATABASE_URL` fixture and the production
constructor. They exercise real query/error execution, commit/replay/rollback,
recording-parent behavior, dedicated locks, finite LISTEN and native pgx batches.
A new SQL caller with no repository wrapper is included, with assertions for
parentage, SQL text, parameter/result omission and absence of old wrapper spans.

The fixture drops and recreates the service schema: use only the disposable test
database, never production, and run serially. The existing
`make test-runtime-controller-postgres` selects these tests through its
`TestRepository` filter. The coordinator must also run formatting, lint, affected
module tests, architecture/documentation checks and applicable real trace/race
profiles. No tests, builds, lint, formatting commands or external profiles were
run by this worker. Root trace assertions and dashboards that depend on old
repository names/metrics must be reviewed by the coordinator; they are outside
this service's write scope.

## Limits Pending Acceptance

- Coordinator must verify real Docker/PostgreSQL/Jaeger traces and root profiles;
  these are not worker-run evidence.
- Initial process startup still waits for the pre-existing platform monitor
  handshake/reconciliation. Only the HTTP readiness probe and local health
  predicate are decoupled here; startup supervision was not redesigned.
- Runtime lifecycle attempts remain synchronous/reconciled by explicit retries;
  there is no persisted trace context or cross-restart attempt Link guarantee.
- No SSE content preview, remote diagnostic scope/expiry controller, tail
  sampling, export-drop accounting or concurrency/queue saturation evidence is
  claimed. No raw body fallback is provided for these limits.
- Client bodies are explicitly omitted by the shared transport. Docker/runtime
  adapter spans retain safe parsed results; duplicate sender-side DTO events
  are not claimed. A response-body close error after an already observed EOF
  is returned to the caller but cannot reopen the ended CLIENT span.
- Platform monitor failure reporting retains its existing runner instrumentation;
  it has not yet been migrated to the new shared error event helper.
- Go errors have no origin stack by default. Typed cause summaries do not claim
  an observation-site stack is an origin stack.
