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

| Boundary                                                   | Captured                                                                                                           |
| ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| HTTP/static assets/proxies                                 | Method, route, status, target, latency, error and parent-child relationship; no header values or bodies            |
| Single request/response RPC                                | Basic record; when the switch is on, the existing parameter and result objects, without field filtering            |
| Message streams (SSE/WebSocket/model output/notifications) | Basic connection, operation result, cancellation and error; content is never captured, accumulated or concatenated |
| Database/Executor                                          | Existing operation boundary, correlation IDs, result and error; no additional reads for capture                    |
| Egress forwarding data plane                               | No per-packet or per-flow OTLP; aggregate metrics and control RPCs are retained                                    |

RPCs are identified by the existing protocol adapters, not guessed from URLs or
JSON fields. For example, the Gateway login HTTP request records only basic
information, while the Identity `local_login` RPC may capture content.
Do not add both HTTP CLIENT/SERVER and RPC CLIENT/SERVER spans at the same
boundary; reuse the existing span. A request with its own protocol dispatcher
may use the existing operation span. A message notification does not become a
content capture point just because it is decoded into an object internally.
Ordinary HTTP proxies do not capture internal RPC payloads, so the same content
is not copied at every hop.

Gateway's Identity session-revocation adapter records fixed
`rpc.method=list_session_revocations`, `rpc.service=identity` and
`rpc.system.name=antnest.http-json` on its existing outbound HTTP CLIENT. The
method identifies actual attempts including send failures with no receiver;
the adapter supplies it explicitly, without URL/header inference or additional
spans. It preserves the original failure and transport lifetime and never
captures feed content, private SIDs, cursor values or credentials.

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

### ACP HTTP access-revocation closure

When a session-output, learning-notice or permission failure actually invokes
the ACP v1 connection's close path, an original `DomainError` with code
`access_denied` may add one `antnest.stream.termination` event to each still-open
HTTP GET SERVER span owned by that connection. Record it synchronously before
the SDK close call; SDK response completion can precede outer transport cleanup.
The event has only `reason=access_denied`, `error.type=DomainError`,
`source=session-output|learning-notice|permission`, `antnest.agent.id` and
`antnest.organization.id` from the trusted connection binding.

The first connection failure owns the reason. An already closed connection,
POST/DELETE, a finished response, a different connection, wrapped or lookalike
errors, and other error codes do not receive this event. Ordinary rejected RPCs
and silent output-subscription retirement are not connection-close evidence.
Keep the existing `stream_interrupted`/`disconnected` ERROR and its original
lifetime; add no span, payload, error message, token or connection identifier.
Consumers still require the actual same-Agent/organization offboarding evidence
and completed GET ancestry. The event does not prove offboarding by itself, and
historical generic disconnects remain unclassified.

### ACP workspace stream shutdown

The existing `watch_agent_execution_state` SERVER may record the fixed
`antnest.stream.termination=process-shutdown` only when the actual thrown object
is the normal shutdown reason created by `RunSupervisor.shutdown()`. Register
that exact Error identity without changing its name, message or propagation.
A prior failure remains the first stop reason and must never be registered as
normal shutdown. Matching text, error names, wrapped causes, an aborted signal
or a nearby container stop do not establish this diagnostic.

The marker identifies the propagated shutdown reason, not the first lifetime
source of every stream. Caller disconnect, access revocation, unrelated
publication/storage/delivery errors and non-streaming reads do not receive it.
Keep the original ERROR, error event, response, parentage and transport lifetime;
do not capture stream contents. Consumers still need the actual stream and
process-lifecycle evidence. Historical unmarked errors remain unclassified.

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
necessary local dependencies such as its own storage, including cached health
of required background workers. Runtime Controller exposes its observation
monitor state as `monitor_ready`; retries/reconnection report 503 while the
process remains live. Reading that state makes no extra dependency request.
It does not recursively
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
   never committed to Git or printed in ordinary output. Resolve provenance
   checks retain complete raw queries and traces privately in an explicitly
   selected, ignored `artifacts/verification/` directory. Each collection has a
   separate directory (0700), with evidence files restricted to 0600. Assertions
   and JSON parser errors must not disclose captured bodies.

Each language keeps a thin instrumentation component, does not import a sibling
service's internals, and does not build an all-purpose observability framework.

### Jaeger queries in tests

The in-memory storage of the development Jaeger 2.20.0 has a query side effect: a
normal query on a trace that has not fully arrived causes the clock-skew adjuster
to append missing-parent warnings, and a parent span that arrives later does not
clear the old warning. Ordinary observability checks therefore wait 6 seconds
after the business request completes and then run one normal query. The wait and
the query happen only in the test scripts; they do not change any service or SDK
export configuration, and these ordinary helpers do not use raw queries or
automatic polling.

