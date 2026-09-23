# Cache source exit

2026-09-23 status: **cache-source migration and final integration audit complete**.
The objective is to remove every project test source and lasting asset from
cache after checking its destination. `.cache` is not a staging area. The five
allowed roots hold reproducible dependency/compiler caches only.

The earlier [test-layout batch](test-layout-migration.md) established the main
service-unit/root-integration/E2E layout. It did not prove equivalence of every
historical cache script. This follow-up retains that larger completion boundary.

## Verified removals

All removals use the private `migrations.jsonl` ledger under
`artifacts/verification/cache-source-exit-20260922/`: verify source and destination,
record hashes, then remove that individual source. Frozen source history is
permanent, versioned provenance under `tests/e2e/history/`, outside executable
test discovery; it is not a temporary holding area or a new passing test result.

| Batch | Current result |
| --- | --- |
| Durable data | 3,874 logs, traces, baselines, screenshots and backups moved byte-for-byte to `artifacts/verification/`. |
| Retired/upstream sources | Thirteen upstream research assets, 30 retired source/configuration snapshots and four duplicate candidate-source copies left cache after verification. |
| Ordinary wrappers | 45 originals removed; five unique historical contents retained. Current command runner preserves the explicit timeout/grace parameters. [Map](../tests/support/migrations/cache-wrappers.json). |
| Summaries | Eleven originals removed; four current tools preserve their distinct diagnostic scopes. [Map](../tests/support/migrations/cache-summaries.json). |
| Queues and manifests | Four wrapper originals and two cached manifests removed. Twenty-three formal templates preserve 273 rows, including the 21 previous queues with 259 rows. [Suite guide](../tests/suites/README.md), [map](../tests/support/migrations/suite-manifests.json). |
| Dependency launchers | Seven originals removed after resolving database-variable, cwd, timeout and Docker opt-in differences. [Map and evidence](../tests/support/migrations/cache-dependencies.json). |
| Build definitions | Three frozen candidate Dockerfiles removed from cache. Current owning Dockerfiles retain their final stages and include relocated integration tests. [Map](../tests/support/migrations/cache-builds.json). |
| Progress interruption | Original removed after a real SIGTERM run: fixture exit 143, both Docker label scopes empty, no captured descendants or original process-group members before harness fallback. Trigger and exit deadlines remain 160/150 seconds. |
| Process observers | SDK and Commands originals removed after 27 Python contracts, actual Docker observations and an unchanged environment check. Commands business and all 40 topology checks passed; 19 strict failures and Make exit 2 remain visible. |
| Identity diagnostics | Original shell variant removed after its full three-service log capture was incorporated into the Stage 3 entry and verified before teardown. |
| Offline checks and HTTP collectors | Six originals removed after validating five formal entries; the two HTTP observers share one entry. The [diagnostic map](../tests/support/migrations/cache-diagnostics.json) now covers all ten removed diagnostic sources. |
| Cleanup/environment checks | All 29 originals verified and removed; 25 unique frozen contents retained. The new [cleanup entry](../tests/support/verification/cleanup.py) preserves eight baseline schemas and all profile-specific resource, process, image and Trace assertions. [Map](../tests/support/migrations/cache-cleanups.json). |
| Development final/restart | Runtime, Temporal and Controller final checks plus Controller idle restart verified and removed. [Development map](../tests/support/migrations/cache-development.json). The later deployment rows below record their separate completed gates. |
| Development read-only drivers | Five Agent-state, three chat-Trace review and one rejection-Trace originals verified and removed. Three formal entries preserve the original assertions and custom Agent snapshot names. The development map records all nine sources. |
| Development Session replay | Both Runtime/Temporal replay originals verified and removed. The common SDK entry preserves ordered history, decoded Tool data/file diffs, four-table counts and actual request/connection Trace binding. |
| Development recovery | The Controller recovery original is verified and removed. The explicit entry retains one rebuild, operation/readiness checks, full workspace/configuration retention and the original Trace oracle. Unused publication code is preserved only in the source archive. |
| Development ordinary lifecycle | Three Controller/Temporal originals are verified and removed. The shared entry preserves five operations, four absence probes, workspace retention, cleanup and three independent publications. Three historical reports match with all fifteen lifecycle strict failures retained. |
| Development Runtime loss | The Runtime source-missing original is verified and removed. The separate entry preserves normal stop, exit-zero/no-OOM checks, exited/absent/offline observations, generation-bound rebuild, five absence probes and the original six report checks. |
| Development metadata browser | Original verified, archived and removed. The formal driver retains two-page metadata, list/reload/history without prompt replay, audio rejection and composer recovery. Three outputs are exclusive/private; normal interruption saves a failed report. |
| Development Runtime deployment | Original verified, archived and removed. Four modes retain global container assertions, four-table row maps, database backups and the full workspace digest. Bound identities and failure recovery pass component and isolated Docker checks. |
| Development Temporal deployment | Original verified, archived and removed. Five modes, dependency-ordered stops/start/recovery, four archives, old/new healthcheck transition and exact data/workspace preservation pass component, Docker and historical checks. |
| Development Controller 20260917 deployment | Original verified, archived and removed. Both service orders, exact final business assertions, unchanged non-target Runtime ID and isolated failure recovery pass component, Docker and historical compatibility checks. |
| Development Controller 20260921 deployment | Original verified, archived and removed. Running-container scope, three archives, original-row preservation with additions, and one explicitly bound Runtime rebuild pass component, Docker and legacy compatibility checks. |

