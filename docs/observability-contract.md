# Cross-Service Observability And Instrumentation Contract

This document defines what every Antnest service records in traces, where
instrumentation is installed, and how RPC content capture is controlled.
Clients collect only basic data, single request/response RPC content capture is
switchable, and message streams never capture content.

## 1. Responsibilities

Traces verify real call relationships, latency, parameters and results, and the
location of failures. They are not a chat store or a business audit log.
Business code returns normal results or errors; instrumentation is installed at
HTTP, RPC, storage and executor boundaries and does not intrude on the domain
model. Observability does not add business interfaces, retries, state machines,
reliable event delivery or databases.

| Boundary | Captured |
| --- | --- |
| HTTP/static assets/proxies | Method, route, status, target, latency, error and parent-child relationship; no header values or bodies |
| Single request/response RPC | Basic record; when the switch is on, the existing parameter and result objects, without field filtering |
| Message streams (SSE/WebSocket/model output/notifications) | Basic connection, operation result, cancellation and error; content is never captured, accumulated or concatenated |
| Database/Executor | Existing operation boundary, correlation IDs, result and error; no additional reads for capture |
| Egress forwarding data plane | No per-packet or per-flow OTLP; aggregate metrics and control RPCs are retained |

RPCs are identified by the existing protocol adapters, not guessed from URLs or
JSON fields. For example, the Gateway login HTTP request records only basic
information, while the Identity `local_login` RPC may capture content.
Do not add both HTTP CLIENT/SERVER and RPC CLIENT/SERVER spans at the same
boundary; reuse the existing span. A request with its own protocol dispatcher
may use the existing operation span. A message notification does not become a
content capture point just because it is decoded into an object internally.
Ordinary HTTP proxies do not capture internal RPC payloads, so the same content
is not copied at every hop.

## 2. One Content Switch

```env
ANTNEST_TELEMETRY_CAPTURE_RPC_CONTENT=false
```

- RPC content is not captured by default. A controlled development instance may
  set it to `true` explicitly.
- When on, the entire existing RPC parameter and return value is serialized into
  `antnest.request` / `antnest.response` events.
- Events use `antnest.payload.json`, the protocol method and the direction. There
  is no DTO field allowlist, nested redaction rule or safe projection.
- Unknown new fields are not dropped by default, and there is no fixed 16 KiB
  limit, cumulative event byte budget or per-interface budget.
- When off, content is not serialized. Capture failures do not change business
  results. Network bodies are not read early, and streams are not buffered or
  aggregated.
- HTTP and streaming protocols are not affected by this switch and never capture
  content.
- The switch controls content only. Trace export, sampling, queues and SDK
  resource limits use standard OTel configuration.

"Complete" means fields are not trimmed by a business allowlist. It does not
promise to bypass the standard capacity limits of the SDK, transport or
receiver. JSON truncated by the SDK must not be treated as a complete record for
business replay. Configuration support in each language SDK follows the actual
SDK version; there is no custom remote configuration center or application-level
rate limiting framework.

Raw development content can contain passwords, tokens, Provider credentials and
business data. Jaeger must run on a controlled network; captured content must
not be copied into ordinary logs or committed to Git. Filtering, redaction,
sampling, storage capacity, retention and query permissions are governed
centrally on the collector and storage side using standard components.
Central processing does not mean that secrets never left the service, and it
cannot restore data that was never captured or was truncated at the source.

## 3. Basic Trace Structure

- Inbound requests extract the W3C context and then create a SERVER span;
  outbound requests create a CLIENT span first and then inject the context.
- Synchronous calls keep the real parent-child relationship. Independent retries
  or recoverable background attempts use bounded roots and Links. An ACP Run
  submitted by a request in the current process keeps the causal parent-child
  relationship in the same trace, as defined by the service contract; the end of
  admission or v2 request acknowledgement does not mean the Run is complete.
  Not every CHILD_OF relationship implies time containment.
- Names are `HTTP <METHOD> <route template>` and `HTTP <METHOD> <target>`, without
  query strings, resource instance IDs or bodies.
- Existing request/operation/Agent/session/run/revision IDs are retained. A trace
  ID never replaces a business idempotency key.
- Service identity uses the OTel Resource. Metrics do not create unbounded labels
  from content or user/Agent IDs.
- An HTTP CLIENT span ends when the response is fully read, closed or fails. A
  streaming request span must not end as soon as headers arrive.
- Wrappers preserve cancellation, backpressure, Flush, Hijack, bidirectional
  transfer and the original error. Observability must not change protocol results.
- An RPC error or MCP `isError` inside HTTP 200 is marked as a business failure at
  the protocol boundary, without faking an HTTP status.
