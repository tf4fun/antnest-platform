# Legacy Skill migration release cleanup

The clean-development release does not include old shared-volume Skill
migration, protected legacy export, or exceptional migration recovery. Merely
describing these as out of scope did not remove their executable release
surface. The 2026-10-01 review found two extra Runtime Controller image binaries,
three legacy-named RC HTTP operations, five Controller HTTP operations and their
published schemas, startup wiring, persistence and workflow consumers.
Following the callers also identifies `skill-sets/verify-active` as a
migration-only RC operation; it is retired with its dedicated DTOs and consumer.

## Release boundary

- Retired legacy Skill migration paths return 404 for every method. They are
  absent from the machine contracts and exported DTOs; there are no aliases,
  feature switches or dormant maintenance commands.
- Runtime Controller images contain only the current service executable.
  Ordinary deployment does not mount legacy backup storage or configure legacy
  export verification.
- Controller startup, lifecycle admission, persistence and Temporal registration
  do not include legacy Skill migration or recovery. A fresh database applies
  only the current schema history. This is a development release and does not
  add a migration for old development databases.
- Current Skill preparation, internal collection/mount verification, read-only
  delivery, create/rebuild/disable/enable/delete and automatic learning remain
  required. In particular, `SkillVolumeWriter.VerifyRuntimeMount` still checks
  the actual mounted volume after container creation and before start, including
  replay of an adopted Runtime. Retiring the migration-only HTTP verifier does
  not remove this lifecycle check.
- Removed implementations and old acceptance assets remain recoverable from
  Git commit `5e86f46`. They are not retained as compiled source, live contracts
  or runnable acceptance gates in this release.

## Removed surface

| Owner | Removed release surface |
| --- | --- |
| Runtime Controller | `legacy-backup-export`, `legacy-backup-attest`; inventory and backup create/read RPCs; migration-only active-set verification RPC and DTOs; Docker export/attestation/inventory adapters and startup configuration |
| Agent Controller | Five migration/choice/operation/proof-loss/source-recovery HTTP resources; migration admission and publication branches; recovery Temporal registration and activities; six dedicated SQL migrations, journals and verifier-key configuration |
| Contracts | Eight standalone migration/recovery/verification Markdown contracts and two dedicated recovery JSON schemas; related entries and definitions in the two machine contracts and API schemas |
| Deployment and acceptance | Legacy backup volume and verifier environment settings; six legacy Make entrypoints; dedicated legacy E2E sources; protected-export requirements in the current backup manifest |

The RC machine contract is revision **13** and the Controller machine contract
is revision **36**. There is no compatibility endpoint or option to reactivate
the retired surface. Current ready/candidate Skill volumes, workspaces and the
eight-database Stage 4 restore manifest are retained. The earlier Stage 3
seven-database profile is not converted into a legacy migration workflow.

## Delivery batches

| Batch | Owner | Status |
| --- | --- | --- |
| D0 | Shared contracts | Current RC revision 13 and Controller revision 36 exclude retired routes, errors and DTOs; owning consumers are retired |
| R1 | Runtime Controller | Removed binaries, RPCs, adapters and startup/configuration wiring; 231 unit/contract tests and 212 subtests, PostgreSQL and Registry → RC → Docker preparation gates passed |
| C1 | Agent Controller | Removed consumers, migration admission/state and recovery workflows; 598 unit/contract/component tests and 599 subtests passed; all four Temporal replacement/recovery tests and four subtests passed with no skips |
| I1 | Integration | 552 acceptance-source checks, actual image and 36 HTTP probes, full Skill business workflow, real-Agent backup/restore and ready/empty/candidate storage restore passed; owning-service lint passed |

New negative tests initially fail against the original contracts, Dockerfile,
deployment and RC routes. Evidence is private under
`artifacts/verification/legacy-skill-release-cleanup-20261001/`.
Owning-service gates preceded the explicit integration batch. Failed red/setup
attempts and the first restore Trace failure remain in the evidence alongside
the final passing runs.

## Final verification