The second wrapper batch and three fixed dependency profiles have explicit
configuration. No old personal Node installation or implicit retained image tag
is selected. Historical exit 2 remains nonzero. Queue resource checks still run
after business failure. Pause markers prevent launching the next child.

## Verification for this checkpoint

Commands ran serially. The evidence directory above contains the original
failures and corrected runs; failed attempts are not counted as passes.

| Gate | Evidence |
| --- | --- |
| Command/suite, manifest, dependency, image-input and storage contracts | All 48 combined `queue-dependency-storage-contracts` checks passed, including ten actual CLI configuration-rejection checks. |
| Persistence PostgreSQL | 20 tests passed, zero skipped, using the new disposable ACP service-owned database. Cleanup passed. |
| ACP SDK audit | Nine tests passed with its separate service-owned audit database. Cleanup passed. |
| Controller workflow profile | Three packages, 176 tests and 119 subtests passed, zero skipped, with disposable PostgreSQL/Temporal and initialized namespace. Cleanup and environment comparison passed. |
| Runtime inspect profile | Twelve packages, 204 tests and 177 subtests passed, zero skipped, including both installed-image checks. Cleanup and environment comparison passed. |
| Runtime repository profile | 29 tests and 16 subtests passed, zero skipped. This profile does not trigger crash E2E. Cleanup and environment comparison passed. |
| Standalone image contract | Both real Docker image tests passed, zero skipped. |
| Offline summary replay | Eleven project summaries, two cost reports, 44 parsed-log reports and 40 audit reports preserved their diagnostic fields. |
| ACP script lint | Four relocated scripts passed the inherited lint configuration. |
| Container entry paths | Corrected four paths in three launchers to their `/app/tests` mount. An isolated no-network container verified all four paths and Node syntax. This is not a fresh business run of those three profiles. |
| Final environment | `observers-environment-final.json.comparison.json` reports unchanged twelve retained containers, 271 volumes, fourteen networks and pinned images after the latest four isolated profiles. `observer-docker/final-isolation.json` also verifies sixteen required image references and no owned processes remaining. |
| Offline evidence contracts | 87 checks passed, zero skipped: twelve new CLI contracts plus existing storage, migration and Trace oracle checks. Empty/misspelled audit profiles, bad Jaeger URLs and cached leaf-file aliases fail explicitly. |
| Historical evidence replay | Lifecycle audit (3 interrupted + 16 foundation traces) and original two-window crash report match saved JSON exactly. A second two-window crash report also passed its scoped oracle; both strict results remain failed. Ten original document targets passed the relocated link checker. |
| Observer contracts | All 27 Python configuration/process checks and twelve Stage 3 cleanup contracts passed, zero skipped. Active TERM must actually be delivered; fixture timeout remains failed with null exit code; fallback cleanup cannot erase earlier residue. `make test-verification-python` is included in the default Node/tooling gate. |
| Actual observer regressions | SDK: four scenarios and two state/log captures passed. Commands: three transports, 40 topologies, five service logs; 19 strict failures and exit 2 preserved. Progress: real SIGTERM, fixture exit 143 and empty resources/processes before fallback. Identity: sixteen checks, ten topologies, three-service private log; two strict failures and exit 2 preserved. |
| Cleanup contracts | Thirty cleanup checks passed; the complete Python tooling gate passed 57 tests with process access. The sandboxed attempt failed on denied `ps`/process-group operations and remains recorded. No fixture processes remained before retry. |
| Cleanup replay | All 29 historical JSON reports match, except the explicitly removed Temporal `local_tests` constant. Saved raw network/shutdown/Temporal Traces retain original parent/warning/error semantics. Docker responses are baseline-reconstructed fixtures, not fresh historical cleanup evidence. |
| Actual cleanup integration | All 29 CLI profiles passed with real Docker/`ps` and synthetic input logs/Traces; a real owned-container residue correctly failed without writing a passing report. The isolated probe was removed. Twelve retained containers, 271 volumes, fourteen networks and all listed image references/IDs stayed unchanged. |
| Development contracts and replay | Eighteen new configuration/final-entry checks passed; the complete Python gate passed 75 tests. Both historical summaries and 18 saved raw Traces replay identically, preserving strict failures. Temporal replay uses its saved deployment inspection; its latest restart inspection was not saved, so that historical cutoff is not claimed. |
| Development disposable Docker | Runtime/Temporal final CLIs passed with real Docker/ps and synthetic business/Trace reports. A renamed publication before the live start cutoff failed as required. Idle restart passed normal exit zero, unchanged container ID and recovered health. Both disposable containers were removed; retained resources/images were unchanged. |
| Controller final contracts | Eight entry contracts and one nested-workspace-mount contract added; the complete Python gate passes 84 tests. Saved Controller browser/Agent/Trace-review reports pass the new identity contracts and retain their original summary fields, including one strict failure. Historical SQL and workspace bytes were not re-executed. |
| Controller final Docker | Actual PostgreSQL queries and Runtime/volume reads pass two positive and eleven expected-failure cases using synthetic acceptance inputs. Owned containers/volume removed; twelve retained containers, 271 volumes, fourteen networks and image identities unchanged. This is not a new browser or ACP business acceptance. |
| Development read-only contracts | All 64 combined configuration/storage/Trace-oracle/CLI checks pass, including 22 actual command-line cases with local HTTP fixtures. FIFO configuration, bad identities, duplicate Traces and cached output aliases reject. The new HTTP integration gate is included in `make test-node`. |
| Development read-only replay | Thirteen saved Agent reports match except the current `checked_at`; four chat collections containing thirteen raw Traces and one rejection Trace match their saved reviews exactly. Four strict failures remain. Agent HTTP replies are reconstructed from saved reports and use fixture credentials; no live Gateway/Jaeger acceptance is claimed. |
| Replay contracts | All 82 combined configuration/storage/HTTP/SDK/history/Trace checks and seven owned-runner checks pass. The integration driver uses the existing process-group runner. Raw Trace polling safely updates only files created by its own writer. |
| Replay Docker and historical baseline | Two synthetic success cases, seven expected failures and two original PGDMP restores pass with actual PostgreSQL and the pinned SDK. Each historical case preserves 71 messages, 69 notifications and its exact report; Runtime strict stays failed, Temporal stays passed. HTTP/WebSocket/Jaeger are local adapters, with saved Trace links rebound to the actual new connection/request. The owned database is removed and retained resources/images are unchanged. |
| Shell storage preflight | All 49 storage/CLI/Shell/retained-entry checks pass. Seven child checks now precede setup; Stage 2 validates both evidence roots and Stage 3 validates the selected host evidence before network discovery. Invoking the storage CLI through a symbolic link still runs validation. Fixtures block Docker, network discovery and temporary setup; this gate does not redeploy services. |
| Recovery contracts and Docker | All 79 related checks and ten real Docker cases pass: a synthetic success, eight expected failures and the original workspace tar/report/Trace replay. Historical strict failure remains. Owned containers/volumes are removed; retained resources and images are unchanged. |
| Ordinary lifecycle contracts and Docker | All 118 related checks and nine Docker cases pass, including three exact historical report replays and five expected failures. Actual owned Runtime shell containers/volumes use local Gateway/Jaeger adapters; retained resources and images are unchanged. This is not deployed Controller business acceptance. |
| Runtime-loss contracts and Docker | All 159 related checks and seven real Docker cases pass: two successes including exact historical report replay, and five expected failures. A normal TERM exit 7 is rejected before rebuild. The historical five lifecycle strict failures remain. Owned shell containers/local HTTP adapters do not claim deployed Controller business acceptance; retained resources/images are unchanged. |
| Identity/Foundation storage entry checks | All 335 shared tooling, Identity and related Foundation checks pass. Dangling aliases reject, known output files are checked before requests, and three access clients plus all ten Foundation profiles reject invalid evidence paths before their first external action. The CLI checks block database/network/Docker calls and include durable-path controls; they do not repeat deployment business acceptance. |
| Metadata browser | `metadata-related-final` passes 239 related checks; `metadata-reviewed-contracts` passes 44 focused checks after fixture storage review. `metadata-browser-final` passes nine real UI/Chromium cases: two successes including historical report compatibility, and seven expected failures. |
| Runtime deployment | `runtime-deployment-python-final` passes 95 support and 18 stateful entry tests. `runtime-deployment-docker-final` passes five owned-resource cases, including normal deployment/restart, backup failure, candidate exit and find/hash failures; cleanup and full environment comparison pass. |
| Controller 20260921 deployment | `controller-deployment-python-reviewed` passes 95 support and 30 integration tests; 12 focused Controller tests also pass after extracting the shared snapshot oracle. `controller-deployment-docker-first` passes six actual cases with cleanup/isolation; `controller-deployment-history` preserves exact legacy snapshot/report fields and the historical strict failure. |
| Controller 20260917 deployment | `controller17-deployment-python-final` passes 96 support and 38 integration tests. Nine actual dual-service Docker cases and legacy compatibility pass; the shared 20260921 driver also passes six rerun Docker cases and its legacy comparison. |
| Temporal deployment | `temporal-deployment-python-reviewed` passes 96 support and 50 integration tests; eight actual Docker cases and `temporal-deployment-history-first` pass. The global after negative and missing latest historical after/restart inspect are stated explicitly. |
| Migration ledger | All 4,057 completed transfers have paired verified/removed records, absent originals and matching destination hashes; 0 scripts remain. |

