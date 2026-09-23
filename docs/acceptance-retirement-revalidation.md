# First acceptance asset retirement batch

Date: 2026-09-21. This implements the first bounded write set from the
[retirement audit](acceptance-retirement-audit.md). Production services and
current acceptance behavior are unchanged.

## Removal and preserved behavior

The lifecycle entry still defaults to `foundation`, accepts the same six profile
names and rejects extra arguments. It now calls Foundation directly after
validation. The unreachable fallback and its old static imports are removed.

Retired six superseded implementation files under `scripts/`:

- Lifecycle `flow.mjs`, `drain.mjs`, `run-trace.mjs` and `admission-evidence.mjs`.
- Workspace `flow.mjs` and `cancel-evidence.mjs`.

Retired their three exclusive test files: Lifecycle `run-trace.test.mjs` and
`admission-evidence.test.mjs`, and Workspace `cancel-evidence.test.mjs`.
These tests required the retired Controller Run admission/FinishRun contract.
All 33 tests passed immediately before removal; they were not removed to conceal
a new failing result. The current suite's test-count decrease must be exactly 33.

Foundation's current held-Run drain, lifecycle settlement and normal restart
checks remain. Workspace retains actual cancellation, immutable unknown Run
audits, explicit Rebuild, physical process exit, replay without effects, owner
revocation and actual response Trace identity. Existing current negative tests
continue to cover missing/foreign parents, execution/persistence closure,
authorization and secret boundaries.

Shared drain evidence/tests, model peers/overlays, browser byte checks,
interruption helpers, Identity clients and observability helpers remain.
`waitForFinish`, reachable retained seeding and historical abrupt-crash assets
are outside this removal batch. No private evidence, development data or image
is retired.

## Verification record

Private pre-change source hashes, copies of the nine removed files, logs and
retained-environment baseline are stored under
`artifacts/verification/acceptance-retirement-20260921/`. Verification runs serially; the two
Docker profiles use isolated owned projects and normal producer shutdown.

The shared suite passes 1,208 tests, with five pre-existing opt-in ACP PostgreSQL
commit-receipt fault checks skipped and no failures/cancellations. Its total is
1,213, exactly 33 fewer than the preceding 1,246-test browser-migration suite.
This includes current unit/contract and local HTTP/WebSocket/Chromium component
checks; no replacement behavior or service build is introduced.

Foundation project `antnest-lifecycle-04b66767` passes nine lifecycle operations
and all sixteen topology checks, including held-Run drain, graceful Controller
restart with exit zero, two real Tool prompts and two no-execution denials.
Missing parents are zero. Seven error spans remain from interrupted settlement
and deliberate busy denials; eleven strict results fail on errors/timing, with
exit 2 preserved. Exact workspace effects, restart/replay and deletion pass.

Workspace project `antnest-lifecycle-c6c06164` passes all eighteen topologies:
four lifecycle, eleven request and three watch/automatic-Disable traces.
Cancellation preserves unknown effects until explicit Rebuild; offline completion
and fresh-connection replay preserve one effect/reply. Replacement Runtime uses
the retained workspace; owner revocation closes access and disables compute.
Missing parents are zero. Fourteen error spans from deliberate cancellation,
unknown effects, denied work and revoked access remain visible; thirteen strict
results fail on those errors/timing, with exit 2 preserved.

Combined evidence is 34 passing topologies, zero missing parents and 24 strict
failures. No strict failure is reclassified as success. Both profiles report
business/topology success; this is not full strict platform acceptance.

Independent cleanup finds no containers, volumes or networks owned by either
temporary project and no verification/browser child processes. The twelve
retained development containers preserve IDs, images, mounts, networks, start
times and restart counts. All twelve run; eleven configured health checks are
healthy. This batch neither rebuilds nor deploys a service image.

Source-hash comparison confirms exactly the nine intended deletions; other
existing implementation changes in this batch are confined to the lifecycle
entry. Previous uncommitted work is preserved. No remaining executable script
imports or calls the retired graph. Invalid/extra CLI arguments reject before
Foundation starts, and both Make targets still resolve to their current entries.
Formatting, local documentation links and `git diff --check` pass. Private
coordinator and owned-profile evidence directories/files use modes 700/600.

The subsequent [manual browser finish retirement](browser-finish-retirement.md)
removes `waitForFinish` and its exclusive tests, preserves `assertWorkspaceBytes`,
and validates both browser profiles separately.
