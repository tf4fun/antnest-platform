# Service Verification

Run from the platform repository root. Node.js 22+ and Go are required.
The coordinator runs one service at a time. The `go-service.mjs` runner does not
start Docker, create/drop databases, commit files or save raw test output.
The shared orchestration and evidence tools described below have separate scopes.

```sh
node tests/support/verification/go-service.mjs runtime-controller --test-database antnest_obs_runtime_controller_test
node tests/support/verification/go-service.mjs agent-controller --test-database antnest_obs_agent_controller_test
node tests/support/verification/go-service.mjs identity-service --test-database antnest_obs_identity_test
node --test tests/support/verification/*.test.mjs
```

The named databases must already exist, be owned by the matching service role,
and end in `_test`. They must never be the human acceptance or production database.
`--test-database` reads only the matching Postgres password and host port from
`.env` (override with `--env-file`). It does not pass the entire file to tests.
Alternatively supply the service's `ANTNEST_*_TEST_DATABASE_URL` and omit that option.
URLs and passwords are not printed by the runner.

The command always runs the full service with `go test -json -race -p=1`, no
test-result cache, and a ten-minute package timeout. It preserves Go's exit code,
prints failure diagnostics, and emits compact final package/test/subtest/skip
counts. A skip is visible and is not a pass. A twelve-minute outer watchdog kills
the test process group; interrupted or timed-out results are incomplete and may
not be used as acceptance evidence. Check for leftover processes before retrying.

The script is a convenience wrapper, not an alternative gate: `make fmt-check`,
`make lint`, applicable contract tests and deployment verification still apply.

## Controller And ACP Deployment

Before starting the refactored services, verify the rendered Compose configuration:

```sh
docker compose --env-file .env.example --profile stage2 config --format json | node tests/support/verification/execution-deployment.mjs
```

The checker reads JSON from stdin without saving or printing environments. It
verifies the Controller-to-ACP publication address, matching configuration size
limits, ACP-owned execution timeout, shared network and independent startup.
ACP must not have a Controller URL or Controller timeout; Controller must not
retain the retired Run admission TTL. The example uses only public synthetic
development values. This preflight does not contact services and is not E2E
evidence; successful publication, execution and lifecycle coordination still
require the real services, separate databases and Temporal.
This is a wiring check, not a duplicate implementation of service configuration
parsers: duration syntax, retry interval ordering and all other service-local
settings remain validated by their owning service at startup and in its tests.
A passing preflight does not mean either process has successfully started.

Agent UI was outside the Controller/ACP integration profile and is not its
dependency. That profile uses an official ACP SDK client; later workspace browser
acceptance is recorded separately in [current status](../../../docs/current-status.md).

## Safe fixture failure diagnostics

Commands, Multimodal and Session cost use `withAgentCleanup` and
`summarizeFailure`; Gateway request metadata is shared by these clients.
See the [2026-09-22 follow-up](../../../docs/timeout-failure-followup-20260922.md)
for the original evidence limits and targeted regression results.

Acceptance failures retain their nonzero exit status. The diagnostic summary
uses explicit allowed error names/codes, fixed request phases, numeric HTTP
statuses/timeouts, and known lifecycle kind/phase/state values. It never copies
messages, stack text, response bodies, headers, credentials, `error_detail` or
arbitrary transport causes. Unknown values are omitted or classified as `Error`.
Nested aggregate summaries have depth/count limits and report truncation.

Agent fixture cleanup records the owned Agent's index, whether deletion failed
at submission or polling, and the last allowed operation state. It attempts all
created Agents even after one failure, preserves an earlier business failure,
and retains the existing 120-second operation wait and 15-second HTTP limit.
Request transport classification is extracted before discarding the raw cause;
the sanitized Gateway error still has no `cause` property. These diagnostics
do not retry rejected requests, increase timeouts, or waive cleanup failures.

## Shared execution and evidence tools

`.cache/` is restricted to reproducible dependency/compiler caches. Project
test sources, manifests, fixtures, recovery inputs and lasting evidence must
never be placed there, even temporarily. Versioned sources belong under
`tests/`; durable private logs, snapshots and backups belong under
`artifacts/verification/`. The [cache inventory](../../../docs/cache-test-inventory.md)
records every old task script's current entry point or historical disposition.
Actual validation results belong to the [migration report](../../../docs/test-layout-migration.md),
not to the existence of these tools.