Cleanup evidence is in `cleanup-python-process-access.result.json`,
`cleanup-historical-replay-final/comparison.json`, and
`cleanup-docker-normalized/{result,isolation}.json`. The first actual run's final
environment comparison failed because Docker reordered two Mounts lists; every
mount field was identical. The comparison now normalizes order, and the rerun
passed. This failure remains in `cleanup-docker/`, not counted as a passing gate.

The cleanup checker also rejects incomplete baseline keys and inspection-count
mismatches, which old `zip` comparisons could miss. Process matching adds formal
paths and Python version suffixes, excluding only the checker and its actual
ancestor chain in addition to the historical profile exclusions. Explicit
projects retain their original name families. Network/Shutdown Trace directories
are bound to the projects in `docker-2.log`/`docker-3.log`. Final drift reports
retain original Mounts order even when comparison normalizes it. Temporal's
hardcoded local-test totals are provenance only and no longer presented as proof.

Development evidence is in `development-python-final.result.json`,
`development-contracts-green.result.json`,
`development-finals-historical/comparison.json` and
`development-final-docker-verified/{result,isolation}.json`. The final-check
entries require five lifecycle kinds, three publications and one replay with
nine unique files/trace IDs and report/Agent/request correlation. Publication
cutoff applies to the group, not a configurable filename prefix. Process
selectors cannot be disabled by configuration, recognize normalized and bare
entry filenames, and exclude the actual checker/ancestor chain. The idle-restart
gate operated only on its owned fixture, not a retained Controller.

