# Historical acceptance asset retirement audit

Date: 2026-09-21. This is a source/reference audit of the working tree after
[Workspace browser migration](workspace-browser-revalidation.md). It changes
documentation only; no acceptance implementation, fixture, historical report,
image, retained environment or private backup is deleted.

The first write set is now implemented in the separate
[retirement revalidation record](acceptance-retirement-revalidation.md).
The findings below preserve the pre-removal audit snapshot; current status and
regression results belong to that follow-up. The second write set is recorded
in [manual finish retirement](browser-finish-retirement.md). The retained seed
entry is subsequently [retired before setup](retained-seed-retirement.md); its
[inline tail and exclusive helper cleanup](stage3-tail-retirement.md) follow
in a separately verified batch. Current interruption helpers are subsequently
[separated from historical diagnostics](recovery-support-split.md); the tables
below retain the original audit snapshot. The subsequent
[historical interruption retirement](interruption-assets-retirement.md) removes
the unreachable startup-gate/Trace graph after that split.

## Method and limits

Inspected the Makefile, Stage 3 shell dispatch, Foundation dispatch, relative
module imports, exported-symbol consumers, Compose commands/mounts, Dockerfile
COPY instructions and repository documentation references. The initial scan
covered 1,062 source/document files and found 2,121 relative-import references;
the private snapshot is `.cache/acceptance-retirement-audit-20260921/imports.json`.
Those counts describe a textual scan, not a complete JavaScript call graph.
Shell interpolation, container paths, tests and direct CLI entry points were
reviewed separately. In particular, zero module imports does not prove an asset
is unused: Compose runs the Workspace model and shell launchers run Identity
clients. References from tests do not establish a current deployment consumer.

Existing business/topology evidence is cited below with its strict failures
unchanged. No Docker E2E or service tests were rerun for this documentation-only
audit. A later code-removal batch must run its own applicable gates.

Static checks confirm that the six candidate implementations have only the
listed old-graph/test importers, and that the lifecycle allowlist equals its
Foundation dispatch. All 229 local links across the eight changed documents
resolve. The reviewed shell launchers pass `sh -n`; the new audit and updated
status/profile documents pass formatting checks, and `git diff --check` passes.
The root README and Stage 3 design document retain their unrelated formatting.
The private check summary is beside the import snapshot, with file mode 600.

## Entry-point findings

| Entry                                            | Actual dispatch and consequence                                                                                                                                                                                                                                                                                                                                              |
| ------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `scripts/lifecycle-closeout/run.mjs`             | Its argument allowlist and Foundation dispatch contain the same six profiles: foundation, network, health, restore, loss and shutdown. Every accepted argument takes Foundation. The entire `else` branch is unreachable, but its static imports still load the old `flow.mjs` graph. Remove the branch and unused imports together before retiring that graph.              |
| `scripts/lifecycle-closeout/interrupted-run.mjs` | Calls Foundation `interrupted`, which loads `update-receipt-flow.mjs`. It no longer calls `interrupted-flow.mjs`. Normal committed-response recovery does not replace an unfinished-mutation abrupt-crash experiment.                                                                                                                                                        |
| Workspace `run.mjs` / `browser-run.mjs`          | Call Foundation `workspace` / `workspace-browser`. Neither calls the old `workspaceFlow`; browser automation has no manual `finish` input.                                                                                                                                                                                                                                   |
| `scripts/e2e-stage3a.sh`, current profiles       | Nonempty `tool_profile` runs `scripts/e2e-${tool_profile}.sh` and exits. Default selects stage3-base; Identity core/access, Agent access, ACP Session/closeout, Managed MCP and fault profiles select their migrated launchers. Their older inline copies after this dispatch are not additional active acceptance paths.                                                    |
| `ANTNEST_E2E_KEEP_STACK=true`                    | With no specialized profile, still reaches the historical inline setup. It writes Model-owned credentials and revision-pinned Model references into Templates. This is a reachable obsolete seeding mode, not a validated current browser/development setup. Its lifecycle CLI still consumes `lifecycle-closeout/trace.mjs`. Resolve this mode before retiring its helpers. |

The general Stage 3 launcher itself remains required. Its profile validation,
OIDC preparation, Docker wrappers, network allocation and cleanup have current
consumers. Removing the historical tail requires separating these shared parts.

## First bounded removal candidate

After simplifying the unreachable lifecycle branch, these six implementation
files form a superseded orchestration/admission graph with no remaining current
execution consumer. This is a proposed write set, not deletion in this audit.

| Files                                               | Consumers and replacement evidence                                                                                                                                                                                                                                                                                                       |
| --------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Lifecycle `flow.mjs`, `drain.mjs`                   | Only the unreachable lifecycle branch calls the old flow, and only that flow calls the old drain. Foundation uses `foundation-flow.mjs` and `foundation-drain.mjs`. [Foundation follow-up](controller-workflow-span-revalidation.md) covers real held Run, normal Controller restart, lifecycle settlement and complete parent topology. |
| Workspace `flow.mjs`, `cancel-evidence.mjs`         | Old flow has no module caller; it alone calls the old cancellation oracle. [Protocol migration](workspace-protocol-revalidation.md) covers real cancellation, explicit Rebuild, immutable unknown Run facts, offline replay, owner revocation and eighteen complete topologies.                                                          |
| Lifecycle `run-trace.mjs`, `admission-evidence.mjs` | Consumers are exclusively those old flow/drain/cancellation files. They require retired Controller `run_admissions`, `admission.id` and FinishRun correlation. Current execution uses public ACP audits and request-specific Run/Tool/persistence traces.                                                                                |