The default storage gate recognizes Go build/module, lint, npm and Cargo cache
layouts instead of trusting directory names alone. Downloaded dependency tests
and generated Cargo sources remain allowed within those layouts. Shell entry
preflight checks `TMPDIR` and the existing output tree, while recovery backup
and restore validate individual input/output leaves before Docker effects.

| Tool                                                         | Scope                                                                                                                                                                                                                         |
| ------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [run-command.mjs](../run-command.mjs)                        | Runs one argument-vector command, owns its process group, writes private log/result files and preserves failure or incomplete status. Existing evidence names are rejected.                                                   |
| [run-suite.mjs](../run-suite.mjs)                            | Runs an explicit command manifest serially, with optional pinned-image and environment-baseline checks. It keeps nonzero exits visible even when the manifest permits continuation.                                           |
| [dependencies.mjs](../dependencies.mjs)                      | Creates an owned disposable PostgreSQL or PostgreSQL/Temporal dependency project, supplies test database addresses to one command and removes its resources afterward. It does not target the retained development databases. |
| [environment.mjs](environment.mjs)                           | Takes read-only Docker inventory/container/image snapshots and compares them with an explicit baseline. It does not start, stop or remove containers.                                                                         |
| [cleanup.py](cleanup.py)                                     | Preserves the 29 historical cleanup profiles, including their distinct project/name/label selectors, process rules, retained-state schemas, image pins and Trace assertions. Read-only Docker and process inspection.         |
| [summarize-log.py](summarize-log.py)                         | Extracts selected JSON result objects, saves the source log hash and prints compact counts. It does not turn a nonzero run into a pass.                                                                                       |
| [audit-traces.py](audit-traces.py)                           | Inspects already-saved traces for parent warnings, absent parent references and error operations. It is an offline diagnostic, not another business gate.                                                                     |
| [check-links.py](check-links.py)                             | Checks local Markdown link targets for an explicit document list; remote links and fragments are outside its check.                                                                                                           |
| [recheck-crash-traces.mjs](recheck-crash-traces.mjs)         | Reapplies the current crash Trace oracle to an explicit saved scenario directory. It does not launch a new crash scenario.                                                                                                    |
| [audit-lifecycle-evidence.mjs](audit-lifecycle-evidence.mjs) | Checks explicit foundation/interrupted saved profiles, preserving topology and interrupted recovery/receipt assertions. Strict failures remain reported.                                                                      |
| [summarize-evidence.py](summarize-evidence.py)               | Preserves business Trace groups and statistics across all raw files, including rejected/error outcomes, error log events and trace-level warnings. Pure diagnostics.                                                          |
| [summarize-cost.py](summarize-cost.py)                       | Selects the first single-line report matching an explicit status; keeps request/pricing statistics and model-finish failures separate. Pure diagnostics.                                                                      |

Run from the repository root with Node on `PATH`; no user-specific Node install
path is embedded. Python tools require Python 3. Keep commands serial and use a
new evidence directory/name for each execution.

`run-command.mjs` closes child stdin to keep unattended checks from blocking.
Do not pipe a here-document into the runner or select an interpreter's stdin
script mode (`node -`, `python3 -`); the runner rejects these modes before it
creates evidence. Put lasting checks in root `tests/integration/`, `tests/e2e/`
or `tests/support/` and pass their source path. Small one-off audits may use an
explicit, shell-quoted `node -e` or `python3 -c` argument. A zero exit code from
an empty interpreter is not verification evidence.

When supplying an application's `--env-file`, put Node's `--` before the entry
path, for example `node -- tests/support/verification/go-service.mjs ...`.
This keeps the option with the script instead of Node's native environment-file
loader, so the script can validate the durable input before reading it.

```sh
node tests/support/run-command.mjs --output artifacts/verification/example-run --name local-check -- node --version
node tests/support/run-suite.mjs --manifest /path/to/commands.json --output artifacts/verification/example-suite --baseline /path/to/baseline.json
node tests/support/dependencies.mjs --profile postgres --output artifacts/verification/example-dependencies --name database-check -- <command> <arguments>
```