Controller evidence is in `controller-final-python.result.json`,
`controller-final-historical/comparison.json` and
`controller-final-docker/{result,isolation}.json`. All original final-check
assertions remain, including the database-wide active-Run check and rejection
Tool-call IDs having no attempt anywhere. Added identity checks bind saved
reports to the Session, Agent and Runtime; the marker must resolve within the
complete expected RW workspace volume without shadowing nested mounts.

Read-only MJS evidence is in `development-read-contracts-final.result.json` and
`development-read-historical/comparison.json`. The shared preflight validates
ordinary input files, HTTP origins, credentials, identities, count bounds and
all report leaves before HTTP. Reports use exclusive private writes with a
second path check. `reportBasename` preserves before/intermediate/final Agent
snapshots without overwriting existing evidence. These entries do not invoke
Docker; their integration evidence uses actual CLI processes and local HTTP.

Replay evidence is in `development-replay-contracts-final.result.json`,
`development-replay-owned-runner.result.json` and
`development-replay-docker-final/{result,isolation}.json`. The saved database
baseline comes from original backups, not reconstructed notifications. The
driver validates Session ownership and parses encoded history before login/load;
the original global four-table count comparison remains. Raw Trace convergence
still needs three samples, with intermediate snapshots preserved. The test
fixture does not recheck historical credentials or claim service deployment
acceptance. Docker isolation proves the completed run; no whole-harness
interruption acceptance is claimed from that comparison alone.

