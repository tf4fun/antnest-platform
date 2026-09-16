# Antnest Runtime Observability

## Outputs

After privileged bootstrap, Runtime emits:

1. newline-delimited JSON logs on stderr;
2. local OpenTelemetry trace context for log correlation;
3. optional trace export through OTLP HTTP/protobuf.

Telemetry is diagnostic, never an audit ledger. Export failure does not change
status, MCP tool results, or network policy.

Runtime Controller injects optional `ANTNEST_RUNTIME_IMAGE_REFERENCE` (the original
configured name/tag/digest) and `ANTNEST_RUNTIME_IMAGE_ID` (the Docker image ID
selected for this build). Runtime captures them once at startup and attaches
`antnest.runtime.image.reference` and `antnest.runtime.image.id` to its trace
resource and initialization log. Every exported Runtime span therefore identifies
its build without per-handler instrumentation. Missing values remain unknown;
Runtime does not inspect Docker or resolve tags. Neither value is a metric
dimension, RuntimeSpec field, MCP tool, or model-context instruction. The durable
audit record belongs to Runtime Controller's operation, not the container logs.

Tool progress is caller-facing output, not telemetry. Preview frames stay on
the Executor pipe / MCP response and create no per-chunk spans or audit rows.
Delivery failure emits a bounded `progress_delivery_failed` or
`progress_delivery_timeout` warning inside the existing request trace, without
tokens or message content. Slow subscribers do not change the authoritative
Tool outcome. See [Tool progress](tool-progress.md) for delivery bounds.

File before/after observations are MCP result metadata, not telemetry. They do
not add spans or log fields. The existing MCP result can be captured as an RPC
response when content capture is explicitly enabled; it is never copied to logs. See [File observations](file-observations.md).

Request, tool, and Executor records carry:

- `service.name=antnest-runtime`;
- `antnest.agent.id`;
- `antnest.runtime.generation`;
- `trace_id` and `span_id` even when trace export is disabled.

Warning/error completion events repeat this identity explicitly. They remain
correlatable when stderr filtering suppresses the informational span records
that normally provide the same fields.

Lifecycle records emitted outside a request span have empty trace identifiers.
Disabling OTLP disables export only; it does not disable local trace-context
generation or inbound W3C parent propagation.

There is no Runtime instance ID or boot ID in the domain model. A deployment may
add Docker container ID, Kubernetes Pod UID, or `service.instance.id` through
standard resource attributes for local operations.

## Span Model

| Span | Meaning |
| --- | --- |
| `runtime.process` | One Runtime process lifetime, from telemetry initialization through service shutdown |
| `runtime.network` | One UDP-tunnel network session from start through shutdown or fatal error |
| `HTTP GET /status`, `HTTP POST /mcp`, etc. | One normalized HTTP SERVER request, including upstream-context health checks |
| `runtime.mcp.tool` | One `bash`, `read`, `write`, or `edit` call |
| `runtime.executor` | One non-privileged tool subprocess from spawn through complete reaping |
| `runtime.mcp.stdio` | One managed stdio tool CLIENT call, including its protocol result |

HTTP path labels are normalized to `/status`, `/mcp`, or `unmatched`; arbitrary
request paths are never exported. HTTP status and transport outcome describe
transport completion; protocol failure also marks the shared SERVER span as
failed without overwriting the actual HTTP status.
One official SDK `ServerHandler` decorator emits a normalized `runtime.mcp.operation`
span for initialize, discovery, tool listing, tool dispatch, resource listing,
and resource reads, including MCP
outcome and stable JSON-RPC error code. A tool execution span begins only after
the SDK has decoded its typed parameters. Handler-returned MCP/JSON-RPC errors
encoded in a successful HTTP response remain protocol errors without inventing
an HTTP 500. Rejections made inside the SDK before handler dispatch do not create
a tool execution or handler span; they currently retain HTTP transport evidence
only. The SDK, not the decorator, owns protocol dispatch.

`antnest://runtime/info` adds an `info` Executor span beneath `resources/read`;
it is not counted as a model Tool invocation. The complete information Resource is captured only as a discrete RPC result when
the shared content switch is enabled, never as an extra snapshot or log record.

Every HTTP request also emits one structured completion event after its body
reaches end-of-stream, fails, or is dropped by a disconnected client. The event
uses a normalized route, method, status code, outcome, and bounded error type.
It is present when OTLP is disabled, so stderr logs remain a complete
request-level diagnostic channel.