Remove only the companion tests exclusive to these old oracles:
`lifecycle-closeout/run-trace.test.mjs`,
`lifecycle-closeout/admission-evidence.test.mjs` and
`workspace-closeout/cancel-evidence.test.mjs` (all under `scripts/`).
Preserve current negative cases for unknown effects, duplicate/missing Tool
execution, authorization, parent identity, durable closure and secret leakage.
Do not remove `drain.test.mjs`: it tests shared current drain evidence.

Admission for that batch: inspect the final import/reference diff, run shared
script fixtures serially, then current Foundation and Workspace protocol Docker
profiles. Check owned cleanup and retained-environment identity. Preserve strict
failures and identify any new failure; a lower test count after removing only
obsolete-oracle tests is not evidence of lost current coverage by itself.

## Files that must be split or retained

| Asset                                                                            | Current consumer / disposition                                                                                                                                                                                                                                                                              |
| -------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Workspace `browser-control.mjs`                                                  | `waitForFinish` is test-only and is a function-level removal candidate. `assertWorkspaceBytes` remains used by both C4 and the migrated browser profile. Retain its byte-preservation test; verify both browser profiles if changing this module.                                                           |
| Workspace `model.mjs`, `browser-model.mjs`, their tests and overlays             | Current Foundation workspace/browser overlays execute these model peers. C4 also imports the browser model. Retain exact prompt, Tool, attachment-byte and model-ledger contracts.                                                                                                                          |
| Workspace `process.mjs`, `state.mjs`, `evidence.mjs`                             | Current protocol flow still uses process checks/state observation; migrated request identity does not make these files obsolete.                                                                                                                                                                            |
| Lifecycle `interruption-support.mjs`                                             | Current `update-receipt-flow.mjs` and `loss-flow.mjs` use bounded polling, service/Runtime inspection and `journalReader`. Retain them and their current fields. `interruptionCompose` has no caller; `removeTestImages` is test-only. Any extraction must preserve current SQL evidence and cleanup tests. |
| Lifecycle `drain-evidence.mjs`, `evidence.mjs`                                   | Foundation, failure, loss, update recovery and observability still import these modules. Inspect individual exports instead of deleting either file with the old flow.                                                                                                                                      |
| Lifecycle `trace.mjs`, `stage3-trace.mjs`                                        | The reachable retained-stack `stage3-lifecycle-trace-assert.mjs` still imports them. Keep until that entry is migrated or explicitly retired. `evidence.mjs` also serves current observability.                                                                                                             |
| Lifecycle `docker.mjs`, `deployment.mjs`, `acp.mjs`, `model.mjs`, `compose.yaml` | Current Foundation/C4 and model peers use these shared mechanisms; keep ownership, bounded shutdown and secret handling.                                                                                                                                                                                    |
| Identity local/SCIM, OIDC, access, expiry and seed clients                       | Current `e2e-identity-http.sh` and Agent-access launcher execute them through shell/container paths even though they have no relative-module callers. Remove only superseded inline dispatch, not these clients.                                                                                            |
| `scripts/verification`, request/Trace helpers and development browser drivers    | Current acceptance and deployment checks retain independent consumers. Development model selection/failover and real-provider browser checks are separate evidence, not replaced by the controlled browser fixture.                                                                                         |

## Historical diagnostics and retained setup

The uncalled `interrupted-flow.mjs`, `interruption-evidence.mjs`,
`interruption-trace.mjs`, old `interrupted.compose.yaml`, `update.Dockerfile` and
`update-entrypoint.sh` describe the old startup-gate/SIGKILL experiment. Its
checkpoint no longer proves a mutation in progress; the overlay also changes
export timing. [Interrupted migration](lifecycle-interrupted-revalidation.md)
records the different scope of its current replacement. Keep that distinction
and historical failure evidence; do not reintroduce this experiment into the
stable suite or claim its unique fault scope has passed. Archive/removal of this
group is a separate decision after the current helper functions are separated.

The retained Stage 3 branch needs a separate small delivery batch: define whether
its supported purpose is current seeding or retirement, then migrate or reject
the flag before it creates resources. Preserve the existing disposable profile
dispatch and current Identity clients. `stage3-workspace-client.mjs` and
`stage3-lifecycle-trace-assert.mjs` remain tied to that branch until then.
The retained seed mode has no current passing evidence; do not advertise it as
the normal browser-acceptance path.

## Ordered follow-up

1. First removal implemented; see [regression evidence](acceptance-retirement-revalidation.md)
   for the unreachable lifecycle branch and six-file old flow/admission graph
   plus its three exclusive tests.
2. Manual `waitForFinish` export/tests removed; see the [second batch](browser-finish-retirement.md)
   for retained exact workspace-byte checks and both browser regressions.
3. Retained seed mode now [rejects before setup](retained-seed-retirement.md);
   its [inline tail and exclusive CLI/input helpers](stage3-tail-retirement.md)
   are subsequently removed.
4. Current interruption helpers are [separated](recovery-support-split.md).
5. Historical startup-gate/Compose/image/Trace assets are
   [retired with their distinct fault scope recorded](interruption-assets-retirement.md).
   Current recovery and shared observability helpers remain.

The [closeout audit](acceptance-migration-closeout.md) now reconciles all five
follow-ups above. Retained shared modules have current consumers; they are not
unprocessed retirement work. Distinct fault/feature deferrals stay documented.
This inventory does not change prior strict
Trace results, grant full-platform acceptance, or authorize deleting retained
development data, rollback images or private evidence.