The offline replay found five stale historical log hashes: Commands diagnostic,
Multimodal final, Slash commands confirmed/final and Stage 3 final. Their parsed
objects still match; the new summarizer's hashes match the actual saved logs.
The original reports remain untouched and the differences are recorded in
`summary-replay-v3/comparison.json`. This check does not retroactively validate
those stale hashes or make a fresh business/strict-Trace acceptance claim.

## Remaining work

No project test source or lasting asset remains in `.cache` outside the five
reproducible cache roots. All 25 development source entries are verified,
archived and removed; the `pending` list in
[`cache-development.json`](../tests/support/migrations/cache-development.json)
is empty. Source migration and the final integration follow-up are complete.
The final section records the storage, regression, ledger and environment evidence.

- No retained-service deployment or restart has been replayed for this migration.
- Runtime missing-container recovery now passes 22 flow tests, the full 96-support/54-integration Python gate and six real Docker cases.
- Final storage enforcement and shared regression audit pass, including temporary-directory aliases, existing Shell output leaves and compiler/dependency cache layouts.
- No cache-migration work remains. Historical strict Trace failures and upstream deferrals keep their separate recorded scope.

## Earlier checkpoint notes

The following notes retain their historical scope and intermediate failures.
Later checkpoints supersede their pending counts.

The offline diagnostic portion has `offline-evidence-contracts` and
`offline-evidence-replay/comparison.json` evidence. HTTP event capture and trace
fetching were exercised with synthetic diagnostic events and a replaced fetch;
the 6-second export wait and 5-second request deadline are preserved. These two
collector contracts do not claim a current Jaeger query. The separate four live
profiles are recorded under `observer-docker/`; no retained-container restart or
service image replacement occurred. Historical strict Trace failures remain
unchanged, and new strict failures remain nonzero.

Shell preflight evidence is in `storage-shell-preflight-final.result.json`
(49 passing checks). Earlier failures remain in `storage-shell-preflight-red`,
`storage-shell-preflight-green`, and `storage-cli-alias-red` logs. They exposed
late checks and a CLI entry detection bug when Node resolved a symbolic path.
The shared storage CLI now compares resolved entry paths before validation.

Recovery evidence is in `recovery-contracts-final.result.json` and
`recovery-docker-final/{result,isolation}.json`. The historical 284-span Trace
and report first match without modification; the isolated CLI then rebinds only
Agent identity and restores original workspace bytes and their exact manifest.
Fixture read permissions are adapted to its unprivileged checker. Real Docker
cases prove hash/read and directory-traversal errors propagate, and reject
changed volumes/bytes, unchanged containers, bind/read-only mounts and tmpfs
shadowing. These are shell-container/local-HTTP fixtures, not deployed-service
recovery. The original cache source was archived with its hash and then deleted.

The initial `recovery-docker/` run failed: tmpfs submounts were not visible in
the checked Mounts list and the chosen image's anonymous volumes were left by
plain `docker rm`. The checker now also reads `HostConfig.Tmpfs`; the fixture
uses `docker rm -v` after normal exit zero. Eighteen proven new unused anonymous
volumes were removed, with restoration recorded in `cleanup-repaired.json`.
The fresh final run passed and compared the entire retained environment unchanged.

