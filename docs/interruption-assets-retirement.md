# Historical interruption asset retirement

Date: 2026-09-21. Follows [current recovery helper separation](recovery-support-split.md).
This batch removes an unreachable acceptance graph; no service behavior changes.

## Retired scope and retained evidence

The old experiment placed a nonce in a workspace startup gate, waited for a new
but unready Runtime with both mutation journals nonterminal, paused the caller,
then sent SIGKILL to both Controllers. It required actual exit 137 without OOM,
frozen request identities, recovery of the same target after lease expiry,
preserved workspace and exactly one execution publication/updated observation.
Its overlay also shortened mutation/dependency deadlines and set a 100 ms span
export interval. These are historical diagnostic assumptions, not stable normal
restart acceptance. Current provisioning completes independently of readiness,
so the startup gate no longer proves a mutation in progress.

The supported interrupted entry calls Foundation's committed-response profile:
Runtime has completed its mutation before a transparent fixture loses its real
response; both Controllers stop normally and recover the same terminal result.
This does not establish recovery from an unfinished platform mutation after
abrupt process death. That fault scope remains without a current E2E pass.
No missing SIGKILL spans or previous strict failures are reclassified as success.

Existing Runtime Controller tests in
[update_recovery_test.go](../services/runtime-controller/internal/control/update_recovery_test.go)
retain created-target/source-deletion/unknown-effect/ownership/terminal-replay
checks. They are narrower service evidence, not a replacement crash experiment;
this source-only retirement neither edits nor reruns those Go tests. Historical
[interrupted migration results](lifecycle-interrupted-revalidation.md) and
[helper split results](recovery-support-split.md), including failures, remain.

## Exact removal boundary

Eleven files are removed from `tests/e2e/lifecycle-closeout/`:

- `interrupted-flow.mjs`
- `interruption-evidence.mjs`
- `interruption-support.mjs`
- `interruption-trace.mjs`
- `interruption.test.mjs`
- `interruption-trace.test.mjs`
- `interrupted.compose.yaml`
- `update.Dockerfile`
- `update-entrypoint.sh`
- `trace.mjs`
- `trace.test.mjs`

The last file-level consumer of the generic old `trace.mjs` collector is in the
retired graph. Its five dedicated fixture cases and one collector integration
case in `evidence.test.mjs` are removed. The other 61 cases in that evidence test
file remain; `evidence.mjs` still serves the observability CLI/tests and current
event-page callers. Current Foundation/Managed MCP collectors, secret checks,
recovery-support, drain evidence, Docker ownership and all current flows are
unchanged. Removing obsolete collector tests is not a claim that every legacy
collector behavior is shared by the current collector.

The 37 startup-gate/kill/recovery fixtures disappear with their exclusive
implementations. Total suite reduction is 43 cases. Current tests are not changed
to satisfy old checkpoint assumptions. No new behavior is introduced, so no new
implementation-mirroring tests are added. Baseline runs all 104 affected fixtures
successfully before deletion. Remaining executable-reference and relative-import
checks find no consumers of removed assets and no unresolved module paths.

Source snapshots, hashes and the deletion manifest are preserved privately under
`artifacts/verification/interruption-assets-retirement-20260921/`; historical source also exists
in Git history. No Docker image, retained data, rollback artifact or private
historical evidence is deleted. The README's stale claim that the current
interrupted profile covers a nonterminal physical-effect crash is corrected.

## Verification

The shared suite passes 1,202 checks with five existing opt-in skips and no
failures or cancellations (1,207 total). The previous 1,250 total minus the
43 exclusive historical cases accounts for the entire reduction. Current HTTP,
WebSocket, Chromium components and observability/recovery fixtures remain covered.
Source hashes confirm no service/current lifecycle implementation change; the
remaining 61 evidence fixtures are byte-identical after removing the one collector
case and its import.

Disposable project `antnest-lifecycle-d55af5d0` passes the committed-response
recovery scenario: both Controllers stop with exit zero, terminal child and exact
Runtime target are reused, original workspace is preserved and the Agent is
publicly deleted before teardown. All three topologies pass with zero missing
parents. All three strict results remain failed, with timing warnings and two
Agent Controller error spans for the canceled Runtime HTTP call and its Activity.
Make returns exit 2; strict Docker admission remains unsatisfied. The source
cleanup and scoped business/topology regression are verified, not full acceptance.

Independent cleanup finds zero owned containers, volumes or networks and zero
verification/browser child processes. Twelve retained development containers
preserve identity, image, mount, network, start time and restart count; all twelve
run and eleven configured health checks are healthy. No production deployment,
image deletion or retained-data change occurs. Formatting, local links, reference
checks and `git diff --check` pass. Prior uncommitted work remains preserved.
Coordinator/source snapshots and owned profile evidence use directory mode 700
and file mode 600.
Strict Trace results must remain failures; this cleanup cannot establish a
full-platform acceptance pass. The current interrupted-update Docker entry is
the applicable regression. The shared suite retains current loss helpers and
observability fixtures; the previous batch's loss Docker result remains dated
evidence, not a new loss run in this batch.
