# Admin Console Observability

This service implements the platform [observability contract](../../../docs/observability-contract.md)
at its HTTP and existing BFF adapter boundaries. This document describes the
implementation scope, not completed coordinator or Jaeger acceptance.

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

## Pending Acceptance And Limits

Admission checks, race and HTTP component tests run serially. Final metrics and
Gateway-rooted Jaeger coverage are recorded in the
[platform rollout](../../../docs/observability-rollout.md), separately from the
remaining exporter/pressure checks below.

There are no Console-owned async lifecycle attempts; Controller owns their
Links and durable operation state. Console retains the operation IDs but does
not invent attempt spans. Per-SSE-message content, first-message timing,
pressure/load evidence, exporter queue/drop metrics and production retention or
tail sampling are not implemented here. Arbitrary error text and original Go
stacks cannot be safely reconstructed; unclassified causes retain type and a
fixed safe explanation. Optional Overview failures remain section-local; no
shadow use-case interfaces or tracing state machine are introduced.

Remaining implementation limits for coordinator follow-up: resource instance
identity and exporter-disabled fresh-root creation retain the previous SDK
setup behavior. Recovered optional Overview projection failures lack a separate
typed completion record. Not every existing encoding/stream error branch yet
retains its original cause. No exporter failure/queue pressure acceptance or
new WebSocket/long-stream stress evidence has been produced.

Root integration assertions must replace `HTTP GET GET /...` SERVER names with
`HTTP GET /...` (likewise POST/PUT), and `<target> <method>` CLIENT names with
`HTTP <method> <target>`. The old `rpc.system=http` and concrete `url.path` attributes
are removed; `server.address` is now hostname-only with separate `server.port`.
`antnest.peer.service` identifies the configured target. Readiness expects no
Identity or Controller children. No meaningful INTERNAL operation was renamed.