Ordinary lifecycle evidence is in `lifecycle-contracts-final.result.json` and
`lifecycle-docker-final/{result,isolation}.json`. Configuration and output leaves
are checked before HTTP; created Agent and full Runtime identity/scope/RW volume
are bound before marker writes. Resolved marker paths must stay inside workspace
and outside cache. Publication/lifecycle Trace IDs and lifecycle request IDs are
distinct. The corrected publication root selector replaces the oldest unfiltered
selector. Raw publication evidence is still saved after structural checks and
before rejecting unexpected warnings. Historical Trace timestamps/warnings stay
unchanged; only temporary Agent identity is rebound in the isolated CLI.

Runtime-loss evidence is in `runtime-loss-contracts-final.result.json` and
`runtime-loss-docker/{result,isolation}.json`. Both snapshots are read before
HTTP/Docker; Compose project/service/scope bind the restarted Controller name,
full ID, labels and environment. Scope is derived from Compose without adding a
caller field. Publication search keeps its 120-second polling window, selects
three distinct roots after the validated cutoff, rechecks detail timestamps and
rejects IDs already used by lifecycle operations. App and management replies
must match the temporary Agent. Runtime name/full ID/scope/RW workspace binding
and actual marker-path checks precede mutation. The original generation 2→3,
five absence probes, report and strict warnings replay exactly. Actual loss
observations come from owned shell containers; Controller/Jaeger HTTP is local
fixture behavior. The original cache source was then archived and deleted.

Identity evidence writers and early Foundation output checks now use the shared
storage guard. `durablePath` uses `lstat` while walking ancestors, so dangling
leaf/ancestor links cannot bypass validation. Raw snapshots may still update
ordinary files, with type checks before truncation and mode 600 writes that do
not follow leaf links. Three access clients preflight before seed reads, login
or database creation; Foundation preflights the full generated project path
before Docker discovery. Evidence is in `storage-identity-foundation-final`
(335 passing checks). Earlier red attempts remain recorded; two entry-fixture
loader corrections were required before the final red run proved 18 failures
and four valid-path controls.

Go crash storage checks now pass six tests and nineteen subtests in
`crash-storage-reviewed-contracts`. Parent evidence/TMPDIR, child job inputs,
physical-effect journals and diagnostic leaves are checked before external
operations. Raw parent segments reject before normalization; the storage tests
also use guarded temporary directories. Regular output writes remain private,
and effect journals retain append plus Sync. Earlier red evidence, including the
TMPDIR traversal failure, remains recorded.

`crash-storage-reviewed-docker/{result,isolation}.json` passes all four original
Runtime update process-exit boundaries with the production service and dedicated
PostgreSQL/Docker fixture. Each retains generation two, 2 create/2 start/1 stop/1
remove effects, workspace preservation and unchanged terminal replay. All four
reports have mode 600; retained resources and every image tag remain unchanged.
This checks the service component, not public Controller/Temporal acceptance.

At that earlier checkpoint, two deployment entries remained and
`make test-storage-policy` correctly failed. Ten env/secret-file CLI inputs
already rejected cached files. The nineteenth checkpoint below supersedes
that source count and storage result; working-tree changes remain uncommitted.

Runtime deployment evidence is in `runtime-deployment-python-final.result.json`
and `runtime-deployment-docker-final/{result,cleanup,isolation}.json`. Its new
`before` captures a private hashed context; later modes reject changed baseline
bytes/configuration, reread effective Compose and bind live full container IDs.
Mode-specific report and backup conflicts reject before commands. Database
archives are private/exclusive and restored for listing through the same open
descriptor. Whole-workspace traversal/hash errors propagate; an empty manifest
still hashes zero bytes. Counts in the final report come from observed values.

The stateful component gate executes `before → deploy → after → restart → after`
with an unrelated-project container. It checks original global/resource/data
assertions and stop, archive, promotion, health, report and normal interruption
failures. Recovery restores known containers and retains the original failure;
Compose observation errors cannot replace it. The real gate uses owned shell
Controller/Runtime containers, PostgreSQL and a workspace volume. It proves
three actual archives, normal exit-zero restart, old-image/service recovery and
find/hash error handling. Full positive global `after` is component evidence:
on the shared daemon it correctly fails because retained containers are stopped.
No retained container was started to satisfy that assertion. All twelve retained
containers, 271 volumes, fourteen networks and image references remain unchanged.
The first Docker attempt failed because the PostgreSQL image's default SIGINT
did not match the shell fixture's TERM handler; the fixture now selects SIGTERM.
That failed attempt remains recorded and also passed cleanup/isolation.

