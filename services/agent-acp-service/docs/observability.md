# ACP Observability

This document describes how Agent ACP Service implements the platform
[observability contract](../../../docs/observability-contract.md) at transport,
SDK dispatch and existing application/adapter boundaries: span boundaries,
optional RPC content capture, PostgreSQL tracing, span names and known limits.

## Implementation Contract

- One HTTP SERVER span covers response finish, disconnect and upgrade. Extract
  W3C trace context before starting it; never propagate inbound baggage.
- A common fetch wrapper creates CLIENT before injection and ends at response
  EOF, cancellation or read failure. Model and Runtime MCP use it; ordinary
  execution does not call Controller.
  Adapter operations are INTERNAL, not duplicate CLIENT spans.
- The ACP dispatcher records registered v1/v2 requests with their own context,
  complete decoded request/response values (when enabled) and protocol outcome. WebSocket requests
  without request metadata use connection Links, not a handshake parent.
- For v1 HTTP, the telemetry adapter carries the actual receiving SERVER context
  through standard ACP `_meta.traceparent`/`tracestate`. The SDK's persistent
  queue does not preserve the current POST's async-local context. The adapter
  reads only the already byte-bounded JSON copy, preserves other fields and
  delegates invalid inputs, routing and responses to the official SDK. It does
  not create a private wire field or require a modified client.
- `ANTNEST_TELEMETRY_CAPTURE_RPC_CONTENT=false` is the single switch. When true,
  discrete ACP RPC parameters/results are captured on the receiving dispatcher
  span as `antnest.request` / `antnest.response`, each with one
  `antnest.payload.json` attribute. New and nested fields require no registration.
  Prompts and returned content are included; this is an explicit development
  diagnostic choice, not a secure retention policy. The execution snapshot
  endpoint is metadata-only because it receives Provider credentials.
- HTTP headers/bodies, WebSocket/SSE frames, session notifications, model streams
  and progress are not captured or reconstructed. INTERNAL Run/Tool/permission
  spans remain metadata-only. HTTP CLIENT spans do not duplicate receiving RPC
  payloads. Disabling capture does not serialize contents or emit omission events.
- No client-side whitelist, JSON tree walker, 16 KiB cap or per-span custom event
  budget is maintained. Standard OTel SDK limits and export behavior apply.
  Error outcomes/causes, propagation and stream lifecycle remain independent of
  content capture.
- Readiness depends on local initialization, worker ownership, recovery and
  the private PostgreSQL database only. It never probes Controller readiness.
- Permission observation belongs to a decorator around `ToolPermissionPort`;
  business decision code returns its existing result. Run execution retains
  its existing interface and terminal facts; no telemetry business hooks.
- The ACP application decorator counts durable Bridge intent reuse as
  `antnest.acp.bridge_intent_reuse`, with only `result=hit|conflict`. It records
  `intent_already_recorded` and `idempotency_conflict` after the authorized
  producer check; ordinary prompts and unrelated admission failures do not
  increment it. The metric never labels identity, Agent, Session, intent or
  Prompt content. Service tests verify both outcomes and label privacy. A
  production-image Docker test
  (`tests/e2e/agent-acp-service/bridge-intent-metric-container.test.mjs`) runs
  the exported application decorator against both outcomes, flushes OTLP/HTTP on
  normal shutdown, and verifies the actual counter data points and their sole
  `result` label. Other existing ACP metrics
  retain their own attribute policies.

### PostgreSQL Boundary

- The official `@opentelemetry/instrumentation-pg` instruments the driver before
  application composition loads `pg`. It covers pool queries, transaction-client
  queries, readiness, migrations and worker ownership without repository hooks.
- Each actual SQL execution creates one CLIENT span. Its title is the driver's
  operation (for example `SELECT`), not a repository action. Native
  `db.query.text`, `db.namespace`, `server.address` and `server.port` describe the
  operation; SQL retains placeholders. Parameters and returned rows are never
  captured. No custom SQL parser or table-name extraction is added.