### MCP Response Close Classification

An MCP handler finishing successfully and an HTTP stream reaching EOF are
different observations. The ACP official SDK client closes its connection after
receiving the result; that can drop the SSE response before Runtime observes EOF.
For a successful HTTP status **and an observed successful MCP handler result**,
this drop records `antnest.cancelled`, `http.transport.outcome=canceled` and
`http.transport.error.type=client_disconnected`. It does not add `antnest.error`
or a span-level `error.type`. HTTP completion logs and cancellation metrics remain.
The handler observation does not prove that the client received the result;
transport completion is never rewritten as success.

A drop without observed MCP success retains its disconnect error diagnostic.
Body errors and non-success HTTP responses retain error diagnostics; HTTP 5xx
remains an error even when its body is dropped. MCP protocol failures retain
their original error type and failed HTTP SERVER span, rather than being
overwritten by a later `client_disconnected`. No body parsing, response buffering,
retry, execution policy or strict Trace gate change is involved.

The regression in `mcp_observability_tests.rs` exercises successful EOF/early
close, unfinished early close, body failure, HTTP 400/500 and protocol failure.
Its Linux HTTP component test uses the real SDK handler and middleware, holds
the response open after its first SSE frame, receives the successful result,
and closes the client before EOF. This deterministically checks the cancellation
event and successful protocol observation without an error event or error status.
The isolated Docker suite additionally uses ACP's pinned official JavaScript SDK
against a real Runtime and exports success/failure traces to an isolated Jaeger.
This service-owned evidence does not replace full Gateway/ACP/browser acceptance.

The historical trace `970c510b1b22df1e4da962c4c32c0d30` returned HTTP 404 from
the development Jaeger on 2026-09-16. The earlier recorded diagnostic is retained;
it cannot be retrospectively reclassified from the expired trace. The current
fix addresses the reproducible successful-handler/response-close case, not every
disconnect and not the separately deferred clock-skew warnings.

Verification on 2026-09-16 for this service-owned follow-up:

- The seven-case regression first failed on the existing successful-disconnect
  error classification, then passed after the fix.
- Linux formatting, Clippy with warnings denied, 143 unit/contract/component
  tests, one CLI test, one official SDK fixture test and release build passed.
- All 10 isolated Docker E2E scenarios passed. The JavaScript SDK check observed
  nine successful MCP operations with no error spans/events; the deliberate
  missing-file call retained both failed operation and HTTP spans. Those live
  successful responses all reached EOF; the controlled HTTP component test above
  supplies the before-EOF close evidence, not the live SDK run.
- The final build and E2E image Runtime binaries have identical SHA-256
  `149fc758262cf0c811bac604ca33df67c8f883c995d50f421b55918445675834`.
  Test containers/networks were removed. Existing development containers were
  not replaced, and the full browser profile was not rerun.

Ignored local logs are `.cache/runtime-http-close-build.log` and
`.cache/runtime-http-close-e2e.log`; they are not guaranteed in a fresh clone.
The tests are tracked. The subsequent
[2026-09-16 deployment and integration](../../../docs/runtime-http-close-integration.md)
replaced the development Runtime and verified real conversations, retained
workspace and a deliberate tool failure. Chat behavior and topology passed;
strict clock-warning failures remain unchanged. The earlier non-deployment
statement above describes the service-gate batch only.

Tool and Executor spans record tool name, outcome, stable error code,
duration, child PID, numeric exit status, deadline, Agent ID, and generation.
HTTP, Executor, managed stdio CLIENT spans and completion logs are metadata-only.
Discrete inbound MCP requests/results use the shared RPC capture switch below.
No packet or progress notification contents are captured.

The Runtime-to-Egress packet path does not participate in distributed tracing.
Runtime records one bounded network-session span and start/completion events,
including transport, duration, outcome, and stable fatal error code. It does not
create packet spans and never records packet data. Egress control RPCs have their
own request spans; those spans never follow packet traffic.
Runtime exports OTLP metrics for normalized HTTP routes, MCP operations, tool
calls, Executor calls, and aggregate network counters. Every 30 seconds it also
emits the network aggregate as one local structured log. Metrics use bounded
operation, outcome, and stable error-code labels; Agent IDs, generations,
paths, packet addresses, flow keys, and Agent-selected content are excluded.