The dependency profile is `postgres` or `temporal`. Its command receives the
service test database variables, ACP audit database URL and, for Temporal, the
test address. The wrapper uses a unique Compose project and loopback ports,
runs no image build and removes only that project's resources. This is a real
Docker operation, separate from the read-only evidence tools.

A suite manifest is a nonempty JSON array of objects with unique `name` and a
`command` string array. Optional `timeout_ms`, `grace_ms`, `accepted_exits`,
`pin_images` and `check_resources` apply to that row. The last two require an
explicit `--baseline`. An allowed nonzero exit permits the next row; it does not
relabel strict diagnostics or cleanup failures as passed. Interrupted or timed-out
commands retain incomplete evidence.

Optional `env`, `cwd` and `pause_file` configure a row's child environment,
working directory and pause marker. Versioned [suite templates](../../suites/README.md)
also support explicit `--inputs` references for candidate images and durable
paths. These references are complete argv/environment values, not shell text.
The dependency runner accepts `--cwd`, `--timeout-ms`, `--grace-ms` and
`--startup-wait-seconds`; its proxy test URL always points to its newly created
ACP database, overriding any inherited `TEST_POSTGRES_URL`.

The environment output's parent directory must already exist. Capture the actual
pre-run state, then compare against that file:

```sh
node tests/support/verification/environment.mjs snapshot --output /path/to/private/before.json --image antnest/agent-controller:local
node tests/support/verification/environment.mjs compare --baseline /path/to/private/before.json --output /path/to/private/after.json
```

Snapshots contain resource identities, container ID/image/start time/restart
count, sorted mounts/networks and actual running/health state. An already stopped
baseline remains a stopped baseline; cached health metadata is not fresh running
service health. Compare also writes `<output>.comparison.json` and returns
nonzero on drift. Image references can be supplied with repeated `--image` when
capturing a baseline. This tool does not reproduce historical database-row or
workspace-content snapshots from one-time service upgrades.

### Historical cleanup contracts

Run `python3 -B tests/support/verification/cleanup.py --config /path/to/config.json`.
The JSON object requires `profile`, `input_root` (existing durable evidence) and
`output` (a fresh durable report directory). Profile names, baseline filenames,
required logs and fixed selectors are in [cleanup_profiles.py](cleanup_profiles.py).
For example:

```json
{
  "profile": "identity-migration",
  "input_root": "artifacts/verification/my-identity-run",
  "output": "artifacts/verification/my-identity-cleanup"
}
```

The three fixed-project profiles additionally require `projects`: three
`antnest-workflow-tests-<digits>` names for Controller workflow, three lifecycle
names for Loss, or two for Restore. Lifecycle names end in eight lowercase hex
digits. Network and Shutdown require `trace_directory`, ending in
`<project>/traces`; the project must match `docker-2.log` and `docker-3.log`,
respectively. Temporal requires `trace_roots` with `shutdown` and `foundation`
directories, each containing the logged project directories. Inspect requires
an explicit `candidate_reference` and full `candidate_image` SHA-256 identity.
It also verifies the local Runtime Controller identity from its saved baseline.

The checker rejects unknown configuration fields, incomplete or empty retained
baselines, duplicate container IDs, cached input/output paths and resolved
cache aliases, including matched log/Trace leaves. It checks both ownership
labels, Legacy's additional name filters, and Crash recovery's original single
scope label. Selectors cannot be disabled in configuration. Existing output
reports are never overwritten; new files are private (`0600`). Final profiles
save actual resource/container/image drift before returning failure.

Lower4 profiles and Final regression require running retained containers; Final
also requires healthy health checks. Other profiles preserve the exact baseline
state, including already stopped containers. Network requires 20 raw traces and
zero error spans. Shutdown requires six traces and reports error spans without
rejecting them. Temporal keeps strict failures visible and accepts only GET
transport-error records. Its old hardcoded `local_tests` totals are omitted:
they were constants, not checks performed by that script.

Process checks include the relocated formal paths and versioned Python
executables. They exclude the checker and its actual ancestor chain, so running
under the formal command wrapper is supported without ignoring sibling or
descendant test processes. Container and image inspection counts are checked
explicitly, including profiles whose historical `zip` comparison missed counts.