Controller 20260921 uses a separate contract: the original `docker ps` selects
all running containers, including other projects, and original ACP rows must
remain byte-equivalent while new rows are allowed. A fresh context binds
configuration, effective Compose, full/safe snapshots and the three checked
archives. The configured workspace and five-field recovery record permit only
the named Runtime's full-ID replacement with the same RW volume; preserved
flags must be true. These fields do not prove generation, business execution ID,
or a new successful Trace. Report counts are computed from checked containers.

The six real cases in `controller-deployment-docker-first` cover the full
before/deploy/after/final chain, a real Runtime rebuild preserving workspace,
invalid recovery, changed original rows, failed backup, failed candidate start,
and failed creation after normal old-container removal. The last failure is
injected by an owned-fixture shim that checks full ID/name/project/service before
removal. Recovery recreates the old image but keeps the deployment failed.
The fixture includes a separate project's running container; all retained
containers, volumes, networks and image references compare unchanged afterward.

`controller-deployment-history/comparison.json` proves legacy safe-snapshot and
report-field compatibility plus static full-inspect identity. Historical
`containers-after.json` predates recovery and remains an expected failure under
the later source's recovery requirement; `containers-final.json` passes. The
saved full inspect has only one running container and zero healthy containers,
so it cannot become a new healthy baseline. No Compose/context snapshot or live
SQL/workspace replay is invented. The saved recovery strict failure is retained.

Metadata evidence is in `metadata-related-final.result.json`,
`metadata-reviewed-contracts.result.json` and `metadata-browser-final/result.json`.
The driver checks its full configuration and three output leaves before starting
Chromium, binds the workspace URL to its Gateway/Agent/Session, and writes PNG
buffers with exclusive mode-600 files. A failed earlier browser Trace report is
still accepted as an identity source. Normal SIGTERM interrupts memory polling
and saves `Interrupted`; close failures also preserve the failure report.

The integration fixture serves a real production UI build over local HTTP/ACP,
requires a fresh durable output directory before building, and checks actual SDK
requests and screenshots. Optional `--history` enables exact historical report
compatibility; no original browser frame/DOM recording exists for full historical
message replay. Earlier dev-server attempts failed because HMR repeatedly
reloaded the page; these failed logs remain. A separate red interruption case
hit its deadline before the fix. The final nine-case gate has no timeout or
forced kill. No Provider or retained service was used. Environment comparison
and owned-process checks pass; the original was then hashed, archived and deleted.

Controller 20260917 retains both Controller modes in either order, without a
Runtime replacement exception. The shared driver binds completed siblings to
their deployment records and recovers only the currently failed target. Final
acceptance keeps exactly three completed Runs, three settled attempts and two
schema rejections, byte-exact workspace markers, equal Agent snapshots, six
resource probes and no verification children. Private final outputs are written
only after all assertions pass. Its workspace path check rejects cache both
before and after symlink resolution.

`controller17-deployment-docker-first` passes nine cases, including both orders,
backup failure, each target's candidate exit and missing-container recovery.
The shared single-service profile passes six cases in
`controller21-deployment-shared-docker`; both cleanup/isolation results preserve
12 containers, 271 volumes, 14 networks and all image references.
`controller17-deployment-history` retains the original browser Trace failure and
five lifecycle strict failures; `controller21-deployment-shared-history` also
passes. These comparisons do not replay historical live SQL or workspace data.
The earlier `controller17-deployment-python-reviewed` observer process-group
probe returned PermissionError. Its descendants were confirmed absent; all
16 observer tests and the final complete 96-support/38-integration gate passed.
The failed evidence is retained and no process utility behavior was changed.

