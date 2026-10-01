# Controller / ACP Integration

This document describes the Stage 2 Docker integration fixture that tests the
execution boundary between Agent Controller and Agent ACP Service. It runs with
`make e2e-stage2`; the fixture sources live in
[`tests/e2e/agent-acp-service`](../../../tests/e2e/agent-acp-service).

The fixture does not start Agent UI. It uses real Controller publication, ACP
protocol clients, PostgreSQL, Temporal, Runtime MCP, and Jaeger. Only the
external model is deterministic. It must not write execution snapshots directly
or reintroduce Controller Run callbacks.

The fixture creates a Provider connection, a current model, a Template and an
Agent. It waits separately for lifecycle completion, runtime readiness,
publication acknowledgement and ACP availability. Those observations are not
interchangeable.
Agent creation and active-execution rebuild enter through authenticated Gateway
and Console routes. Initial prompts and the Controller-offline reconnection use
the Gateway ACP WebSocket route. Direct internal calls remain for service-owned
fixture setup and assertions; they do not stand in for these public entrypoints.

## Scenarios

1. Execute an ACP prompt and verify the Runtime Tool result and final response.
2. Hold a model response, rotate the Provider credential through Controller,
   wait for publication and verify the next request in the same Run uses the
   replacement credential. The fixture records credential generations, never
   credential values.
3. Stop Controller and execute two further prompts, each with a real Tool call.
   Disconnect and reopen the authenticated Gateway state SSE stream; it must
   read the current ACP state without querying Controller.
4. Rebuild while executing: stop new admission, settle existing execution, then
   replace Runtime. Verify workspace retention and new execution availability.
5. Exercise disable, enable, identity revocation and deletion. A valid transport
   handshake is not authorization; denial must be an ACP protocol response.
   Use the official v1 HTTP client through Gateway while disabled: initialize,
   list and history load remain available, prompt is denied. After enable, the
   same client must receive actual Tool updates and the final response via SSE.
6. Interrupt ACP with an unfinished Run and retained storage. Verify startup
   records interruption without replay; Controller publication restores volatile
   configuration for new execution, not the old Run.
7. Read execution audit after Agent deletion using the separate administrator
   context. Ordinary execution identity cannot impersonate an audit administrator.
8. Reuse the existing Gateway and Console BFF for real cookie login and audit
   reads, including after ACP restart. No Agent UI service is started. Check
   ordinary users, foreign-organization administrators and forged identity
   headers, and verify audit reads never invoke a model or Runtime Tool.

## Trace And Secret Assertions

Jaeger assertions wait for export, require complete parentage and preserve the
link from ACP prompt to asynchronous Run. Run traces contain model and Runtime
calls, not Controller/Identity calls. Lifecycle traces use Temporal spans. The
test client exports its real root spans; invented traceparent IDs are rejected.
Synthetic credential values must remain absent even when RPC diagnostics are
enabled.

The secret checks also inspect ACP database data, both service logs, and actual
lifecycle histories. Temporal history is requested in raw protobuf-JSON form;
its standard payload encodings are decoded before scanning. A decoded Agent ID
is the positive control, and an unknown encoding fails inspection.

Run links must identify the matching Session prompt, and Runtime evidence must
include `tools/call`, not merely discovery or health checks.
Gateway protocol requests may link their per-message trace to the actual
WebSocket handshake trace. The assertions follow both links rather than
requiring a long-lived socket and every asynchronous Run to share one trace or
inventing a parent span.

After the normal six-second export wait, absent traces or missing local parents
are retried for at most fifteen seconds. Time warnings and authorization errors
are not discarded or retried as propagation delay. Topology diagnostics run
independently from clock-warning checks so one clock warning cannot hide a
broken RPC ancestor. Both checks are mandatory, and any failure keeps the suite
unsuccessful. Small Node/Go timestamp-resolution differences can produce Jaeger
clock-skew warnings; the strict warning gate reports them rather than applying a
timing tolerance. Missing parents, incorrect call chains, duplicate spans and
credential disclosure are never waived.

Run submission can be an INTERNAL child of the protocol boundary; the source
must resolve to the same Session's `session/prompt` by ancestry, not by a
hardcoded span title.
Database evidence uses `db.system.name` and write/transaction operations. It does
not require SQL parameter or query-body capture; a read alone is insufficient.
Before intentional SIGKILL, the fixture allows the normal six-second export
window for earlier completed scenarios. This does not promise a complete trace
for the interrupted Run or flush that Run artificially.

## Idle Diagnostics And Recovery Tests

After all business activity and client shutdown, the fixture collects three
Docker resource samples ten seconds apart and counts new Controller/ACP log
lines. These are bounded idle diagnostics, not a sustained-load performance
claim. Only small final metrics are kept, not full container logs.

The same fixture runs the Temporal worker/commit recovery tests serially on a
separate database before the business scenarios. This is not Run resume: an ACP
crash must still produce interruption without replay.

The suite runs serially, and its cleanup removes only resources belonging to
the ephemeral Compose project. It keeps compact final results, not a second
persistent test database or raw credential-bearing trace dumps.
