# Runtime loss acceptance migration

Date: 2026-09-21. Baseline: `866d0aa` plus preceding uncommitted acceptance and
Temporal readiness/development synchronization batches. This batch owns the Loss
acceptance consumer; no production service changes or legacy asset removal.

The [migration contract](../tests/e2e/lifecycle-closeout/loss-migration-contract.md)
keeps live Docker-event and cold inventory-reconciliation cases. Each first
completes a real Bash append and exact history replay. The owned idle Runtime is
stopped normally, its exit-zero/no-OOM state checked, then its stopped container
removed without force. The live case waits for exit invalidation before removal;
the cold case normally stops Runtime Controller before removal and restarts the
same controller container afterwards. SIGKILL is not an acceptance action.

The current Controller uses fresh Inspect evidence to invalidate execution.
Its public/private loss audit has a runtime-condition-loss identity and zero
direct observation sequence. The live audit preserves runtime_exited; the cold
audit preserves runtime_missing. Producer evidence is checked independently:
runtime_deleted/docker_event versus runtime_missing/platform_reconciliation,
with exact Agent, Runtime revision, generation and applicable container identity.
Runtime Inspect must be provisioned/absent with no execution identity or endpoint.

ACP must be offline and reject the existing Session's Prompt with
-32020/agent_unavailable, without notifications, model calls or new Run audits.
Rebuild must replace compute, Runtime and execution revision while preserving
configuration/workspace. Same-Session replay must preserve existing audits, and a
real Read must prove the original append was neither lost nor replayed. A normal
Runtime Controller restart must not replace compute or duplicate loss history.

Test-first negatives cover current audit/projection contracts, producer routes,
foreign fault targets, abnormal exits, semantic denial and denial Trace errors
without execution. Thirteen focused tests pass.

The first project `antnest-lifecycle-bb05d687` reaches live loss but fails on the
legacy event reader's removed `admission_id` column. Loss now uses a scoped
current-field SELECT through the Agent Controller role; the legacy helper is
retained for its remaining historical consumers. The initial failure and red
tests are preserved.

The second project `antnest-lifecycle-3b2471aa` passes both complete business
cases and all fourteen SDK request topologies. Its two Rebuild topologies initially
fail the generic allocation-only 404 oracle. Raw evidence proves an absent source
generation under the exact update operation, followed by successful allocation
and start of the next generation. The opt-in missing-source oracle now requires
that complete chain and rejects absent proof, wrong generation/operation,
missing allocation or missing start. Cached raw lifecycle evidence passes all six
topologies with the new oracle; the two original Inspect ERROR spans remain
strict failures. Their classification belongs to a separate Runtime Controller
service batch.

Shared fixture/contract/component regression passes 957 tests, with five gated
skips and no failures (962 total). The source-absence positive/negative test is
additional to the thirteen focused Loss tests.

Final Docker project `antnest-lifecycle-6d5d6261` passes both live/cold business
cases, six Create/Rebuild/Delete operations with exact replay, four completed
Tool Runs and two semantic Prompt denials. All eight model calls belong to the
four expected Runs. History replay and denied requests cause no model call or
new Run; original Run details remain identical. Both Runtime exits are zero,
workspace bytes/configuration survive explicit recovery, and subsequent Runtime
Controller restarts preserve the replacement and exact event history.

All twenty current Trace topologies pass (six lifecycle, fourteen SDK requests),
with zero missing parents. Thirteen strict results remain failed. Raw evidence
retains two Runtime Controller source-Inspect 404 ERROR spans and four ACP
rejection error markers across the two denied requests, plus timing warnings.
No unrelated error is accepted. The profile retains strict exit 2; this is not
full strict deployment acceptance. The source-404 classification is the recommended
next service-owned repair, before continuing interrupted-update asset migration.

Independent cleanup verifies no owned containers, volumes or networks from any
of the three projects and no verification child processes. All twelve retained
container IDs, images, mounts, running and health states match the baseline;
eleven health checks pass (Jaeger has no check). Formatting and local document
links pass. No production implementation changed, no old asset was removed, and
changes remain uncommitted.

Private logs are under `artifacts/verification/lifecycle-loss-migration-20260921/`; raw profile
evidence is under `artifacts/verification/lifecycle-loss/<project>/`.

## Subsequent service repair

The [Runtime Controller Inspect absence repair](runtime-inspect-absence-revalidation.md)
now passes full service gates and disposable candidate Loss/Foundation regression:
36 complete topologies, zero Runtime Controller error spans, and both source GETs
still report HTTP 404 with outcome absent. The historical evidence above is
preserved. Strict timing, rejection and restart interruption failures remain;
[candidate development synchronization](runtime-development-sync-20260921.md)
subsequently passed nine retained topologies with original data preserved.
Six strict timing failures remain; interrupted-update migration is next.
