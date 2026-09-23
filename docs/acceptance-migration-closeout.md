# Acceptance migration closeout audit

Date: 2026-09-21. This reconciles the [migration inventory](acceptance-asset-migration.md)
and [retirement audit](acceptance-retirement-audit.md) after their recorded batches.
It changes documentation only. Migration/source-retirement accounting is closed
for the identified inventory; full strict acceptance remains open.

## Current entry disposition

| Entry family                                                      | Current disposition                                                                                             | Evidence                                                                                                                                                                                                                                            |
| ----------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Stage 3 default, ACP capability and Managed MCP profiles          | Current Provider/Model/Template and ACP Run contracts; shell dispatch uses migrated children                    | Per-profile reports in the [inventory](acceptance-asset-migration.md)                                                                                                                                                                               |
| Identity HTTP/SCIM/OIDC, access, Session and offboarding          | Current authorization ownership, request traces and separate disposable profiles                                | [Identity migration](identity-access-revalidation.md)                                                                                                                                                                                               |
| Lifecycle Foundation, network, shutdown, health, restore and loss | Current Foundation entry and service-owned evidence; later repair/deployment batches remain separately recorded | [Lifecycle README](../tests/e2e/lifecycle-closeout/README.md)                                                                                                                                                                                         |
| Interrupted Update                                                | Current committed-response loss and normal Controller restart; no startup-gate crash claim                      | [Current migration](lifecycle-interrupted-revalidation.md), [latest scoped regression](interruption-assets-retirement.md)                                                                                                                           |
| Workspace protocol and historical four-prompt browser entry       | Current Foundation setup, public Run audits and actual request identities; browser entry is automated           | [Protocol](workspace-protocol-revalidation.md), [browser](workspace-browser-revalidation.md)                                                                                                                                                        |
| Retained Stage 3 seeding                                          | Rejected before setup; unsupported historical seeding is not a development deployment path                      | [Entry retirement](retained-seed-retirement.md)                                                                                                                                                                                                     |
| Obsolete duplicate setup and exclusive helpers                    | Removed after bounded consumer migration/revalidation                                                           | [Initial graph](acceptance-retirement-revalidation.md), [manual finish](browser-finish-retirement.md), [inline tail](stage3-tail-retirement.md), [helper split](recovery-support-split.md), [interruption graph](interruption-assets-retirement.md) |

No unhandled entry migration is identified by this inventory. Shared lifecycle
observability/event-page evidence, recovery/drain helpers, Workspace byte checks,
model peers, Identity clients and Docker/network wrappers still have current
consumers; retaining them is intentional. The dated reports retain their original
candidate, failures and scope. Earlier statements such as “retained branches
pending” in the current summary are replaced with their actual disposition;
historical batch findings are not rewritten into new passing evidence.

## Verification and limits

The source audit finds 31 Make E2E targets whose explicit script paths exist,
16 distinct Stage 3 child profiles whose shell launchers exist, and 812 literal
relative module imports under `scripts` with no missing destination. These are
reference checks, not execution of every target or proof of all dynamic paths.
Stage 1/2 and Runtime-service entries are included only in the Make path check;
they are not newly migrated or newly accepted by this audit.

Thirty existing checks pass serially: seventeen Stage 3 flag dispatch cases,
seven retained-entry guard cases and six current cleanup cases. They execute
the actual bounded shell sections with command doubles and create no Docker
project. Shell syntax and documentation formatting/link checks pass, as does
`git diff --check`. Current executable source and all earlier uncommitted changes
are preserved. Private source hashes and audit results are under
`artifacts/verification/acceptance-migration-closeout-20260921/` with directory mode 700 and file
mode 600.

The preceding source-retirement batch's shared regression remains the latest
recorded full shared result: 1,202 passed, five gated skips. Its normal recovery
Docker regression passed three topologies with zero missing parents and retained
three strict failures. This documentation batch does not repeat that suite,
run Docker, change a service or claim a new deployment result. Earlier scoped
runs must not be added up into a single-candidate full-platform pass.

## Work that remains distinct from asset migration

| Scope                                                        | Current status and resumption boundary                                                                                                                                                                                                                                                                                                                            |
| ------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Strict Trace acceptance                                      | Still fails on recorded timing and scenario-specific cancellation/rejection errors. The [clock maintenance decision](controller-acp-execution-boundary-plan.md#obs-acp-clock) remains in force; new/unexplained errors are not waived. Inspected nonlogical timing findings are deferred and do not block unrelated work. No clock/export setting change is made. |
| Unfinished Runtime mutation followed by abrupt process death | No current E2E passing evidence. The retired readiness gate is not a valid mutation checkpoint. Existing service recovery tests and normal committed-response recovery have narrower scope. This does not add SIGKILL to stable acceptance.                                                                                                                       |
| F07 URL elicitation                                          | Deferred under the previously recorded rmcp 3.4.0 result; it is not a current upstream version check. Deferred by user priority; no new check or implementation is scheduled while upstream support is absent.                                                                                                                                                    |
| Automatic reuse after Tool cancellation with unknown effects | Outside the accepted browser scope. Current protocol requires explicit Rebuild and preserves unknown Run facts; see [Workspace contract](../tests/e2e/workspace-closeout/protocol-migration-contract.md).                                                                                                                                                           |
| Other product scope                                          | Original C4 deferrals retain their dated accounting. Skill Registry and Channel Gateway are not started; Scheduler/Kubernetes/HA remain future scope. See [current status](current-status.md).                                                                                                                                                                    |

The accumulated working-tree changes remain uncommitted. This audit does not
merge, publish or deploy them, and does not delete retained data, rollback images
or private evidence. There is no further legacy-helper deletion justified merely
by the presence of a historical filename; any newly found candidate needs an
actual remaining-consumer check.

The subsequent [pi recovery reference](crash-recovery-pi-reference.md) investigates
crash recovery as the next candidate work, separating Runtime lifecycle recovery
from Agent session continuation. Trace timing and F07 remain deferred.
