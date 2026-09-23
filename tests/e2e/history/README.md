# Retired acceptance source snapshots

This is the permanent source archive for retired acceptance contracts recovered
from task caches. Each `.source` file preserves the original bytes and is kept
out of executable test discovery. These are final historical records, not a
staging directory or current regression entry points. Migration hashes identify
the removed cache original and its destination.

| Original group | Current executable coverage / retired boundary |
| --- | --- |
| `stage3-tail-retirement-20260921/before/` | Current Stage 3 dispatch, Workspace and lifecycle topology checks live under `tests/e2e/stage3-base/`, `workspace-closeout/` and `lifecycle-closeout/`. The old cookie-jar Trace adapter is retired. Current privacy checks prohibit the former cleanup helper's private evidence output. |
| `acceptance-retirement-20260921/before/` | Current foundation and Workspace flows use ACP Run facts. Old Controller `run_admissions`, acquire/finish-run RPC and admission-fence assertions describe removed contracts and must not be restored as current tests. |
| `interruption-assets-retirement-20260921/before/` | Normal restart uses the committed-response profile; explicit crash recovery uses current crash profiles. The old startup-gate/SIGKILL model, 100 ms exporter and marker-based assumptions are retired. The two still-applicable collector response-privacy assertions were migrated into `tests/e2e/observability/collect.test.mjs` and pass there. |
| `browser-finish-retirement-20260921/browser-control*` | Current browser automation is under `tests/e2e/workspace-closeout/`; the manual finish hook was retired. |
| `stage3-tail-retirement-20260921/identity-before.sh` | Historical Stage 3 source before dispatch cleanup; current identity scenarios are under `tests/e2e/identity-closeout/`. |
| `command-wrappers/` | Five byte-identical groups replace 45 obsolete Python entry points. Current execution is `tests/support/run-command.mjs`; per-source hashes and preserved timeout/cleanup arguments are in `tests/support/migrations/cache-wrappers.json`. The twelve command/suite contract checks passed before removing the cache originals. |
| `summary-tools/` | Four original contents map to the four current diagnostic summarizers. Offline replay preserved all historical diagnostic fields; five stale historical log hashes remain reported separately. |
| `queue-wrappers/`, `suite-manifests/` | Queue behavior is owned by `tests/support/run-suite.mjs`; configured definitions are under `tests/suites/`. Preserved continuation exits are still failures, not passes. |
| `dependency-wrappers/` | Seven former dependency launchers map to `tests/support/dependencies.mjs` and three fixed profiles in `tests/suites/dependencies/`. Actual PostgreSQL/Temporal and installed-image evidence is recorded in `cache-dependencies.json`. |
| `build-definitions/` | Old candidate-specific assembly definitions. Current owning Dockerfiles include the relocated tests; the suite takes explicit candidate tags. |
| `diagnostic-tools/` | Nine unique original contents from ten removed sources. Formal link/audit/crash replay, HTTP collectors, process observers and Identity hook are mapped in `tests/support/migrations/cache-diagnostics.json`. Offline replay and actual isolated Docker results have separate evidence; strict failures remain recorded. |

The old interfaces and assertions remain readable here. Their retirement is
explicit; preserving this source does not mean those obsolete APIs passed a
current test. Do not import, execute, format or automatically revive these files.
New tests must use the current owner and protocol, with runnable source outside
this archive.