- Disabling export does not stop context propagation. The standard SDK exports
  asynchronously in batches, and export failures must not change business results.

### ACP messages and asynchronous Runs

The Gateway WebSocket message root span covers only admission and forwarding,
with `antnest.operation.phase=relay`. Its outbound `PRODUCER` span ends after the
message is written to the connection and is marked
`antnest.operation.phase=forward`; it does not mean ACP has processed the request
or returned a response. That span's W3C context is the direct parent context of
the ACP inbound protocol span. The parent-child relationship expresses forwarding
causality and does not require remote processing to fall within the send
duration.

Ordinary HTTP request/response outbound calls still use `CLIENT`. ACP's
`acp.session.prompt` covers only Run admission and is marked
`antnest.operation.phase=admit`; `acp.session.output` covers only reading the
persisted output snapshot and is marked `antnest.operation.phase=read`. The
`execute` phase of `agent.run` is independent of admission. These markers only
describe existing boundaries and do not change span parentage, end timing or
protocol behavior. An asynchronous child span that ends after its parent still
expresses causality. Sub-millisecond cross-host clock inversions keep their raw
warnings and are evaluated by their actual source; they are not removed by
adjusting business waits or timestamps.

### Database transactions

Database instrumentation uses technical boundaries, not repository business
method names. SQL is recorded automatically by the driver or the private database
adapter. A transaction uses a separate `postgresql transaction` INTERNAL span,
from the native Begin until the actual Commit/Rollback returns. SQL CLIENT spans
inside a transaction are children of that transaction span; non-transactional SQL
belongs directly to the request or background attempt. The actual connection and
batch wrappers are kept. Prepare and `pool.acquire` do not get separate spans, so
that preparation is not misread as repeated execution.

The transaction result uses `antnest.transaction.outcome`. SQL span titles use
the SDK default operation; the concrete access is in the SQL attributes.
Repeated cleanup must not end a span twice, a failure must not be marked as
committed, and an unconfirmed automatic rollback must not claim success. The
automatic rollback on cancellation in `database/sql` must be finalized at the
`driver.Tx` boundary, not only through the caller's defer. There is no SQL
parsing, table-name guessing, extra querying or transaction retry. SQL text keeps
its placeholders; parameters and result rows are not recorded.

## 4. Health Checks

`GET /status` reflects only the service's own initialization, stopping state and
necessary local dependencies such as its own storage. It does not recursively
call other business services' `/status`. When a real downstream business call
fails, that actual call failure is recorded. Requests with upstream context keep
the normal SERVER hierarchy; autonomous high-frequency successful probes may be
sampled down as whole traces. Readiness waiting during Runtime creation is part
of the business flow, not Gateway health aggregation.

## 5. Verification Requirements

1. Real HTTP calls prove the direct SERVER -> CLIENT -> SERVER parent IDs and call
   counts, with no duplicate health probes. Jaeger trace/span `warnings` must
   also be checked; a complete tree with warnings does not pass.
2. With the RPC switch off, content is neither serialized nor exported. With it
   on, new or nested fields and objects larger than 16 KiB are still captured.
3. Ordinary HTTP and all message streams produce no content even with the switch
   on. Capture adds no read operations and does not break cancellation or
   backpressure.
4. RPC error responses, cancellation and exceptions are still recorded, and
   capture errors do not replace business results.
5. Content capture tests do not assert that secrets are absent. The risk of raw
   development content is a deliberate trade-off of the content switch.
6. SDK, export and receiver failure tests are reported separately from product
   tests. "A trace is visible" does not substitute for business correctness.
7. Test output keeps only final metrics, gaps and Jaeger links; raw content is
   never stored in the repository.

Each language keeps a thin instrumentation component, does not import a sibling
service's internals, and does not build an all-purpose observability framework.

### Jaeger queries in tests

The in-memory storage of the development Jaeger 2.20.0 has a query side effect: a
normal query on a trace that has not fully arrived causes the clock-skew adjuster
to append missing-parent warnings, and a parent span that arrives later does not
clear the old warning. Automated tests therefore wait 6 seconds after the
business request completes and then run one normal query. The wait and the query
happen only in the test scripts; they do not change any service or SDK export
configuration, and there are no raw queries or automatic polling.

The 6 seconds is a buffer over the default 5-second batch export interval and
does not guarantee that all data has arrived. Tests still check parent-child
relationships, content boundaries and zero warnings. Missing spans, API errors
or warnings must fail the test, which can be rerun later. Do not filter
warnings, disable clock-skew adjustment or force business requests to export
synchronously.