The [Resolve provenance collector](../tests/e2e/observability/resolve-evidence.mjs)
has a separate, fixed sampling policy: wait 6 seconds, then collect exactly three
complete current/source/refresh-trigger snapshots, 1 second apart. A query,
structure, warning, source error or owning business validation failure stops
immediately, without retries or a fourth sample. The complete snapshots must
agree, including payloads, logs, SQL and timing; comparison sorts spans by ID
without altering the archived raw order. Changed content fails instead of
restarting convergence. Every sample archives its raw query responses before
validation and its complete traces before topology checks. The caller supplies
the effective deployment capture setting and TTL; these are not inferred from
the observed Resolve decision. With capture enabled, legal receiving RPC JSON
may contain credentials or objects larger than 16 KiB. HTTP, stream, CLIENT,
private credential handoff and SQL parameter/result content remain forbidden.

The local-admin login/session, Template and Egress database exercises require an
explicit private evidence directory before reading login credentials. They read
`ANTNEST_EDGE_RESOLVE_CACHE_TTL` and `ANTNEST_TELEMETRY_CAPTURE_RPC_CONTENT` from
the selected `--env-file` (default `.env`), with exported environment values
taking precedence as in Compose. Use the settings that actually started the
deployment. For example:

```sh
node tests/e2e/observability/exercise-local-admin-login.mjs \
  --confirm-development \
  --resolve-evidence-directory artifacts/verification/observability/login
node tests/e2e/observability/exercise-template.mjs \
  --confirm-development --model MODEL_ID \
  --resolve-evidence-directory artifacts/verification/observability/template
node tests/e2e/observability/exercise-egress-database.mjs \
  --confirm-development --agent AGENT_ID \
  --resolve-evidence-directory artifacts/verification/observability/egress
```

The login trace retains its original single-query policy and requires receiving
RPC request/response events, so that exercise requires deployment capture to be
enabled. Its session read uses Resolve provenance and requires one non-touching
Identity SELECT only when a real RPC ran, including a linked shared source.
Template creation retains its metadata-only Controller boundary, catalog write
transaction, image/revision reads and idempotency replay. Egress retains the
unchanged-policy CAS, persisted readback and owning database primitive checks.
Neither a cached decision nor another trace's Identity SQL replaces the owning
business SQL. Use an idle test Agent for the Egress exercise: an unchanged CAS
can still reset active flows. All three exercises keep their logout cleanup on
observation failure; credential-bearing failure objects are not printed.

The live lifecycle and creation/readiness exercises use the same deployment
configuration and private Resolve evidence directory:

```sh
node tests/e2e/observability/exercise-lifecycles.mjs \
  --confirm-development --template TEMPLATE_ID --revision REVISION \
  --resolve-evidence-directory artifacts/verification/observability/lifecycles
node tests/e2e/observability/exercise-creation-observation.mjs \
  --confirm-development --retain-for-review \
  --template TEMPLATE_ID --revision REVISION --postgres-container CONTAINER \
  --resolve-evidence-directory artifacts/verification/observability/creation
```

These commands retain the owning workflow's Activity ordering, committed SQL,
Runtime RPC, terminal state and exact-key replay checks. Runtime response bodies
are required for create/rebuild/enable evidence, so enable deployment RPC capture
for those commands. Creation/readiness retains its separate Controller-rooted
readiness trace and persisted PostgreSQL binding check; readiness is queried
once after the admission collector's export grace and has no Gateway Resolve
decision. The creation exercise deliberately retains its single test Agent for
review. A business trace with strict diagnostics returns a nonzero exit code and
`trace_failed`, even when the owning workflow accepts a completed retry.

Reviewing an existing creation requires the original trace's TTL and capture
settings explicitly; current deployment settings do not establish historical
configuration. This mode neither creates an Agent nor replays its creation:

```sh
node tests/e2e/observability/exercise-creation-observation.mjs \
  --confirm-development --retain-for-review --postgres-container CONTAINER \
  --agent AGENT_ID --request REQUEST_ID --trace TRACE_ID \
  --resolve-ttl-ms 10000 --capture-rpc-content \
  --resolve-evidence-directory artifacts/verification/observability/creation-review
```

The two offline trace checks also require explicit historical configuration and
a private directory before querying Jaeger. Use `--no-capture-rpc-content` only
when capture was disabled and the owning workflow permits metadata-only proof.
Their default rejection of workflow retries remains unchanged:

```sh
node tests/e2e/observability/check-create-workflow.mjs \
  --trace TRACE_ID --request REQUEST_ID \
  --resolve-ttl-ms 10000 --capture-rpc-content \
  --resolve-evidence-directory artifacts/verification/observability/create-check
node tests/e2e/observability/check-lifecycle.mjs \
  --admission TRACE_ID --request REQUEST_ID --agent AGENT_ID --kind disable \
  --resolve-ttl-ms 10000 --no-capture-rpc-content \
  --resolve-evidence-directory artifacts/verification/observability/lifecycle-check
```

The 6 seconds is a buffer over the default 5-second batch export interval and
does not guarantee that all data has arrived. Tests still check parent-child
relationships, content boundaries and zero warnings. Missing spans, API errors
or warnings must fail the test, which can be rerun later. Do not filter
warnings, disable clock-skew adjustment or force business requests to export
synchronously.
