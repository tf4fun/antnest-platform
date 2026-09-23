# Runtime health and observation acceptance migration

Date: 2026-09-21. Baseline: `866d0aa` plus the preceding uncommitted acceptance,
Temporal readiness and development synchronization batches. This batch owns the
Health acceptance consumer; no production service or SDK changes.

## Current contract

The [migration contract](../tests/e2e/lifecycle-closeout/health-migration-contract.md)
was defined before implementation. `make e2e-lifecycle-health` now routes through
current Foundation setup, private Temporal, reserved network ranges, actual
Template revision and immutable Runtime image checks. It collects current
Create/Rebuild/Delete lifecycle traces and keeps strict status separate.

The previous CPU/cadence scenario remains: two 60-second idle samples, a bounded
three-second unprivileged CPU calibration, PID-1 and cgroup accounting, fresh
startup probes and Engine's steady 10-second cadence. Identity comparison rejects
samples crossing a container/process/binding change. Thresholds are unchanged.

SIGSTOP/CONT targets only the newly created owned Runtime. Three consecutive
failed health checks must become Engine unhealthy, Controller unhealthy and ACP
offline before resuming. A separate cleanup client sends SIGCONT even if the
verification signal or pause request fails. Same-process healthy recovery must
restore ACP readiness with unchanged Runtime, binding and workspace.

Normal stop/start then requires exit zero, the same container and fresh startup
probe timing. Healthy replacement process identity must leave the Agent without
an executable binding and ACP offline over repeated observations. Explicit
Rebuild recovers using the same Template revision and workspace, with new compute,
Runtime and execution revisions. Public audits and the model fixture must show
no Run or model call. Business Delete removes all Agent resources before teardown.

## Verification

Test-first negatives cover incorrect health-only readiness, automatic rebinding,
changed Runtime/configuration, foreign state, lost access, an unexpected active
Session and malformed configuration digests. Cancellation tests require CONT
after observation failure and ambiguous STOP failure. The focused suite passes
22 tests. Shared fixture, contract and local component regression passes 950
tests, with five gated cases skipped and no failures (955 total).

The isolated Docker project `antnest-lifecycle-e9c78492` passes deployment and
the complete health business scenario. Initial and restarted health converge
in 2.171 and 2.238 seconds. Four measured steady intervals are 10.001 seconds.
Container idle CPU is 0.4461%; the calibration reaches 96.0226%, then the second
60-second idle sample returns to 0.4670%. All unchanged CPU thresholds pass.
Three failed probes propagate to Controller unhealthy and ACP offline;
same-process recovery preserves the binding. Normal Runtime shutdown exits zero,
and its healthy restarted process remains unbound over three observations until
explicit Rebuild. Workspace bytes survive both recovery paths. Execution audits
and model requests remain zero, and business Delete removes compute and storage.

Create/Rebuild/Delete Trace topologies pass with 213/281/244 spans respectively,
zero missing parents and zero ERROR spans. All three strict results remain failed
on recorded clock-adjustment warnings (calculated deltas from -136.856 to
784.570 microseconds); the profile retains exit 2. No clock warning is converted
to success, and this is not full strict deployment acceptance.

Independent cleanup checks find no owned containers, volumes or networks under
either Compose or Runtime ownership labels, and no verification child processes.
All twelve retained development container IDs, images, mounts, running and health
states match the baseline; eleven health checks pass (Jaeger has no health check).

Private logs and retained-container baseline are under
`artifacts/verification/lifecycle-health-migration-20260921/`; profile/raw Trace evidence is under
`artifacts/verification/lifecycle-health/<project>/`. Red-test logs and earlier batch failures
remain historical evidence.
Restore, loss, interrupted-update and older Workspace consumers remain separate
migration batches; shared legacy assets and retained development stay intact.