Temporal deployment is now archived and removed. `temporal-deployment-python-reviewed`
passes 96 support and 50 integration tests, including twelve Temporal methods.
`temporal-deployment-docker-final` passes eight actual cases: the normal
before/deploy/restart/resume chain, preserved global-after rejection for retained
stopped containers, backup and candidate failure recovery, each missing target,
and propagated workspace find/hash failures. Four actual PGDMP archives and a
complete two-file workspace manifest match their independently checked bytes.
Old Temporal recovery uses its saved probe, since the old image lacks the new
readiness script. Owned containers, volume and candidate image are removed;
12 retained containers, 271 volumes, 14 networks and all image references match.
`temporal-deployment-history-first` validates the actual healthy historical
baseline/deployment records and all four original archive digests. It retains
an earlier Compose-start failure and the saved resume/restart outcomes. There is
no latest after/restart full inspect or raw final SQL/workspace data to replay;
no synthetic historical after snapshot is constructed. Runtime's separate
missing-container recovery and final integration remain pending.

The nineteenth exit checkpoint passes `make test-storage-policy` with no cache
violations. `checkpoint-nineteen-ledger-audit.json` verifies all 4,057 paired
transfers (8,114 rows), absent originals and exact destination hashes. It also
removes 346 empty task directories; `.cache` now contains only `go-build`,
`go-mod`, `golangci-lint`, `npm` and `rust-build`. This is the source/storage
checkpoint; the explicitly pending integration work above is not marked complete.

## Final integration follow-up

Runtime missing-container recovery is now verified. `runtime-missing-flow-red`
records the original gap; `runtime-missing-flow-green` passes 22 entry tests,
`runtime-missing-python` passes 96 support and 54 integration tests, and
`runtime-missing-docker` passes six real Docker cases. Recovery requires two
successful exact-name absence checks, unchanged effective Compose and all other
baseline IDs/names. It recreates only the old image and preserves the original
failure. Unknown replacements and failed queries cannot authorize recreation.
The real fixture uses a normal exit and removal, preserves other containers and
the workspace volume, and leaves the retained 12 containers/271 volumes/14
networks and all image references unchanged.

The final policy review found and repaired three entry gaps: cached `TMPDIR`,
existing Shell output leaves linked into cache, and ordinary project files
hidden under an allowed cache-directory name. Shell preflight now checks the
temporary root and existing output tree. Restore checks backup/manifest/key and
volume-archive leaves before Docker. The cache scanner recognizes the current
Go module/object, lint, npm and Cargo layouts, retaining upstream dependency
tests and generated Cargo sources. It rejects cache-root and descendant links.
This is a layout guard; it does not claim cryptographic authentication of every
compiler output or every upstream module file. Eight current E2E guides now use
`artifacts/verification/` for evidence.

`storage-final-preflight-red` preserves 31 expected pre-fix failures;
`storage-final-preflight-green` passes all 71 selected tests. Cache-layout red
runs and the initial real-cache rejection preserve the refinement history;
`cache-layout-reviewed` passes its six tests and
`cache-layout-current-reviewed` passes the actual storage gate. Additional
restore-TMPDIR and dangling-root assertions are included in the final Node gate.

The full Node gate exposed a recurring process-probe `PermissionError` and an
outdated Stage 3 dispatch stub. The former now requires an exited direct child
and a successful process snapshot with no live group members before accepting
absence; live/unknown state remains failed. Three probe contracts and a real
observer descendant case cover it. The latter executes the real storage check
and limits its stub to network/time inputs; all 17 dispatch scenarios pass.
The failed `cache-exit-node-final` and `cache-exit-node-reviewed` runs remain
recorded. The first failure left no descendants, verified in
`final-node-failure-processes.json`.

`final-ledger-mapping-audit.json` verifies all 4,057 transfers/8,114 paired rows,
134 mapped source archives and formal entries, 23 suites/273 rows, and 85
referenced evidence paths. Every original is absent and every archived
transfer destination retains its exact SHA-256 and byte count.

`cache-exit-node-final-verified` passes the complete `make test-node` gate:
1,841 Node tests, 1,369 Vitest tests and 154 Python tests, totaling 3,364 passed.
Five existing PostgreSQL opt-in cases remain explicitly skipped in this default
gate; they are not counted as passes. `cache-exit-storage-final` passes the actual
cache scan and four configuration checks. `final-environment.json` matches all
12 retained containers, 271 volumes, 14 networks and 44 image references/IDs.
`final-processes.json` contains no remaining test processes. The final document
link and whitespace checks are recorded separately. No retained service was
deployed or restarted, and no commit was created by this migration closeout.
