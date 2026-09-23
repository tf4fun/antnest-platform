# ACP asynchronous timing and completion review

Reviewed: 2026-09-23. Scope: Gateway WebSocket forwarding, ACP admission,
Run execution and terminal persistence, output refresh, and v1/v2 responses.
This is code review, saved-Trace analysis and focused component regression,
not a fresh Docker deployment acceptance.

## Findings

**No early business completion or early Agent-slot release was found in the
reviewed paths.** The previous conversational diagnosis incorrectly treated
warning-bearing descendants as warning sources, and asynchronous children
outliving admission as proof of faulty business order. Neither inference is
supported by the complete evidence.

Two observability issues remain for their owning delivery batches:

1. **Gateway's forwarding metadata describes request/response, but its span
   measures only sending.** `RelayACPMessage` explicitly observes forwarding,
   creates a CLIENT named `acp session/prompt`, and ends when `send()` returns.
   The reviewed samples last 47–66 microseconds. The official
   [SpanKind definition](https://opentelemetry.io/docs/specs/otel/trace/api/#spankind)
   assigns CLIENT request/response semantics and PRODUCER deferred-initiation
   semantics. A Gateway batch should define this forwarding contract and its
   tests, followed by downstream integration. Making the relay wait for remote
   completion just to enclose its trace would change business behavior.
2. **ACP names and implicit refresh context obscure actual boundaries.**
   `acp.session.prompt` measures admission, while `acp session/prompt` measures
   protocol handling. `acp.session.output` measures a snapshot read, not
   delivery. The output pump inherits the context that starts a drain; another
   invalidation during that drain only marks it dirty. Later reads can retain
   the first trigger's context after its Tool/Run ends. This expresses causality,
   not synchronous containment or exclusive ownership of every merged refresh.
   Names/phase attributes and an explicit correlation contract need an ACP-owned
   follow-up; this review does not alter parent IDs to suppress diagnostics.

## Actual warning origins

The ten saved raw Traces in
`artifacts/verification/c4-browser-2026-09-21T13-06-00-954Z/` contain four
warning-bearing Traces and 388 warning occurrences. A read-only walk following
the host-key and propagation rules in the pinned
[Jaeger 2.20.0 adjuster](https://github.com/jaegertracing/jaeger/blob/v2.20.0/cmd/jaeger/internal/extension/jaegerquery/internal/adjuster/clockskew.go)
matches warning presence on every span. All four sources are Gateway-to-ACP
edges; their warnings propagate through same-host ACP descendants.

| Browser operation | Gateway send duration | ACP start precedes Gateway start | Repeated warnings |
| --- | ---: | ---: | ---: |
| approve | 59 µs | 137.336 µs | 159 |
| after-cancel | 66 µs | 133.038 µs | 83 |
| hold-close | 47 µs | 112.561 µs | 63 |
| mobile | 56 µs | 289.858 µs | 83 |

The sub-microsecond digits come from the original warning text. JSON API
timestamps/durations have integer-microsecond precision, so the independent
calculation differs by less than one microsecond. Raw evidence is unchanged;
hashes, source span IDs and counters are saved in
`artifacts/verification/acp-async-review-20260923/trace-warning-origins.json`.

These traces also have 90 ACP edges whose child ends after its parent: 61 by
less than one millisecond and 29 by more. None of these same-host edges causes
a new skew calculation. In particular, an admission lasting 14.614 ms and its
Run lasting 358.057 ms represent separate lifetimes, not early Run completion.

ACP start timestamps lie on integer milliseconds. The JS SDK's default start
anchor can explain a sub-millisecond apparent reversal against Gateway's finer
timestamps; this does not prove physical host offsets are zero or explain every
warning in the separate Stage 3 final-regression report.

## Business order and validation

| Boundary | Actual wait |
| --- | --- |
| Admission | Session checks, durable intent and accepted snapshot; returns a separate completion promise |
| Agent ownership | Acquired before admission; retained through execution and terminal persistence |
| Run completion | Execution, then `executions.finish`; write failure rejects completion and requests fail-stop recovery |
| Model/Tool output | Event persistence precedes publish hints; buffered output/progress drains in `finally` |
| v1 response | Run completion, then invalidation and final output flush |
| v2 response | Reception acknowledgement; a separate observer waits for completion and flushes output |
| Output invalidation | Best-effort wake-up of a durable snapshot reader; every observer need not finish before the Run |

Primary code: [RunSupervisor](../services/agent-acp-service/src/application/run-supervisor.ts),
[RunExecutor](../services/agent-acp-service/src/application/run-executor.ts),
[v1](../services/agent-acp-service/src/transport/acp/v1/agent.ts),
[v2](../services/agent-acp-service/src/transport/acp/v2/agent.ts), and
[output pump](../services/agent-acp-service/src/transport/acp/session-output.ts).
OpenTelemetry defines parent/child relationships as causal, without universal
temporal containment. ACP's existing contract intentionally retains this
causal trace after admission/request completion.

The old `boundaries.test.ts` ancestry test bypasses
`InstrumentedAcpApplication` and awaits completion for both protocol versions.
The old ownership unit test blocks a stub executor. These tests alone do not
cover real admission/v2 lifetimes or the terminal-persistence barrier.

The new [completion-order test](../tests/integration/agent-acp-service/telemetry/run-completion-order.test.ts)
combines real SDK v1/v2 handlers, `AcpApplication`, both instrumented wrappers,
`RunSupervisor`, `RunExecutor`, `SessionOutputStreams` and the OTel context
manager. Repository boundaries use explicit promise barriers. After admission
ends, blocked message/terminal writes keep completion, local cancellation wait and
Agent-slot release pending. v1 cannot return its final response; v2 may
acknowledge without claiming idle. Assertions use completion events, avoiding
sub-millisecond timestamp comparisons.

Validation: 42 protocol/component tests, 109 related unit tests and TypeScript
type checking passed. No service behavior changed and no new PostgreSQL,
Docker or browser acceptance is claimed. The review rejects the specific
early-completion hypothesis for the tested paths; forwarding metadata, names
and merged-refresh correlation remain observability work.

## Compatible phase-label follow-up

Gateway now labels the existing message SERVER span `relay` and its short
outbound CLIENT span `forward` through `antnest.operation.phase`. ACP labels
`acp.session.prompt` as `admit` and `acp.session.output` as `read`. These bounded,
low-cardinality values distinguish a WebSocket write, Run admission and durable
snapshot read in Jaeger without changing span names, kinds, ancestry, protocol
frames or business waits. A new v1/v2 component assertion confirms ACP's phase
values on exported spans; Gateway's propagation test confirms its phase values
and exact downstream parent.

Gateway's full Go suite, ACP's 810 unit tests, typecheck and lint, and the
focused v1/v2 integration cases passed. A fresh Docker/Jaeger trace was not
captured in this batch. The Gateway CLIENT kind still carries broader
request/response semantics than its measured write, and coalesced output
refreshes still inherit their first trigger's context. Those are separate
contract changes, not implied fixes from the phase labels. The four saved
clock-skew warning sources and strict historical results remain unchanged.

## Gateway forwarding kind follow-up

The Gateway WebSocket send span now uses `PRODUCER`, retaining the same
`acp <method>` name, `forward` phase, exact propagated parent ID and send-only
lifetime. Ordinary HTTP reverse-proxy spans remain `CLIENT`. The
[OpenTelemetry SpanKind contract](https://opentelemetry.io/docs/specs/otel/trace/api/#spankind)
defines `CLIENT` for a call awaiting a response and `PRODUCER` for initiating
work that may finish before its receiver. Gateway's complete Go suite and 414
affected root E2E fixture checks passed, including separate WebSocket and HTTP
paths.

An isolated Stage 2 Docker run passed three Controller recovery integration
tests, 245 ACP PostgreSQL tests and its reported business scenarios, then
returned nonzero during strict Trace verification. Its saved Jaeger evidence
contains 58 traces; four Gateway spans have `antnest.operation.phase=forward`,
all four export as `PRODUCER` and each directly parents one ACP receiving span.
The saved traces still contain clock-skew warnings (43 warning-bearing traces),
so changing kind did not repair timestamp ordering. The disposable Compose
project was cleaned up. This is real exporter/topology evidence, not a claim
that the strict Stage 2 gate passed.
