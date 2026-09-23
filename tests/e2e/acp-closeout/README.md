# Gateway ACP Closeout Integration

## Current migration

`make e2e-acp-closeout` and `ANTNEST_E2E_ACP_CLOSEOUT=true make e2e-stage3-local`
select the independent normal-request profile. It uses current Provider/Model
and returned Template revisions, an immutable Runtime image, isolated network
ranges and private synthetic configuration. It does not load the retained `.env`.
The owning [migration contract](migration-contract.md) separates this delivery
from remaining lifecycle and Workspace consumers.

For both SDK versions, the profile creates two Agents owned by one member and
one owned by another member in the same organization. Real Bash effects and
exact public-audit history establish positive access before testing all five
foreign Session methods in both directions. Denials must identify the correct
principal/Agent boundary, emit no notifications and change no ACP rows or model
activity. An authenticated upgrade alone is not authorization: ACP must return
the precise Agent denial.

The existing owner's connections must reject prompts after global deactivation,
and both Agents must automatically Disable. The unaffected member retains
access and history. Restoring the owner must leave Agents disabled; explicit
Enable preserves real workspace sentinels and old private history, then permits
a fresh Run. Completed/replay/rejected requests use their actual message Trace
identities and current ACP audit. Full topology/privacy precedes stable export;
raw traces remain private and strict warnings/rejection errors remain failures.
Evidence is written under `artifacts/verification/acp-closeout-normal/<project>/`.
The [September 21 revalidation](../../../docs/legacy-closeout-revalidation.md)
records 824 passing local checks and 94 scoped Trace topologies, with strict
warnings and rejection errors still failed.

The historical scenarios map to current owning profiles:

| Historical scenario | Current owner |
| --- | --- |
| Foreign principal / Agent and private Session isolation | Normal closeout profile above; cross-organization cases additionally use `e2e-agent-access` |
| Owner revocation, both Agents Disable and explicit recovery | Normal closeout profile above; SCIM and cross-organization offboarding additionally use `e2e-agent-access` |
| Completed history across ACP crash | `make e2e-acp-restart`, completed case |
| Model held at ACP crash | `make e2e-acp-restart`, model case |
| Completed Tool followed by held model at crash | `make e2e-acp-restart`, settled case |
| In-flight unknown Tool effect and physical Rebuild | `make e2e-acp-restart`, inflight case |

Crash recovery is separately opted in; normal closeout does not SIGKILL ACP.
[P1 persistence faults](../acp-persistence/README.md) and
[P2 interruption](../acp-restart/README.md) retain separate evidence. The older
`client.mjs`, `support.mjs` and unknown-effect oracles below are historical source
assets, not the normal profile's implementation. Shared helpers remain in use;
this batch does not delete old assets.

## Historical mixed profile (September 11)

The following records the old candidate and its old ownership assumptions.
It is not a current runnable acceptance recipe. Use the owning profiles above.

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
[closeout plan](../../../docs/docker-single-node-closeout.md).
The separate [current Managed MCP profile](../managed-mcp/README.md) supplies
both-version active-Run rebuild evidence. `make e2e-rpc-response-loss` now runs
the [current publication/settlement profile](../rpc-response-loss/README.md).
Its scoped business checks pass while strict Trace evidence remains failed;
the old [acquire/finish report](rpc-loss.md) is historical. ACP persistence fault
recovery remains pending. The exclusions above describe this historical SIGKILL
profile, not the migrated suites.

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