Runtime emits no reverse-session, heartbeat, or queue spans. Single-flight is a
local invariant: a rejected concurrent call is recorded as `runtime_busy`, not
as queued work.

## Trace Propagation

The official MCP SDK owns MCP request metadata. Runtime extracts W3C
`traceparent` and `tracestate` from HTTP headers. Runtime does not propagate
`baggage`. Trace propagation must not be implemented as a second custom MCP
envelope.

The Agent system owns the upstream tool-call span. Runtime's tool span is its
server-side descendant through HTTP and MCP dispatch. Packet-level events are
not traced individually.

## Boundary Diagnostic Contract

This service implements the service-owned portion of
[the platform contract](../../../docs/observability-contract.md). Linux unit,
HTTP component, CLI, Clippy and build results are recorded in the
[platform rollout](../../../docs/observability-rollout.md). A deployed Agent's
complete Jaeger chain remains a separate business-scenario acceptance step.

The single deployment switch `ANTNEST_TELEMETRY_CAPTURE_RPC_CONTENT=false` is
read at startup, before environment sanitization. Set it to `true` to capture
complete decoded MCP request/result JSON, including tool arguments, results,
metadata and runtime information. These may contain credentials or private files;
enable only for authorized diagnostic collection. No field registry, redaction
projection, application payload cap or custom event budget is maintained.
Standard OTel SDK limits and exporter behavior still apply.

The official SDK ServerHandler decorator records payloads once on its discrete
RPC operation span. HTTP middleware owns the SERVER span through EOF/error/drop
without reading ahead or capturing headers/bodies. Executor and managed MCP
CLIENT spans retain timing, outcomes and error causes, without duplicating RPC
content. Notifications, progress and streamed transport frames are never captured.
Turning capture off does not serialize values or emit omission events.

MCP `isError` and JSON-RPC failures mark the operation and parent HTTP span as
failed without changing the real HTTP status. The SDK owns protocol dispatch;
rejections before handler dispatch retain HTTP evidence only. No retry, execution
policy, wire envelope or lifecycle change is introduced by telemetry.

Managed CLIENT spans inject W3C context through the official SDK request metadata.
Child-side tracing remains the managed program's responsibility. Readiness checks
initialized local state, never downstream platform services. Packet forwarding is
outside distributed tracing. Deployment Jaeger checks remain a separate acceptance
step from local tests.

## OTLP Configuration

Runtime supports OTLP HTTP/protobuf from the root Supervisor to a private
Collector reachable through the platform main routing table:

```dotenv
OTEL_TRACES_EXPORTER=otlp
OTEL_METRICS_EXPORTER=otlp
OTEL_EXPORTER_OTLP_PROTOCOL=http/protobuf
OTEL_EXPORTER_OTLP_ENDPOINT=http://192.0.2.10:4318
OTEL_RESOURCE_ATTRIBUTES=deployment.environment.name=development
RUST_LOG=info
```

`OTEL_SDK_DISABLED=true` or `OTEL_TRACES_EXPORTER=none` disables export while
retaining local trace IDs for structured-log correlation.
`OTEL_METRICS_EXPORTER=none` disables only metric export. Metrics-specific
endpoint and protocol variables take precedence over the common OTLP values in
the same way as their trace equivalents.
The Collector endpoint must use a literal private IPv4 address. Runtime rejects
hostnames, IPv6, and public destinations, then configures the exporter with that
exact validated endpoint. This removes DNS time-of-check/time-of-use ambiguity.
A rejected endpoint falls back to structured stderr logs; root-owned telemetry
never enters the Agent Egress tunnel.

`OTEL_EXPORTER_OTLP_TRACES_ENDPOINT` takes precedence over
`OTEL_EXPORTER_OTLP_ENDPOINT`; `OTEL_EXPORTER_OTLP_TRACES_PROTOCOL` takes
precedence over `OTEL_EXPORTER_OTLP_PROTOCOL`. The only supported protocol is
`http/protobuf`. Setting `OTEL_TRACES_EXPORTER=otlp` without an endpoint uses
`http://127.0.0.1:4318`. `RUST_LOG` controls stderr log filtering only. Runtime's
bounded `runtime.*` spans remain enabled for local trace-context generation and
optional OTLP export; deployment-level trace sampling belongs to the Collector.
The stderr layer accepts records only from the `antnest_runtime` crate target;
`RUST_LOG` cannot enable dependency logs that may contain unbounded transport
details.

