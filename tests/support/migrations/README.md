# Cache source migration records

`cache-wrappers.json` records the 45 reviewed ordinary command/Make wrappers.
It is a provenance map, not an executable suite or a claim about the remaining
cached sources. Original bytes are deduplicated by SHA-256 in the permanent
history archive; current behavior lives in the specified formal runner.

Run a mapped command from the repository root with Node on `PATH`:

```sh
node tests/support/run-command.mjs --output artifacts/verification/example --name check --timeout-ms 1200000 --grace-ms 180000 -- make TARGET
```

Use each mapping's `grace_ms`; 14 wrappers used 30 seconds and 31 used 180 seconds.
For an argument-vector wrapper, replace `make TARGET` with the original command
and arguments. The original log filename becomes `--name` without `.log`.

The current entry is deliberately not CLI-compatible with the removed Python
files. It uses explicit durable output paths, JSON results, private child umask,
ignored stdin, and inherited toolchain PATH. Both SIGINT and SIGTERM produce
incomplete status 130. Timeout remains 124. It also cleans children left behind
by a successfully exited parent. No source-specific business assertion was
present in these 45 wrappers.

The two final-regression command wrappers and two queues were subsequently
verified and removed. `cache-queues.json` and `suite-manifests.json` record their
Compose environment, pause marker and 21 historical task lists; current templates
live under `tests/suites/`.

`cache-diagnostics.json` records all ten completed diagnostic source removals and
nine formal entries. The two identical HTTP observers share one entry. Twelve
CLI contracts and historical lifecycle/crash replay preserve the original
selection, assertions and strict-failure output. A further 27 Python and twelve
Stage 3 cleanup contracts cover process ownership and Identity's private log
hook. SDK, Commands, progress interruption and Identity were also run against
isolated Docker projects; Commands/Identity strict failures remain nonzero.
Resource/image comparison and the owned-process scan passed after all four.

`cache-cleanups.json` records all 29 cleanup/environment originals, their 25
unique frozen contents, the formal profile and explicit historical inputs.
Thirty cleanup contracts and the full 57-test Python gate passed. All 29 saved
reports replay identically apart from Temporal's unverified hardcoded
`local_tests` field. That replay uses baseline-reconstructed Docker responses;
lower4 baselines omit Running and assume true only within the fixture.

