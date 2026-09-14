# Controller / ACP Integration

The Stage 2 Docker fixture tests the execution boundary without Agent UI. It
uses real Controller publication, ACP protocol clients, PostgreSQL, Temporal,
Runtime MCP, and Jaeger. Only the external model is deterministic. It must not
write execution snapshots directly or reintroduce Controller Run callbacks.

The fixture creates a Provider connection, a current model, a Template and an
Agent. It waits separately for lifecycle completion, runtime readiness,
publication acknowledgement and ACP availability. Those observations are not
interchangeable.
Agent creation and active-execution rebuild enter through authenticated Gateway
and Console routes. Initial prompts and the Controller-offline reconnection use
the Gateway ACP WebSocket route. Direct internal calls remain for service-owned
fixture setup and assertions; they do not stand in for these public entrypoints.

Required scenarios:

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

Jaeger assertions wait for export, require complete parentage and preserve the
link from ACP prompt to asynchronous Run. Run traces contain model and Runtime
calls, not Controller/Identity calls. Lifecycle traces use Temporal spans, not
the removed recovery worker names. The test client exports its real root spans;
invented traceparent IDs are not acceptable evidence. Synthetic credential values
must remain absent even when RPC diagnostics are enabled.
The secret checks also inspect ACP database data, both service logs, and five
actual lifecycle histories. Temporal history is requested in raw protobuf-JSON
form; its standard payload encodings are decoded before scanning. A decoded Agent
ID is the positive control, and an unknown encoding fails inspection.
Run links must identify the matching Session prompt, and Runtime evidence must
include `tools/call`, not merely discovery or health checks.
Gateway protocol requests may link their per-message trace to the actual
WebSocket handshake trace. Follow both links, rather than requiring a long-lived
socket and every asynchronous Run to share one trace or inventing a parent span.
After the normal six-second export wait, absent traces or missing local parents
are retried for at most fifteen seconds. Time warnings and authorization errors
are not discarded or retried as propagation delay. The current strict warning
gate remains unchanged; see the B5 progress record for the observed Node/Go
timestamp-resolution diagnostic.
Topology diagnostics run independently from warning checks so one clock warning
cannot hide a broken RPC ancestor. Both checks remain mandatory and any failure
keeps the suite unsuccessful. On 2026-09-15 the user explicitly approved closing
this refactor while deferring the observed clock warnings (maximum approximately
1.47 ms) as OBS-ACP-CLOCK. The final nine business scenarios and structural checks
passed; the script's exit code 1 and 40 warning failures remain recorded, not
converted into a green result. This does not waive missing parents, incorrect
call chains, duplicate spans or credential disclosure. No warning classifier or
general timing tolerance is introduced by this closeout decision.
Run submission can be an INTERNAL child of the
protocol boundary; the source must resolve to the same Session's `session/prompt`
by ancestry, not by a hardcoded span title.
Database evidence uses `db.system.name` and write/transaction operations. It does
not require SQL parameter or query-body capture; a read alone is insufficient.
Before intentional SIGKILL, the fixture allows the normal six-second export
window for earlier completed scenarios. This does not promise a complete trace
for the interrupted Run or flush that Run artificially.

After all business activity and client shutdown, collect three Docker resource
samples ten seconds apart and count new Controller/ACP log lines. These are
bounded idle diagnostics, not a sustained-load performance claim. Preserve the
small final metrics, not full container logs.

The same fixture runs the three existing Temporal worker/commit recovery tests
serially on a separate database before the business scenarios. This is not Run
resume: ACP crash acceptance still requires interruption without replay.

The coordinator runs the suite serially and its cleanup removes only resources
belonging to the ephemeral Compose project. Keep compact final results, not a
second persistent test database or raw credential-bearing trace dumps.
