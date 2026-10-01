# Admin Console Observability

This service implements the platform [observability contract](../../../docs/observability-contract.md)
at its HTTP and BFF adapter boundaries. This document describes what Console
traces and logs, what it deliberately does not capture, and its known limits.

## Boundary Contract

- One inbound SERVER span extracts W3C trace context; normalized route names do
  not repeat the HTTP method or contain resource IDs or queries.
- All Identity and Controller calls use one shared HTTP transport. It creates
  CLIENT before injecting context, and finishes at body EOF, close or failure.
  There are no additional target-specific CLIENT spans or tracing retries.
- `/status` represents completed local initialization and the stopping state.
  Console owns no storage and never probes Identity or Controller for readiness.
  Successful probes with upstream context retain their SERVER span.
- Existing response adapters return typed failures through a shared dispatcher.
  Original causes stay wrapped in Go errors. Safe classifications and bounded
  cause summaries, not arbitrary error text, enter correlated logs and traces.
- SSE remains incremental, cancellable and backpressured. Its bytes and terminal
  failures are observed; content is omitted, never accumulated into a JSON body.

## Content Policy

Console is an HTTP BFF, not an RPC content owner. It never records Header
values, HTTP bodies, SSE contents or payload omission events. The transport
counts only bytes already consumed by the application, without buffering or
pre-reading. There is no content-mode configuration, DTO capture projection,
custom body budget or header filtering framework.

RPC request/response content belongs to the receiving service's dispatcher,
controlled by the shared RPC-content boolean. Console does not duplicate it.
Browser DTO projection for authority/privacy remains normal product behavior;
it is independent of tracing and is not removed.

## Limits

There are no Console-owned async lifecycle attempts; Controller owns their
Links and durable operation state. Console retains the operation IDs but does
not invent attempt spans. Per-SSE-message content, first-message timing,
pressure/load measurement, exporter queue/drop metrics and production retention or
tail sampling are not implemented here. Arbitrary error text and original Go
stacks cannot be safely reconstructed; unclassified causes retain type and a
fixed safe explanation. Optional Overview failures remain section-local; no
shadow use-case interfaces or tracing state machine are introduced.

Further known limits: resource instance identity and exporter-disabled
fresh-root creation use the default SDK setup behavior. Recovered optional
Overview projection failures lack a separate typed completion record. Not every
encoding/stream error branch retains its original cause. Exporter failure,
queue pressure and long-stream stress behavior are not verified.

## Span Names And Attributes

SERVER spans are named `HTTP <method> /<route>` (for example `HTTP GET /...`),
and CLIENT spans `HTTP <method> <target>`. Spans carry no `rpc.system=http` or
concrete `url.path` attribute; `server.address` is hostname-only with a separate
`server.port`. `antnest.peer.service` identifies the configured target. A
readiness probe has no Identity or Controller child spans.