The separate opt-in `tests/integration/verification/cleanup-docker.py` gate
passed all 29 CLI profiles using real Docker/ps and synthetic log/Trace inputs.
A real owned-container residue returned nonzero, then the probe was removed and
the retained environment compared unchanged. These results verify the migrated
checker, not the historical business run or a new retained-service deployment.
Usage and intentional contract improvements are in the
[verification guide](../verification/README.md#historical-cleanup-contracts).

`cache-development.json` is verified-and-removed: twenty-five completed entries cover four
Python final/restart sources, nine read-only MJS sources, two SDK Session
replay sources, one recovery source, three ordinary lifecycle sources and one
Runtime-loss lifecycle source, one metadata-browser source and one Runtime
deployment source, two Controller deployment sources and one Temporal deployment source.
Their contract, historical and applicable isolated Docker
evidence is listed in that record. Historical strict failures remain unchanged;
no retained-service restart or deployment occurred. The ordinary lifecycle batch
passes 118 checks in `lifecycle-contracts-final` and nine cases in
`lifecycle-docker-final`: four successes including three exact historical report
replays, and five expected failures. All fifteen historical lifecycle strict
failures are retained. Its Docker cases use owned shell Runtime containers and
volumes plus local Gateway/Jaeger fixtures, not a new real-service business
acceptance. The twelve retained containers, 271 volumes, fourteen networks and
images stayed unchanged. The Runtime-loss source is also verified, archived and
removed: `runtime-loss-contracts-final` passes 159 related checks, and
`runtime-loss-docker` passes seven actual Docker cases with matching isolation.
Two successes include one exact historical report replay; five expected failures
include TERM/exit 7 rejected before rebuild without SIGKILL. The normal path
observes exit zero, exited state, removal and absent state before rebuild from
generation two to three, retaining five absences and six checks. Its five
historical lifecycle strict failures remain unchanged. Shared snapshot preflight
binds identity/cutoff and derives scope from Compose without a new caller field.
The gate uses owned shell Runtime containers/volumes and local Gateway/Jaeger
fixtures; retained resources/images remain unchanged and no new real-service
business acceptance is claimed. The overall ledger records 4,057 transfers and
8,114 rows. No development source originals remain in cache; all 25 entries are verified
and the pending mapping is empty. Final integration and storage enforcement pass.
Completion evidence is recorded in the
[cache exit report](../../../docs/cache-source-exit.md#remaining-work).

Metadata browser migration passes 239 related checks, 44 final focused contracts
and nine real UI/Chromium cases, including exact historical JSON compatibility
and normal interruption report preservation. The original is hash-archived and
removed. Actual SDK traffic uses a local ACP fixture; original browser frames
were not available and no retained service or Provider was used. Source and
private evidence locations are recorded in `cache-development.json`.

Runtime deployment now passes 95 support tests, 18 stateful entry tests and five
owned-resource Docker cases. Its original is archived and removed. The driver
retains whole-daemon checks, exact four-table maps, three database archives,
workspace hashing and normal restart; failure recovery preserves the original
error. The real gate exercises shell services/PostgreSQL and keeps global
`after` failed for stopped retained containers. Its full positive global path
is component evidence, not a new retained-service deployment. Configuration,
recovery and gate usage are in the [development guide](../../e2e/development/README.md#runtime-deployment-migration).

Controller 20260921 deployment also has a verified archived original. Its full
Python gate passes 95 support and 30 integration tests; 12 focused tests pass
after sharing the snapshot oracle with legacy compatibility checking. Six real
Docker cases include complete running-container acceptance with a foreign
project, three archives, a bound Runtime rebuild and recovery when Controller
creation fails after removal. Original rows may not change, while additions are
allowed. Legacy final snapshot/report fields match; the earlier pre-recovery
after snapshot remains an expected failure. Historical full inspect is not a
fresh healthy context, and the saved strict failure is unchanged. See the
[Controller guide](../../e2e/development/README.md#controller-20260921-deployment-migration)
for the new explicit workspace/recovery inputs and evidence scope.

Controller 20260917 is also verified, archived and removed. Both service orders,
unchanged Runtime/non-target IDs, three backups and its complete final business
contract pass 96 support and 38 integration tests and nine actual Docker cases.
The extracted shared driver also passes six rerun Controller 20260921 Docker
cases. Each fixture cleans up and compares retained resources/images unchanged.
`verify-controller17-deployment.py` compares original safe snapshots/report
fields, preserving the failed browser Trace and five lifecycle strict failures;
no historical live acceptance is invented. The shared 20260921 legacy comparison
also passes. See the [dual-Controller guide](../../e2e/development/README.md#controller-20260917-deployment-migration).

Temporal deployment passes 96 support/50 integration tests, eight real Docker
cases and saved-baseline/deployment/archive compatibility. All five modes and
dependency order remain, including readiness-only resume and old-probe recovery.
The all-daemon after assertion intentionally rejects stopped retained containers;
its positive is proven by the complete component model. Saved earlier failure
and resume/restart outcomes remain, without a fabricated latest after inspect.
See the [Temporal guide](../../e2e/development/README.md#temporal-deployment-migration).
Runtime missing-container recovery now passes 22 flow tests, the 96-support/54-integration
Python gate and six actual Docker cases. The final storage scan passes, as does
the complete Node/Python gate (3,364 passed; five existing opt-in skips). Ledger,
mapping, retained environment and process checks pass. See the cache exit report.