| Gate | Current evidence and result |
| --- | --- |
| RC unit/contract | `R1-unit-contract-green-local-network`: 231 tests and 212 subtests, no skips or failures |
| RC component | `R1-postgres` and `R1-docker-prepare`: real PostgreSQL and Registry → Prepare → read-only Docker mount passed; the preparation fixture's Runtime is synthetic |
| Controller unit/contract/component | `C1-component-admission-final` / `C1-postgres-final`: 598 tests and 599 subtests; the four environment-gated Temporal tests are covered separately below |
| Controller Temporal | `C1-temporal-admission`: all four tests and four subtests passed, with no skips; creation, lifecycle replacement, graceful parent-span export and committed activity recovery remain intact |
| Integration sources | `I1-release-and-catalog-fixtures-final`: 552 tests passed, no skips |
| Release and current business | `I1-skill-deployment-docker`: built isolated production candidates; RC image contains only `runtime-controller`; 36 GET/POST/HEAD/DELETE probes over nine retired paths returned 404; automatic learning, dynamic discovery/temporary use, Console promotion, Template freezing and two-Agent explicit rebuild passed |
| Real-Agent restore | `I1-skill-backup-restore-docker-final`: eight databases and four persistent volumes restored; two Agents enabled with Registry offline and four Runs completed; missing retained volume blocked Enable without an empty replacement; peer remained usable; Delete released both Agents' assets |
| Storage restore | `I1-stage4-storage-restore-docker-final`: eight databases and five volumes restored, including ready, empty and preparing collections |
| Go lint | `I1-owning-services-go-lint-final`: both owning services and their root integration/E2E test sources passed; an existing capitalized policy-invariant error message was lowercased for staticcheck |
| Final build | `I1-final-controller-image` / `I1-final-controller-image-surface`: Controller production image rebuilt after the lint-only message correction; only the current service binary is installed; candidate tag removed |
| Static and storage policy | `I1-release-static-checks` / `I1-storage-policy`: 43 Go files formatted, 13 JavaScript modules formatted and syntax-checked, two shell files syntax-checked, 171 schema references resolved, diff whitespace check passed; no cache storage violations and all four Python policy tests passed |
| Documentation | `I1-first-party-markdown-links`: 299 first-party Markdown documents and 2,010 local targets checked |
| Resource cleanup | `I1-final-resource-cleanup`: eight test projects have no remaining owned resources; no candidate tags or verification child processes remain; the baseline's 19 containers, 15 running containers, 15 networks and 22 volumes are preserved |

The real-Agent restore's business and Trace topology pass. Raw strict Trace
status remains **2** for clock-only warnings; accepted status is **0**, using the
previously recorded [clock-warning exception](stage-3-current-services-closeout.md).
Warnings and affected edges remain in private evidence; they are not filtered
or relabeled as strict passes. No clock synchronization or SDK timing change is
part of this cleanup.

The disposable deployment verifies actual Runtime behavior; the smaller RC
preparation fixture alone is not proof of the real Runtime executor. All
test-owned containers, volumes, networks and candidate image tags are cleaned.
The pre-existing human acceptance deployment is preserved. This report closes
the legacy Skill release defect, not unrelated open-source review items or
unimplemented Stage 4 services.

The documentation scan excludes preserved upstream excerpts under
`docs/research/**/upstream/`. An unfiltered scan stops at the rmcp upstream
README's `../rmcp-macros` reference, which targets a sibling package in its
original repository rather than this excerpt. No upstream snapshot is rewritten
as part of the first-party release cleanup.

## Integration regression correction

The first current-image real-Agent restore run passed all business checks
(eight databases, four persistent volumes, two restored Agents and four
completed Runs), but its Trace gate failed. The older command/replay inspector
forbade all Runtime contact. The current
[Skill command contract](../contracts/agent-acp/skill-commands.md) refreshes the
catalog during Session setup and after command completion, through discovery
and the Runtime information resource. This is an existing read-only path, not
model inference or a Tool invocation.

The integration inspector now distinguishes this catalog read from execution.
It requires the request → ACP HTTP client → Runtime HTTP server → MCP operation
chain, allows only `discover` and `resources/read` on the applicable successful
Session paths, and requires complete, nonduplicate spans. Tools, model and
credential calls, unrelated/detached reads and rejected-access reads still fail.
The evidence separately reports information reads and absence of model/Tool
execution. New positive and negative fixtures were run red before the correction;
the expanded 552-check acceptance-source regression then passed with no skips.
No ACP or Runtime business implementation was changed to accommodate this gate.