Validation is split into contracts, saved-evidence replay, and actual Docker
inspection. Replay reconstructs Docker rows from old baselines and uses empty
resource/process fixtures; it does not prove present-day cleanup. The opt-in
Docker integration creates one isolated container from an already installed
image, exercises all 29 CLI profiles with synthetic logs/Trace fixtures, checks
a real leftover failure, then removes the container and compares the environment:

```sh
python3 -B -m unittest discover -s tests/support/verification -p 'cleanup*_test.py'
python3 -B tests/support/migrations/verify-cleanups.py --evidence-root artifacts/verification --output artifacts/verification/cleanup-replay
python3 -B tests/integration/verification/cleanup-docker.py --image debian:bookworm-slim --output artifacts/verification/cleanup-docker
```

The integration needs Docker/process access and the existing
`antnest/runtime-controller:local` reference for Inspect. It never pulls images,
retags images or restarts retained services. Always run verification serially.

Offline result processing uses explicit paths:

```sh
python3 tests/support/verification/summarize-log.py --output /path/to/private/parsed /path/to/run.log
python3 tests/support/verification/audit-traces.py --input /path/to/logs --evidence-root /path/to/evidence --output /path/to/private/audit.json
python3 tests/support/verification/check-links.py docs/current-status.md tests/README.md
node tests/support/verification/recheck-crash-traces.mjs --input /path/to/crash-project --output /path/to/private/rechecked.json
```

The two additional historical diagnostic scopes have explicit inputs:

```sh
python3 -B tests/support/verification/summarize-evidence.py --output /path/to/private/summary /path/to/project
python3 -B tests/support/verification/summarize-cost.py --input /path/to/cost.log --output /path/to/private/summary --status business_passed
```

Create those private output directories first. Use the public command wrapper
to keep inherited umask private. Replaying a saved summary does not execute the
original business scenario. A complete replay of saved historical diagnostic
fields is available through `tests/support/migrations/verify-summaries.py` with
explicit `--evidence-root` and a new `--output`. Its comparison records stale
historical log hashes separately and does not rewrite them.

`summarize-log.py` writes `<log-stem>.parsed.json` containing `log_sha256` and the
selected objects. It does not remove private content from those stored objects;
only the terminal summary is compact. Use private outputs.

`audit-traces.py` pairs `*.parsed.json` with same-stem `.log` files in `--input`,
extracts project/Trace identities, and scans `--evidence-root/<family>/<project>`.
It keeps the largest saved response per matching Trace. For a named repeated
scenario whose log omits some IDs, `--allow-unlisted-repeat NAME` explicitly
includes additional saved project traces; the option can repeat. There is no
hard-coded historical scenario exception. Its warning/error counts describe
saved evidence and cannot establish that an unrecorded trace passed.

`recheck-crash-traces.mjs` reads `business.json`,
`before-create.recovered.private.json`, `after-start.recovered.private.json` and
the corresponding `traces/<trace-id>.json` files. It preserves the current crash
oracle's result, including strict diagnostics. The ordinary crash E2E entry is
`tests/e2e/lifecycle-closeout/crash-run.mjs` and remains a separate opt-in action.

Real retained-environment scenarios have their own
[development-driver configuration and impact guide](../../e2e/development/README.md).
They are not launched by these offline utilities or default layout checks.

`audit-lifecycle-evidence.mjs --config /path/to/audit-config.json` takes an
existing durable `output` directory and a nonempty `profiles` array. Each entry
requires `profile` (`foundation` or `interrupted`), `log`, `evidenceRoot`,
`projectPattern` (whose first capture is the project directory name) and positive
`expectedTraceCount`. An interrupted entry also requires positive
`expectedTargetTemplateRevision` and nonnegative `expectedErrors`. The old
two-profile run used counts 3/16, revision 2 and two interrupted errors; those
values are recorded in the [source map](../migrations/cache-diagnostics.json).
All configurations are checked before the first evidence log is read.

The audit writes `trace-audit.json` only after all assertions pass. Its
`missing_parent_edges: 0` is the existing topology oracle's successful outcome;
it does not waive missing parents. Stored strict failures remain counted.
The [HTTP collector guide](../diagnostics/README.md) documents the distinct
live-observer and failed-request collection inputs.