Loopback and same-platform collectors are valid. Public collectors must be
reached through a platform-local Collector rather than directly from Runtime.

Telemetry configuration warnings use stable `error.type` values:

| Code | Meaning |
| --- | --- |
| `invalid_log_filter` | `RUST_LOG` was rejected and the default filter is active |
| `unsupported_trace_exporter` | `OTEL_TRACES_EXPORTER` is neither `otlp` nor `none` |
| `unsupported_metrics_exporter` | `OTEL_METRICS_EXPORTER` is neither `otlp` nor `none` |
| `unsupported_otlp_protocol` | selected OTLP protocol is not `http/protobuf` |
| `invalid_otlp_trace_destination` | trace endpoint is malformed or outside the direct platform network |
| `invalid_otlp_metrics_destination` | metrics endpoint is malformed or outside the direct platform network |
| `otlp_trace_exporter_initialization_failed` | trace exporter construction failed after validation |
| `otlp_metrics_exporter_initialization_failed` | metrics exporter construction failed after validation |

## Shutdown

SIGTERM and SIGINT close Actor admission, stop accepting new HTTP requests,
cancel the active Executor, terminate its process group and reap that Executor, stop
the network task, and then flush telemetry. HTTP, network, and Actor drain run
concurrently and are observed independently against the same absolute
eight-second deadline; telemetry flush has its own five-second bound. The worst
graceful-shutdown path is therefore bounded to thirteen seconds. A completed
component or containment failure is retained even when another component times
out. Background jobs are reclaimed by container termination, not by each tool
completion. During service operation, PID 1 only reaps exited orphans. Reaper
failure is a fatal `orphan_reaper_failed` lifecycle event, not a tool result.
Completed failures take precedence over timeout diagnostics when choosing
the primary shutdown error.

Runtime emits structured lifecycle records for shutdown requested, service
stopped, and OTLP flush failure. `antnest.runtime.generation` uses one string
type in logs, spans, and resource attributes.

Bootstrap failures carry a stable stage and error type. Once RuntimeSpec has
been parsed they also carry Agent ID and generation. Runtime service failures
preserve the primary component error even if another component subsequently
fails or times out while stopping.

Before the tracing subscriber exists, each successful bootstrap boundary emits
one JSON stderr event named `bootstrap_stage_completed`. These events contain
only the stable stage and, after RuntimeSpec parsing, Agent ID and generation;
the spec document, filesystem paths, addresses, and environment values are not
logged.

### Process lifecycle error catalogue

These are the exhaustive stable `error.type` values that may terminate the
Runtime process. Tool-call errors and non-fatal telemetry configuration or
flush diagnostics are separate contracts and are not part of this catalogue.

| Phase | Stable error types |
| --- | --- |
| Bootstrap | `bootstrap_evidence_failed`, `entry_failed`, `environment_verification_failed`, `executor_initialization_failed`, `invalid_config`, `named_roots_failed`, `network_bootstrap_failed`, `network_verification_failed`, `pre_executor_verification_failed`, `root_verification_failed`, `unsupported_platform`, `workspace_initialization_failed`, `workspace_ownership_failed` |
| Runtime | `child_process_containment_unproven`, `executor_probe_failed`, `http_bind_failed`, `http_service_failed`, `local_network_failed`, `managed_mcp_start_failed`, `managed_mcp_service_failed`, `managed_mcp_stop_failed`, `network_transport_failed`, `orphan_reaper_failed`, `shutdown_timeout`, `signal_listener_failed`, `telemetry_initialization_failed`, `unexpected_exit` |

Managed stdio calls emit `runtime.mcp.tool` spans beneath the HTTP and MCP
operation spans, using the bounded metric label `managed`. Validated exposed
tool names may be span/log attributes, not metric dimensions. Lifecycle events
`managed_mcp_started` and `managed_mcp_stopped` identify the configured server,
without serializing executable arguments, environment values, tool content or
child stderr. Child MCP programs are not required to export OTLP themselves.

The same lists are machine-readable in
`contracts/runtime/contract.json`; contract tests reject drift.

Stable bootstrap stages are `entry`, `runtime_spec`,
`environment_sanitized`, `network_ready`, `filesystem`, `roots_ready`,
`pre_tokio`, `executor`, and `platform`. They are represented by the closed
`BootstrapStage` type and mirrored by `bootstrap_stages` in the shared contract.
