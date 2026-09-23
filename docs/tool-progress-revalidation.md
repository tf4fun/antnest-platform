# Tool Progress Deployment Revalidation

Recorded: 2026-09-17 (Asia/Shanghai). The current ACP/Runtime combination passed
all **12 business scenarios** and **12 trace topology/correlation checks**.
Strict Trace failed on recorded timing warnings, so the deployment script
returned exit 1 (`make` returned 2). No production implementation changed.

## Contract And Fixture Repair

The [progress driver](../tests/e2e/acp-progress/README.md) covers ACP v1/v2,
native Bash/Runtime-managed stdio MCP, and success/failure/cancellation. The
external OpenAI-compatible SSE model is deterministic; Gateway, Identity,
Controller, ACP, Rust Runtime, PostgreSQL, Temporal and Jaeger are real services.
Synthetic accounts manage Agents through Gateway. Only the test driver uses
the Docker socket for label-checked gate files and process probes as UID 1000.

Two obsolete fixture assumptions were reproduced before their repair: creating
Model Profile revisions through the removed POST API, and correlating Provider
requests to retired admission tags/the wrong model span. The fixture now creates
a Provider connection, reads its stable Model identity, references that identity
from a Template, uses the returned Template revision, and waits for executable
Agent readiness. It rejects ambiguous model inventories.

The trace oracle follows the actual `HTTP POST model` CLIENT span to
`model.complete` and its owning `agent.run` with `antnest.run.id`. It requires
Gateway SERVER/CLIENT ancestry, complete parents, unique span IDs, one Runtime
preparation before model execution, exactly one ACP dispatch and one Runtime
Tool invocation. It rejects unrelated management calls, credentials and progress
payload capture. Deliberate managed Tool failures permit errors only in the
matching Tool call; cancellation additionally permits the owning Run error.
Bash exit 7 is a completed result and does not permit error spans.

The progress-only Compose override removes the host Temporal port, keeps dynamic
IP allocation away from fixed Egress/Jaeger addresses and ignores local `.env`.
Other deployment profiles retain their existing behavior. The Runtime fixture
image contains the production Runtime plus its official-SDK managed MCP test
executable; the retained development stack was not rebuilt or redeployed.

## Evidence

The candidate is `fa80267` plus the previously validated ACP metadata worktree
changes and this integration-only fixture repair. Current service images were
reused from the preceding [combined browser integration](acp-platform-integration.md).
The managed Runtime build target and integration image were rebuilt serially.
Final managed Runtime image:
`sha256:59c0cc5ece8650f8fcbf5134ff42b663ffda6cbd7b1c59d2ae65ec0f6bdc3ed0`.

The first fixture run reproduced four failures. New diagnostic/negative-error
tests subsequently reproduced two additional missing checks before repair.
Final local verification: **16 progress fixture tests plus 10 shared model/Trace
collector tests passed**. The collector's delayed-duplicate regression still
passes; deployed traces must have three identical span-ID sets sampled one
second apart after Agent deletion and Runtime telemetry shutdown.

Both complete Docker runs passed all 12 business paths with exactly 20 validated
model requests. The final run used project `antnest-stage3-e2e-58128`:

| ACP | Tool | Success | Deliberate failure | Cancellation |
| --- | --- | --- | --- | --- |
| v1 | Bash | Passed | Exit 7 retained as completed result | `cancelled` prompt, failed Tool, actual PID stopped |
| v1 | Managed MCP | Passed | Controlled Tool error retained | `cancelled` prompt, failed Tool, child cancellation observed |
| v2 | Bash | Passed | Exit 7 retained as completed result | `_unresolved` Run, cancelled Tool, actual PID stopped |
| v2 | Managed MCP | Passed | Controlled Tool error retained | `_unresolved` Run, cancelled Tool, child cancellation observed |

Every success path disconnected after early preview and reconnected before
completion; the gate opened only after preview was received. Every path retained
one Tool ID, one terminal update and exact durable Tool replay on a fresh
connection. The model rejected preview pollution and repeated Tool results.
All four cancellation paths proved execution alive before cancellation and
stopped afterward. Missing authoritative Runtime stopping evidence still rejected
the next prompt with `runtime_barrier_required`; the test does not equate its
private process probe with production settlement evidence.

Final traces each contain one Run, one information read, one catalog read, one
ACP Tool dispatch and one Runtime invocation. Successful paths and Bash exit 7
had zero error spans. Controlled managed errors and cancellation errors stayed
inside their expected Tool/Run boundaries. Six traces passed strict warnings;
six failed with 1,356 repeated entries across these six distinct deltas:

| Phase | Calculated delta | Raw cross-service boundary |
| --- | --- | --- |
| v1 Bash cancel | 246.044 µs | ACP SERVER starts 246 µs before Gateway CLIENT |
| v1 managed success | 48.616 µs | ACP SERVER starts 48 µs before Gateway CLIENT |
| v2 managed failure | 235.947 µs | ACP SERVER starts 235 µs before Gateway CLIENT |
| v1 managed cancel | −2.730963 ms | Runtime SERVER starts 3,570 µs after its ACP CLIENT; ends 1,891 µs after it |
| v2 Bash cancel | −2.583667 ms | Runtime SERVER starts 3,127 µs after its ACP CLIENT; ends 2,039 µs after it |
| v2 managed cancel | −1.405816 ms | Runtime SERVER starts 1,844 µs after its ACP CLIENT; ends 966 µs after it |

The latter boundaries occur during explicit cancellation: the server span
finishes after its canceled client. These timings are consistent with asynchronous
cancellation/recording boundaries; they do not by themselves prove physical
clock drift. The larger deltas are explicitly recorded, not exempted because of
a numeric threshold. No timestamp, SDK, system clock or strict warning gate was
changed. The existing [maintenance decision](controller-acp-execution-boundary-plan.md#obs-acp-clock)
still governs dedicated timing work; this report does not mark strict Trace passed.

Compact local reports and logs are under `artifacts/verification/acp-progress-20260916/` (the
directory was created before local midnight). `result-final.json` records every
phase, Run/Trace ID, error operation, warning and cross-service timing edge.
`result-first.json` retains the earlier run, including its −2.403374 ms warning.
Raw requests, service credentials and complete traces are not saved by this
profile. Local cache artifacts are ignored and not guaranteed in a fresh clone.

A separate project, `antnest-stage3-e2e-58863`, received a real SIGTERM as its
progress client was created. The parent exited 143; both ownership-label scans
found zero containers, volumes and networks, and captured child PIDs were gone.
`interruption.json` records that result. A final independent audit covered both
complete runs and the interrupted run, checked labels and resource names, and
found no remaining test resources/processes. Retained development services were
still healthy. The inventory and image IDs are in `final-cleanup.json`.
Shell syntax, JavaScript formatting and Git whitespace checks also passed.

## Scope Limits

This completes current business/topology revalidation of the 12-path progress
profile, not automatic reuse after unknown Tool effects. Strict timing checks
remain failed. It does not revalidate every older managed-MCP/Stage 3 profile,
whose other retired fixture assumptions remain outside this batch, nor replace
the separate browser acceptance or prove external paid-model quality.