- The pinned pg instrumentation 0.74.0 emits operation/error attributes on
  metrics but omits them from spans. One presentation processor strips only
  the SDK title's fixed `pg.query:` prefix/database suffix and copies native
  exception type; the SDK response hook uses pg's structured `command` for
  successful executions. Neither inspects SQL or changes query execution.
- Connect/pool-acquire spans are disabled. The kernel does not add a second
  query span. Repository request/duration metrics remain separate from tracing.
- `postgresql transaction` is one INTERNAL span wrapping BEGIN, all statements
  and the actual COMMIT or ROLLBACK. `antnest.transaction.outcome` is `committed`,
  `rolled_back` or `failed`; a failed COMMIT never becomes a successful commit
  because a subsequent cleanup ROLLBACK returned. Original and rollback errors
  retain their existing propagation and broken clients are still discarded.
  PostgreSQL can also answer COMMIT with a structured `ROLLBACK` command after
  an earlier statement aborted the transaction; that actual outcome is recorded,
  rather than inferring success from the submitted SQL text.
- Tests must use a real PostgreSQL driver to assert parent IDs, query counts,
  transaction outcomes, SQL metadata, failures and absence of bind/result data.
  In-memory kernel mocks alone cannot establish driver instrumentation coverage.

Provider destination denials and DNS failures retain bounded
`provider_endpoint_forbidden` / `provider_endpoint_unavailable` classifications
in `model.complete` (including Skill learning) and logs. Provider credentials,
raw resolver errors, submitted bodies and rejected URLs are never captured,
even with RPC content capture enabled. The real HTTP/TLS and PostgreSQL component
checks cover these decisions and connection cleanup.

## Verification And Remaining Limits

Service-owned tests specify exact parent IDs, concurrent request isolation,
complete RPC values, HTTP/stream non-capture, protocol failures, stream EOF,
close/cancellation and disabled behavior. Export-disabled HTTP boundaries keep
valid incoming W3C context and propagate it without capturing payloads or baggage.

The SDK owns malformed/unknown wire requests before application dispatch,
HTTP size enforcement, protocol parsing, streaming queues and notification
serialization. The HTTP telemetry adapter only joins request context across the
queue; it does not validate or implement ACP semantics. Real official-SDK tests
prove that initialize, new Session and prompt belong to their own POST traces.
Pre-dispatch protocol failures still require their own transport evidence.

Other explicit limits: content is recorded once at the receiving RPC boundary,
not at model/Tool/Internal decorators. Non-RPC error metadata retains stable
summaries and typed causes; RPC failure objects follow the content switch.
Resource version currently
matches package version `0.1.0`; deployment environment/image identity should be
supplied using the standard OTEL resource configuration. Auto-follow redirects
inside native fetch are not individually visible; the existing client-MCP manual
redirect loop does create one CLIENT per send. No claim of complete redirect,
pre-dispatch protocol-error or streaming pressure coverage is made.

No per-token/chunk spans or content preview is implemented. Recovery retains
existing counters and business telemetry coupling pending a separately scoped
runner refactor. Cross-restart Links require a durable source context contract;
the service adds no trace fields to business storage. Exporter failure, queue
saturation, shutdown pressure and deployed Jaeger behavior are verified by
integration profiles, not inferred from unit-test span counts.

Explicit `AbortError`/`ABORT_ERR` cancellation is an `antnest.cancelled` event
with a phase and cancellation type, not an `antnest.error` event. This includes
MCP SDK response-stream cleanup. The outcome remains visible as `cancelled`;
it does not erase an earlier HTTP error. Timeouts, send/read failures and invalid
model responses still retain error status and typed error events.

## Span Names And Integration Expectations

- There is no `acp.http` operation (the HTTP SERVER span covers the actual
  request lifetime) and no `agent_controller.status` operation (readiness does
  not call Controller).
- Existing meaningful INTERNAL names remain, including `agent.run`,
  `acp.session.*`, `model.complete`, `mcp.tools.*`,
  `mcp.runtime.info`, `acp.permission.wait` and `postgres.ready`.
