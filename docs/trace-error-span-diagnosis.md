# Error spans and missing parents: evidence review

Follow-up: the [accepted implementation and verification](trace-acceptance-followup.md)
keep intentional SIGKILL spans diagnostic, preserve normal-request completeness
checks, and scope Docker expected-absence semantics to the owning requests.
The inventory below describes the earlier saved runs; their artifacts are unchanged.

Date: 2026-09-17. This is a diagnosis of the saved P1/P2 acceptance evidence,
not a production fix or a new Docker acceptance run. The retained development
stack and application code are unchanged. See the
[acceptance record](acp-persistence-revalidation.md) for business recovery results.

## Evidence inventory

The review reads every raw trace, independently of the fail-fast topology
validator, from these private directories:

- `.cache/acp-persistence/antnest-stage3-e2e-3903/persistence-traces/`
- `.cache/acp-restart/antnest-stage3-e2e-10806/restart-traces/`

Counts use actual `error=true` or `otel.status_code=ERROR` tags, and actual
`CHILD_OF` references resolved against each final saved span set.

| Finding | P1 | P2 | Assessment |
| --- | ---: | ---: | --- |
| Database response-loss error spans | 27 | 0 | Real errors caused by the injected lost acknowledgement |
| Runtime `outcome_unknown` error spans | 0 | 6 | Real uncertainty in the two interrupted in-flight Tool calls |
| Docker HTTP 404 error spans | 2 | 4 | Expected absence during storage/container creation; instrumentation lacks caller context |
| Traces with unresolved synchronous parent references | 0 | 6 | All six intentionally interrupted requests |
| Missing distinct parent IDs referenced by surviving spans | 0 | 27 | These are IDs, not the total number of lost spans |
| Child edges pointing to missing parents | 0 | 49 | Multiple children can reference one missing parent |

All 76 other request/lifecycle traces have resolvable synchronous parents in
their final saved span sets. This does not clear their other strict failures.

The P2 summary previously omitted the six Runtime errors: `requestTraceBoundary`
invokes the strict topology assertion before `inspectInterruptedTrace` reaches
its error inventory. The client catch then stores only the first assertion
message. See [interruption inspection](../scripts/acp-restart/trace.mjs) and
[result collection](../scripts/acp-restart/client.mjs). The strict verdict stayed
failed, but the diagnostic report concealed simultaneous failures.

## Which error spans should remain errors?

P1's 27 errors are four failed COMMITs, four failed ROLLBACK attempts, four
transaction spans, four `acp.session.prompt` spans, five `acp session/prompt`
spans, two atomic `WITH` statements, two `agent.run` spans and two output spans.
COMMIT/atomic-write clients report `Connection terminated unexpectedly`;
ROLLBACK reports an already unusable connection. The
[transaction kernel](../services/agent-acp-service/src/adapters/postgres/kernel.ts)
attempts rollback on failure and propagates the resulting error. These counts
include propagation across boundaries, not 27 independent incidents. Database
commit success does not make a client that lost its acknowledgement successful.

P2's two in-flight traces each contain one `runtime.executor`, one
`runtime.mcp.tool`, and one `runtime.mcp.operation` error with
`error.type=outcome_unknown`. The Runtime's
[execution actor](../runtimes/antnest-runtime/src/execution_actor.rs) deliberately
classifies interrupted operations with possible side effects as unknown. These
errors agree with the public unresolved audit and protective Runtime barrier.
They should remain observable; scenario-specific expectations must not erase
them or allow unrelated errors.

The six Docker 404s all belong to successful creation paths: two workspace
existence probes and four container existence probes across P1/P2. The
[driver](../services/runtime-controller/internal/platform/docker/driver.go)
explicitly accepts absence and creates the resource, while the generic
[HTTP transport](../services/runtime-controller/internal/telemetry/transport.go)
marks every status >= 400 as failed. This is the clearest production improvement:
pass the narrowly scoped existence-probe semantics to instrumentation, retain
HTTP 404 and an absence outcome, and leave span status unset. Required-resource
404s, 5xx, transport errors and response-body errors must still fail. This is
consistent with the context-dependent 404 rule in
[OpenTelemetry HTTP conventions](https://opentelemetry.io/docs/specs/semconv/http/http-spans/#status).

## Why the parents are missing

| Interrupted request | Exported ACP spans | Distinct absent parents | Broken child edges |
| --- | ---: | ---: | ---: |
| v1 model held | 0 | 4 | 4 |
| v1 Tool completed, model held | 0 | 6 | 6 |
| v1 Tool in flight | 80 | 4 | 16 |
| v2 model held | 0 | 4 | 4 |
| v2 Tool completed, model held | 0 | 6 | 6 |
| v2 Tool in flight | 81 | 3 | 13 |

There are two different loss mechanisms:

1. **Finished spans still in process memory.** The four model-held cases have
   Runtime spans proving earlier MCP preparation completed, but no ACP spans at
   all. ACP uses a [BatchSpanProcessor](../services/agent-acp-service/src/telemetry/telemetry.ts).
   The installed SDK defaults to a five-second batch interval. Losing queued
   spans on SIGKILL is consistent with this evidence; the saved traces alone
   cannot identify the exact queue/export stage of every missing span.
2. **Operations still running when the process dies.** The two in-flight cases
   preserve many completed ACP children but lack their running Run/Tool parents
   (and the v1 dispatch parent). These spans end in `finally` after their operation
   finishes. SIGKILL cannot run that code or the normal telemetry shutdown path.
   Changing batch delay cannot cause an unfinished span to become exportable.

A serial, offline experiment using the installed SDK confirms the second point:
start a parent and child, end the child, then call `forceFlush()`. Only the child
exports, with its real absent parent ID. End the parent and flush again; the
parent then exports. The provider is shut down after the experiment. Both simple
and batch standard processors export finished spans under the
[OpenTelemetry SDK contract](https://opentelemetry.io/docs/specs/otel/trace/sdk/#built-in-span-processors).
Replacing batching with simple export cannot guarantee a complete SIGKILL trace.

These are structural missing IDs; synchronizing clocks cannot restore them.
Separately, 28 P1 and 19 P2 saved warning entries claim a parent is missing even
though that parent exists in the final saved trace. Those messages no longer
describe a current topology gap. They are consistent with earlier partial-trace
queries; the exact Jaeger warning-retention mechanism has not been reproduced.
Raw warnings and current topology should be reported separately, without
silently rewriting historical strict results.

## Recommended delivery order

1. Runtime Controller batch: define and test expected-absence HTTP semantics,
   then implement only that service's Docker probe instrumentation and run its
   local gates followed by a separate lifecycle integration regression.
2. Fixture diagnostics batch: inventory raw errors and broken references before
   topology assertions, so one failure cannot hide another. Keep the strict
   failed verdict and report stale warning messages separately from current gaps.
3. Fault-observability contract: retain P1 errors and P2 uncertainty as expected
   fault evidence. Normal requests still require complete traces. For SIGKILL,
   explicitly report interrupted/incomplete traces and correlate recovery using
   durable Run/Tool audits. Do not synthesize completed parents or simply waive
   all errors in a fault-labelled trace.

Shortening a fixture's batch interval may reduce loss of finished spans, but
does not resolve active parents. A crash-durable span lifecycle recorder would
be a separate, larger design; the present recovery evidence does not justify
that work solely to make an intentionally killed request look complete.
