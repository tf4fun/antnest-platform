# Gateway ACP Closeout Integration

Install locked host dependencies with `npm --prefix services/agent-acp-service ci`,
then run `ANTNEST_E2E_ACP_CLOSEOUT=true make e2e-stage3`. The parent creates a
disposable Compose project with real Identity, Controller, ACP, Runtime,
Gateway and private service databases on one PostgreSQL instance. Only the
model is deterministic. No external Provider or credential is required.

The host coordinator alone kills/restarts the project's ACP container. The
client has no Docker socket. File checkpoints synchronize a model-observed
barrier with the host; a fixed sleep is never treated as evidence of execution.
JSON checkpoints are atomically published by same-directory rename, so file
existence cannot expose an incomplete fault request.
The parent cleanup removes all fixture containers, volumes and temporary data,
including on failure. This profile must not run against a retained dev stack.
The parent selects its management/control subnet pair against Docker's existing
IPAM allocations, including enclosing subnets, instead of assuming a PID-derived
pair is unused. Discovery failure or exhaustion must abort before provisioning.
This is allocation for the single coordinating test process, not a reservation
protocol for concurrently launched test suites.

## Scenarios (Each For Stable v1 And Draft v2)

1. Create three Agents through Gateway: two owned by user A and one by user B.
   Deny B's upgrade to A's Agent. For admitted connections, deny foreign
   principal and foreign Agent access to a completed Session, without history
   leakage, model calls or persisted effects.
2. Disable the owner through the administrator API while its connection remains
   open. The first new prompt must close with Gateway 1008 before ACP admission:
   no failed Run intent or other ACP mutation may be created. Wait for automatic
   Agent Disable, restore the owner, explicitly enable both
   owned Agents and reconnect, retaining only previously authorized history.
   Owner restoration alone must not enable Agents. This is Identity deactivation evidence,
   not a claim about logout/expiry of an already-upgraded browser connection.
3. Complete a real Bash append Tool, reconnect twice and replay history. Kill
   the ACP process with SIGKILL, restart it, replay the same history and verify
   stable messages, Run/Tool rows and model counts. A new prompt must work.
4. Hold the first model response, kill ACP, restart. The admitted Run must
   become `failed/quiescent/none`, record `service_restarted_during_run`, finish
   its admission and accept a new prompt without resending the old request.
5. Append one effect through Bash, hold the following model response, kill ACP
   and restart. The Run must become `failed/quiescent/settled`, preserve the
   completed Tool and never repeat the append. Verify the physical effect log
   through a later read Tool, not merely an idempotent file-existence check.
6. Keep a real Bash Tool in flight after appending a separate unique marker.
   The host verifies the exact Runtime scope/Agent labels, reads the physical
   marker and confirms the recorded Bash PID is alive before killing ACP.
   Recovery must preserve an `unresolved/quiescent/unknown/runtime_mcp` Run and
   a failed Tool with an honest unknown result. `quiescent` describes the ACP
   executor, not proof that the remote process has stopped. Another Session must
   receive `agent_busy`, and replay must not call the model or Tool. Explicit
   administrator rebuild removes the old Runtime and releases its occupancy,
   with an event linked to the original admission and the rebuild operation.
   Before the client can resume work or start the next version's scenarios, the
   host checks that the original container ID no longer exists. A later Disable
   cannot mask missing rebuild cleanup. Unknown terminal Tool updates must be
   visible and replay exactly once; v2 also replays one `idle/_unresolved` state.
   Reconnect to the original Session, read the retained physical marker once,
   and verify the old unknown audit record has not been rewritten as success.

Latest Docker acceptance (2026-09-11, `antnest-stage3-e2e-53749`): all six scenarios passed for both versions,
with eight real ACP restarts and 26 validated model requests. Four completed
execution traces contained 812 spans, including both post-rebuild read paths.
The 49 ACP fixture/oracle tests passed serially, including socket-error and
deadline handling; separate shared-oracle baselines remain in the main report.
The final profile result is
published only after successful parent cleanup and zero owned resources.

The official SDK is the ACP client. Assertions use version-specific completion
and replay methods. Upgrade rejection and late WebSocket errors belong to the
fixture connection: they must reject its pending operation, not escape as an
unhandled process error that bypasses diagnostics. Requests use the SDK's
`cancellationSignal` plus a bounded local wait that closes an unresponsive
connection. HTTP 503 is a failed test, never an implicit successful retry.
Read-only queries against the fixture's ACP-owned database
corroborate replay and recovery; no service writes another service's tables.
Unknown/released admissions are correlated through Controller's read-only event
API and the administrator event projection, not by reading Controller tables.
Gateway-origin Jaeger ancestry is checked on the completed baseline before
fault injection and on the completed post-rebuild read; abrupt process death
may lose unexported spans.

Not covered: acquire/finish response-loss windows, concurrent rebuild while a
Run is active, OIDC/SCIM provisioning,
browser rendering, or full ACP protocol conformance. Keep these open in the
[closeout plan](../../docs/docker-single-node-closeout.md).
The separate managed-MCP profile supplies stable-v1/draft-v2 active-Run rebuild
evidence. The separate [RPC response-loss profile](rpc-loss.md), run with
`make e2e-rpc-response-loss`, supplies deployed acquire/finish response-loss
evidence for both versions. The exclusions above describe this SIGKILL profile,
not those separate acceptance suites.

Session setup/replay may send the standard command catalog. The suite validates
that catalog separately from durable history; revoked/foreign operations must
not add or change any notifications after the observed setup boundary. Negative
tests reject unexpected input, Tool/usage output, foreign Sessions and duplicate
catalogs. New Sessions must have no execution state; v2 empty-session recovery
must additionally replay exactly one idle state. Tool input is compared with
the database's JSON-text encoding, including escaped characters, rather than
mistaking the encoded payload for the domain event. Tool identity and output
are checked against persisted events and the actual Bash result, not the
Provider's response-local ID (which the application scopes to avoid collisions).
Container completion uses one successful Status/ExitCode snapshot;
an inspection failure cannot turn a still-running client into a passed result.
