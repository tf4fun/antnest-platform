# ACP Observability

This service implements a scoped portion of the platform
[observability contract](../../../docs/observability-contract.md) at transport,
SDK dispatch and existing application/adapter boundaries. Acceptance is coordinator-owned; current results are tracked in
[the simplification checklist](../../../docs/observability-simplification.md).

## Implementation Contract

- One HTTP SERVER span covers response finish, disconnect and upgrade. Extract
  W3C trace context before starting it; never propagate inbound baggage.
- A common fetch wrapper creates CLIENT before injection and ends at response
  EOF, cancellation or read failure. Model and Runtime MCP use it; ordinary
  execution no longer calls Controller.
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

## Verification And Remaining Limits

Service-owned tests specify exact parent IDs, concurrent request isolation,
complete RPC values, HTTP/stream non-capture, protocol failures, stream EOF,
close/cancellation and disabled behavior. Export-disabled HTTP boundaries keep
valid incoming W3C context and propagate it without capturing payloads or baggage.
Final serial admission results are recorded in the
[platform rollout](../../../docs/observability-rollout.md).

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
this change adds no trace fields to business storage. Exporter failure, queue
saturation, shutdown pressure and deployed Jaeger acceptance remain coordinator
profiles, not inferred from unit-test span counts.

## Coordinator Integration

- Removed operations: `acp.http` (replaced by the actual HTTP SERVER lifetime)
  and `agent_controller.status` (readiness no longer calls Controller).
- Existing meaningful INTERNAL names remain, including `agent.run`,
  `acp.session.*`, `model.complete`, `mcp.tools.*`,
  `mcp.runtime.info`, `acp.permission.wait` and `postgres.ready`.
- `acp.permission.wait` now includes the existing permission request's
  persistence boundary. `agent.run` is a bounded root with a source Link, not
  a long-lived child of the accepted ACP request. Root trace scripts expecting
  the old ancestry must follow Links and retained Run/Session IDs.
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
- No package/dependency/lock changes are needed; tests use existing SDK exports.
- Stage 2 assertions reject Controller/Identity calls in execution traces and
  require model requests, Runtime MCP calls and ACP-owned persistence under the
  linked `agent.run`. Configuration publication and lifecycle settlement flow
  from Controller to ACP, separately from the prompt execution path. The client
  exports actual source spans; fabricated parent IDs are not accepted.
- The [integration scenarios](execution-boundary-e2e.md) use the development RPC
  capture mode and synthetic Provider credentials. Secret checks inspect captured
  event values as well as metadata. A process killed mid-Run cannot flush its
  complete trace; interruption is proved by retained execution audit and absence
  of replay, not by pretending the interrupted span tree is complete.

Service and integration checks, executed serially:

```sh
npm --prefix services/agent-acp-service run format
npm --prefix services/agent-acp-service run typecheck
npm --prefix services/agent-acp-service run lint
npm --prefix services/agent-acp-service test
node --test services/agent-acp-service/scripts/stage2-evidence.test.mjs
make test-agent-acp-postgres
make fmt-check
make lint
```

Run the applicable repository architecture/documentation gates and root
observability/Jaeger profiles after integrating the changed span expectations.

Admission results and integration status are recorded in the platform
[service rollout](../../../docs/observability-rollout.md).
