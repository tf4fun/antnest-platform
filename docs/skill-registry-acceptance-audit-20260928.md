# Skill Registry acceptance gap audit — 2026-09-28

This audit evaluates Skill Registry in the current **clean-development-deployment scope**. There is no pre-existing business data or legacy Agent fleet to migrate. Legacy shared-volume migration, protected off-host export, and exceptional legacy-source recovery are therefore outside this release's acceptance criteria; the 2026-10-01 [release cleanup](legacy-skill-release-cleanup-20261001.md) removes their implementation, published contracts and runnable tests from the current tree. The following dated evidence records the earlier source state, not current migration availability. This does not declare the other two Stage 4 services complete. Existing gate results are recorded in [current status](current-status.md); this audit inspected their current source and did not rerun every gate. After rebuilding Registry, RC, Controller and Console images, `make e2e-stage3-skill-delivery` passed the disposable 12-service deployment, v1/v2 Skill business chain, network-denial and owned-resource cleanup gates on 2026-09-28. `make e2e-stage4-skill-restore` then restored eight databases and six persistent volumes for two real Agents, verified four Runs, Registry-offline Enable, an unaffected peer Run and fail-closed Enable after one Skill volume was removed. Both gates passed business and Trace topology; strict Trace retained only the previously reviewed clock warnings.

| Completion boundary | Current evidence | Remaining limit |
| --- | --- | --- |
| Hosting and package format | Registry unit and PostgreSQL publication tests, shared Go/Rust package rules, scoped Registry→RC Docker integration, and the v1→v2 full-chain gate | No known local implementation gap |
| Template freezing and retired body channel | Controller Template component tests; ACP rejects nonempty `skill_instructions`; Console audit projection checks | No known local implementation gap in this boundary |
| Preparation before lifecycle | Controller/RC local and component tests; Registry outage, slow preparation, restart and full-chain Docker gates | The six-minute retained-reference check uses an aged PostgreSQL reference, not a five-minute wall-clock Drain |
| Ready-reference and mount races | Fenced invalidation, Controller/RC restart, Initialize and Rebuild mount-race/response-loss Docker gates | Abnormal Docker effect remains `unknown` where source preservation cannot be proved, by contract |
| Enable, reuse and read-only delivery | Offline reuse, ready loss/drift, real Runtime read/write denial, and post-migration normal Disable/Enable/Rebuild gates | No known local implementation gap in these tested paths |
| Lifecycle cleanup and backup restore | Multi-database/multi-volume restore, two real Agents and Delete cleanup | No known local implementation gap for current fixed Skill volumes |
| Old-asset migration (outside current scope) | Historical evidence is retained in Git; contracts, binaries and dedicated gates are removed from the current release | No old business data exists to migrate; off-host export and exceptional old-source restoration are not acceptance requirements |
| Product and network boundary | Console browser/BFF checks, real ACP Skill-reading Runs, Registry service-name and private-IPv4 denial | Current Registry network has no IPv6 address; if IPv6 is enabled, actual-address denial needs a new gate |
| Runtime Skill integrity | Full file readback during Prepare, startup mount gate, read-only Runtime mount, and re-verification during recovery cover the normal lifecycle | Privileged host or other-container mutation of an already mounted volume is outside the first-release threat model. There is no continuous file scan or maximum detection time for that exceptional case. |

RC's [prepared readback](../services/runtime-controller/internal/platform/docker/skill_volume.go) calls `verifyCollectionArchive`, while the current internal `VerifyRuntimeMount` is a mount/manifest check. [Runtime inspection](../services/runtime-controller/internal/control/runtime_inspection.go) checks compute identity and health, not every mounted Skill file. The target-drift Docker profile corrupts an **unmounted** Rebuild target before admission. It does not claim to detect a privileged write to an already running Runtime's volume.

Continuous full readback would impose a large recurring I/O cost without addressing a normal Runtime write path. A proposed periodic-watch D0 was withdrawn; it is not a Stage 4 acceptance gate. If a privileged mutation is suspected, operations must stop the affected Agent and restore it from a verified source rather than editing the live volume. The fixed-version Skill Registry business chain meets the current development-stage acceptance scope; the previously proposed off-host legacy export is not a pending gate.

The 2026-09-29 closeout rechecked the stored business/restore assertions and
corrected stale consumer-pending statements in the repository entry documents.
The latest optional preparation run had overwritten its shared JSON without the
real Runtime option. A new run of
`ANTNEST_TEST_REAL_RUNTIME_IMAGE=antnest/antnest-runtime:local bash tests/integration/skill-registry/run-registry-rc-prepare.sh`
passed complete preparation, Initialize, mount mutation denial, target-drift
recovery and real Runtime discovery/read/`write`/`edit` rejection. The fixture
runner used the installed Node 26.8.2; product dependencies and the Runtime image
were unchanged. The full result is retained in the unique private log
`artifacts/verification/skill-registry-real-runtime-20260929.log` as well as
`artifacts/verification/skill-registry-rc-prepare.json`. No test-owned service
processes, containers, volumes or network remained. Documentation links,
`git diff --check` and test-storage policy validation also pass.
