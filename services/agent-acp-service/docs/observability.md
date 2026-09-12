# ACP Observability

This service implements a scoped portion of the platform
[observability contract](../../../docs/observability-contract.md) at transport,
SDK dispatch and existing application/adapter boundaries. Acceptance is coordinator-owned; current results are tracked in
[the simplification checklist](../../../docs/observability-simplification.md).

## Implementation Contract

- One HTTP SERVER span covers response finish, disconnect and upgrade. Extract
  W3C trace context before starting it; never propagate inbound baggage.
- A common fetch wrapper creates CLIENT before injection and ends at response
  EOF, cancellation or read failure. Controller, model and Runtime MCP use it.
  Adapter operations are INTERNAL, not duplicate CLIENT spans.
- The ACP dispatcher records registered v1/v2 requests with their own context,
  complete decoded request/response values (when enabled) and protocol outcome. WebSocket requests
  without request metadata use connection Links, not a handshake parent.
- `ANTNEST_TELEMETRY_CAPTURE_RPC_CONTENT=false` is the single switch. When true,
  discrete ACP RPC parameters/results are captured on the receiving dispatcher
  span as `antnest.request` / `antnest.response`, each with one
  `antnest.payload.json` attribute. New and nested fields require no registration.
  Credential-bearing parameters, prompts and returned content are included; this
  is an explicit development diagnostic choice, not a secure retention policy.
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
HTTP body parsing, streaming queues and notification serialization. A handler
dispatcher cannot observe every pre-dispatch rejection or reconstruct an HTTP
request context lost inside a persistent SDK queue. These SDK boundaries need
real-transport parent and failure validation; no private protocol fields or
second parser are introduced to claim coverage.

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
  `acp.session.*`, `agent_controller.*`, `model.complete`, `mcp.tools.*`,
  `mcp.runtime.info`, `acp.permission.wait` and `postgres.ready`.
- `acp.permission.wait` now includes the existing permission request's
  persistence boundary. `agent.run` is a bounded root with a source Link, not
  a long-lived child of the accepted ACP request. Root trace scripts expecting
  the old ancestry must follow Links and retained Run/Session IDs.
- HTTP names are `HTTP METHOD /status`, `HTTP METHOD /v1/acp`, `HTTP METHOD /v2/acp`,
  `HTTP METHOD unmatched`; CLIENT names are `HTTP METHOD agent-controller`, `HTTP METHOD model`,
  `HTTP METHOD antnest-runtime`, `HTTP METHOD mcp`. ACP dispatcher names are
  `acp initialize` and `acp session/...` for registered methods.
- Existing identifier attributes are retained. Added aliases are
  `request.id -> antnest.request.id`, `agent.id -> antnest.agent.id`,
  `session.id -> antnest.session.id`, `run.id -> antnest.run.id`,
  `admission.id -> antnest.admission.id`, and
  `execution.revision -> antnest.execution.revision`.
  An admission ID is not relabeled as a Controller lifecycle operation ID.
  Runtime revisions, model profile IDs, context counts and terminal outcomes
  are additional attributes. `error.code` remains for known errors alongside
  the string `antnest.error.code`.
- Readiness assertions must expect private PostgreSQL only, zero Controller
  status calls and a SERVER span even for a successful traced health request.
- No package/dependency/lock changes are needed; tests use existing SDK exports.
- Service-owned Stage 2 assertions now require one exact
  `INTERNAL agent_controller.* -> CLIENT HTTP POST agent-controller -> receiving SERVER`
  chain for each observed resolve/acquire/finish operation. Duplicate sends and
  bypassed/foreign parent IDs fail fixtures. Execution evidence discovers the
  linked `agent.run` trace and requires exactly one successful root linked to
  the exact ACP prompt. Cross-service Controller/Identity/Runtime selectors use
  the normalized HTTP names; fixtures retain exact parent and operation checks.
  The no-content default profile prohibits business payloads. When content capture
  is explicitly enabled, complete RPC events are allowed; HTTP/stream content is not.

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