- `acp.permission.wait` includes the permission request's persistence boundary.
  `agent.run` inherits the submitting ACP request context, including asynchronous
  execution owned by RunSupervisor. Ending a request span does not cancel the Run
  or prevent later child spans. No business-name special case may reset context.
  WebSocket messages receive W3C context through ACP `params._meta` from Gateway;
  each Gateway message is a bounded root linked to the long-lived connection.
  Thus a prompt, its model calls and Runtime tools form one trace without waiting
  for the browser connection to close. Direct clients without message context
  still create an ACP message root linked to their connection.
- `acp.session.prompt` covers admission (`acceptPrompt`), not Run completion.
  The protocol boundary `acp session/prompt` waits for completion and output
  flush on v1, but returns the acknowledgement on v2. `acp.session.output`
  covers a durable snapshot read, not notification delivery. The output pump
  inherits the trigger that starts its drain, including reads from coalesced
  invalidations; this is causal context, not temporal containment. Because these
  asynchronous spans can start after their trigger ends, small Node/Go timestamp
  differences can produce Jaeger clock-skew warnings without a broken parent.
- These application spans expose `antnest.operation.phase=admit`
  for `acp.session.prompt` and `antnest.operation.phase=read` for
  `acp.session.output`. Gateway message spans expose `relay` and `forward`;
  the forwarding span is a PRODUCER because it ends after the WebSocket send.
  These low-cardinality labels clarify their existing lifetimes without changing
  request completion, Run ownership, context propagation or clock-skew evidence.
- HTTP names are `HTTP METHOD /status`, `HTTP METHOD /v1/acp`, `HTTP METHOD /v2/acp`,
  `HTTP METHOD unmatched`; CLIENT names are `HTTP METHOD model`,
  `HTTP METHOD antnest-runtime`, `HTTP METHOD mcp`. ACP dispatcher names are
  `acp initialize` and `acp session/...` for registered methods.
- Existing identifier attributes are retained. Added aliases are
  `request.id -> antnest.request.id`, `agent.id -> antnest.agent.id`,
  `session.id -> antnest.session.id`, `run.id -> antnest.run.id`,
  `execution.revision -> antnest.execution.revision`.
  Runtime revisions, model profile IDs, context counts and terminal outcomes
  are additional attributes. `error.code` remains for known errors alongside
  the string `antnest.error.code`.
- Readiness assertions must expect private PostgreSQL only, zero Controller
  status calls and a SERVER span even for a successful traced health request.
- PostgreSQL tracing uses the pinned official `@opentelemetry/instrumentation-pg`
  dependency; other boundaries use existing SDK exports.
- Stage 2 assertions reject Controller/Identity calls in execution traces and
  require model requests, Runtime MCP calls and ACP-owned persistence under the
  descendant `agent.run`. Identity validation may precede ACP at Gateway; it must
  never be a dependency beneath Run execution. Configuration publication and lifecycle settlement flow
  from Controller to ACP, separately from the prompt execution path. The client
  exports actual source spans; fabricated parent IDs are not accepted.
- The [integration scenarios](execution-boundary-e2e.md) use the development RPC
  capture mode and synthetic Provider credentials. Secret checks inspect captured
  event values as well as metadata. A process killed mid-Run cannot flush its
  complete trace; interruption is proved by retained execution audit and absence
  of replay, not by pretending the interrupted span tree is complete.

Service and integration checks, run serially from the repository root:

```sh
npm --prefix services/agent-acp-service run format:check
npm --prefix services/agent-acp-service run typecheck
npm --prefix services/agent-acp-service run lint
npm --prefix services/agent-acp-service test
node --test tests/e2e/agent-acp-service/stage2-evidence.test.mjs
make test-agent-acp-postgres
make fmt-check
make lint
```

The Stage 2 execution oracle checks actual `INSERT`/`UPDATE` CLIENT spans with
matching operation titles and native query metadata; fixtures reject reads,
wrapper spans, missing metadata and legacy lowercase operation names. Raw trace
responses from `make e2e-stage2` are kept under
`artifacts/verification/stage2-boundary/<project>/traces/` with private permissions.
