# Antnest Runtime Observability

## Outputs

After privileged bootstrap, Runtime emits:

1. newline-delimited JSON logs on stderr;
2. local OpenTelemetry trace context for log correlation;
3. optional trace export through OTLP HTTP/protobuf.

Telemetry is diagnostic, never an audit ledger. Export failure does not change
status, MCP tool results, or network policy.

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
| `runtime.http` | One `/status` or `/mcp` HTTP request |
| `runtime.mcp.tool` | One `bash`, `read`, `write`, or `edit` call |
| `runtime.executor` | One non-privileged tool subprocess from spawn through complete reaping |

HTTP path labels are normalized to `/status`, `/mcp`, or `unmatched`; arbitrary
request paths are never exported. HTTP spans describe transport completion only.
Official SDK handler hooks emit a separate normalized `runtime.mcp.operation`
span for initialize, discovery, tool listing, tool dispatch, resource listing,
and resource reads, including MCP
outcome and stable JSON-RPC error code. A tool execution span begins only after
the SDK has decoded its typed parameters. MCP/JSON-RPC errors encoded in a
successful HTTP response therefore remain errors at the MCP layer without being
misreported as HTTP failures or tool executions.

`antnest://runtime/info` adds an `info` Executor span beneath `resources/read`;
it is not counted as a model Tool invocation. Instruction text, Skill metadata,
and the serialized information Resource are excluded from logs and spans.

Every HTTP request also emits one structured completion event after its body
reaches end-of-stream, fails, or is dropped by a disconnected client. The event
uses a normalized route, method, status code, outcome, and bounded error type.
It is present when OTLP is disabled, so stderr logs remain a complete
request-level diagnostic channel.

Tool and Executor spans record only tool name, outcome, stable error code,
duration, child PID, exit classification, Agent ID, and generation. Relative
filesystem paths may appear in error logs, but
spans and logs must not record command text, environment values, file contents,
stdout/stderr, raw packets, DNS questions, prompts, or model messages.

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

The Agent system owns the parent tool-call span. Runtime's tool span is its
server-side child. Packet-level events are not traced individually.

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
