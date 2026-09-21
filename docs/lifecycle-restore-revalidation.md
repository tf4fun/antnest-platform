# Offline restore acceptance migration

Date: 2026-09-21. Baseline: `866d0aa` plus preceding uncommitted acceptance and
Temporal readiness/development synchronization batches. This batch owns Restore
acceptance and its documentation; no production service implementation changes.

The [migration contract](../scripts/lifecycle-closeout/restore-migration-contract.md)
defines the current recovery set and ordering. The old five-database scenario
omitted Temporal history/visibility and its live writer. Current acceptance uses
Foundation deployment, stops application writers followed by Temporal, restores
all seven databases into empty owned storage, and checks frozen fingerprints
before schema initialization or service startup. Existing checksum, permission
drift, filesystem metadata, Skills and saved encryption-key assertions remain.

Public Agent events, configuration/network rules and the original completed Run
must survive restoration. Exact Session replay must preserve audits and make no
model call. An untouched restored Session executes one new Tool Run under the
new execution revision. Isolated Jaeger stays alive across storage replacement
to retain original lifecycle/request traces; it is outside the recovery set.

Test-first coverage adds an independent seven-database/Temporal-writer inventory,
Run ownership/revision checks and negative replay-audit assertions.

The first Docker project `antnest-lifecycle-284110cf` passes all business steps
but retains a Trace topology failure: the post-restore request correctly executes
`read`, while its fixture omitted `toolName` and inherited the shared inspector's
`bash` default. The expectation now explicitly names `read`; the existing shared
negative test already rejects that omitted/wrong Tool expectation. No service
change or error waiver was needed. Shared fixture/contract/component regression
passes 953 tests with five gated skips and no failures (958 total). Formatting
checks pass.

The corrected full Docker repeat `antnest-lifecycle-c5855a3f` passes deployment
and every business assertion: seven databases, two persistent volumes and three
encryption keys restored after actual storage replacement; two transactional
permission-drift probes detected and rolled back. Five history notifications
replay exactly with zero model calls or new Runs. Both original and new Tool
Runs complete, with four model calls total. Original public Run/event history,
configuration and filesystem metadata remain intact. Business Delete removes
the Agent's compute and workspace before teardown.

All ten current Trace topologies pass: four lifecycle operations and six actual
SDK requests (two New, two Load, two Prompt). Raw evidence has zero missing
parents and zero ERROR spans. All six request strict checks pass; four lifecycle
strict results remain failed on clock-adjustment warnings, with calculated
deltas from -779.137 to 861.613 microseconds. The profile retains strict exit 2;
this is scoped business/topology evidence, not full strict deployment acceptance.

Independent checks find no owned containers, volumes or networks from either
project and no remaining verification children. All twelve retained container
IDs, images, mounts, running and health states match the baseline; eleven health
checks pass (Jaeger has no health check). No old shared asset was removed.
Loss/interrupted-update and older Workspace consumers remain; Loss is next.

Private evidence is stored under
`.cache/lifecycle-restore-migration-20260921/` and
`.cache/lifecycle-restore/<project>/`. Temporary recovery archives are removed
after the scenario. Retained development and other legacy assets are preserved.
