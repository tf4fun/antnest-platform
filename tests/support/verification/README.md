# Verification tools

This directory contains the shared runners, environment checks and offline
evidence tools used by the test targets. Run every command from the repository
root with Node.js 24 or newer, Go and Python 3 on `PATH`. Run verification
commands serially and use a new evidence directory or name for each run.

## Go service runner

`go-service.mjs` runs one Go service's full test suite against an existing test
database. It does not start Docker, create or drop databases, or save raw test
output.

```sh
node tests/support/verification/go-service.mjs runtime-controller --test-database antnest_obs_runtime_controller_test
node tests/support/verification/go-service.mjs agent-controller --test-database antnest_obs_agent_controller_test
node tests/support/verification/go-service.mjs identity-service --test-database antnest_obs_identity_test
```

The named database must already exist, be owned by the matching service role
and end in `_test`. It must never be a shared development or production
database. `--test-database` reads only the matching PostgreSQL password and host
port from `.env` (override with `--env-file`) and does not pass the whole file
to the tests. Alternatively, set the service's `ANTNEST_*_TEST_DATABASE_URL`
and omit the option. URLs and passwords are never printed. The `make
test-<service>-postgres` targets call this runner inside a disposable
dependency project, so most users do not need to provision databases manually.

When passing `--env-file`, put Node's `--` before the entry path, for example
`node -- tests/support/verification/go-service.mjs ...`. Otherwise Node's
native environment-file loader consumes the option before the script can
validate it.

The runner always uses `go test -json -race -p=1`, no test-result cache and a
ten-minute package timeout. It preserves Go's exit code, prints failure
diagnostics and emits compact package, test, subtest and skip counts. A skip is
reported and never counted as a pass. A twelve-minute outer watchdog kills the
test process group; interrupted or timed-out results are incomplete. Check for
leftover processes before retrying.

This runner is a convenience wrapper, not a replacement for `make fmt-check`,
`make lint` and the applicable contract and E2E tests.

## Controller and ACP deployment preflight

Check the rendered Compose wiring before starting the Agent Controller and ACP
service:

```sh
docker compose --env-file .env.example --profile stage2 config --format json | node tests/support/verification/execution-deployment.mjs
```

The checker reads JSON from stdin without saving or printing environments. It
verifies the Controller-to-ACP publication address, matching configuration size
limits, the ACP-owned execution timeout, the shared network and independent
startup. ACP must not have a Controller URL or Controller timeout, and the
Controller must not set a Run admission TTL. The example uses only public
synthetic development values.

This is a wiring check only. It does not contact services, and it does not
duplicate the services' own configuration parsers: duration syntax, retry
interval ordering and other service-local settings are validated by each
service at startup and in its tests.

## Fixture failure diagnostics

The Commands, Multimodal and Session cost E2E clients use `withAgentCleanup`
(`agent-cleanup.mjs`) and `summarizeFailure` (`failure.mjs`) and share Gateway
request metadata.

Failures keep their nonzero exit status. The diagnostic summary uses only
allowed error names and codes, fixed request phases, numeric HTTP statuses and
timeouts, and known lifecycle kind, phase and state values. It never copies
messages, stack text, response bodies, headers, credentials, `error_detail` or
arbitrary transport causes. Unknown values are omitted or classified as
`Error`. Nested aggregate summaries have depth and count limits and report
truncation.

Agent fixture cleanup records the owned Agent's index, whether deletion failed
at submission or while polling, and the last allowed operation state. It
attempts to delete every created Agent even after one failure, preserves an
earlier business failure, and uses a 120-second operation wait and a 15-second
HTTP limit. Transport classification is extracted before the raw cause is
discarded; the sanitized Gateway error has no `cause` property. These helpers
do not retry rejected requests, extend timeouts or waive cleanup failures.

## Execution and evidence tools

| Tool | Scope |
| --- | --- |
| [run-command.mjs](../run-command.mjs) | Runs one argv command, owns its process group, writes private log and result files and preserves failure or incomplete status. Existing evidence names are rejected. |
| [run-suite.mjs](../run-suite.mjs) | Runs an explicit command manifest serially, with optional pinned-image and environment-baseline checks. See [suites](../../suites/README.md). |
| [dependencies.mjs](../dependencies.mjs) | Creates a disposable PostgreSQL or PostgreSQL plus Temporal Compose project, supplies test database addresses to one command and removes the project afterwards. |
| [environment.mjs](environment.mjs) | Takes read-only Docker inventory, container and image snapshots and compares them with a baseline. It never starts, stops or removes containers. |
| [cleanup.py](cleanup.py) | Read-only Docker and process inspection that checks a run left no owned resources behind, using the named profiles in [cleanup_profiles.py](cleanup_profiles.py). |
| [summarize-log.py](summarize-log.py) | Extracts selected JSON result objects from a log, records the log hash and prints compact counts. It never turns a nonzero run into a pass. |
| [audit-traces.py](audit-traces.py) | Inspects saved Traces for parent warnings, missing parent references and error operations. Offline diagnostic only. |
| [check-links.py](check-links.py) | Checks local Markdown link targets for an explicit list of documents. Remote links and fragments are not checked. |
| [recheck-crash-traces.mjs](recheck-crash-traces.mjs) | Reapplies the current crash Trace oracle to a saved scenario directory. It does not launch a crash scenario. |
| [audit-lifecycle-evidence.mjs](audit-lifecycle-evidence.mjs) | Checks saved foundation and interrupted lifecycle evidence, including topology and interrupted recovery and receipt assertions. Strict failures stay reported. |
| [summarize-evidence.py](summarize-evidence.py) | Summarizes business Trace groups and statistics across raw files, including rejected and error outcomes, error log events and Trace-level warnings. |
| [summarize-cost.py](summarize-cost.py) | Selects the first single-line report with a given status and summarizes request and pricing statistics, keeping model-finish failures separate. |

### Command runner

```sh
node tests/support/run-command.mjs --output artifacts/verification/example-run --name local-check -- node --version
```

`run-command.mjs` closes the child's stdin so unattended checks cannot block.
It rejects here-documents piped into the runner and interpreter stdin modes
(`node -`, `python3 -`) before creating evidence. Put lasting checks in
`tests/integration/`, `tests/e2e/` or `tests/support/` and pass their path.
Small one-off checks may use an explicit, shell-quoted `node -e` or
`python3 -c` argument.

### Dependency runner

```sh
node tests/support/dependencies.mjs --profile postgres --output artifacts/verification/example-dependencies --name database-check -- COMMAND ARGS
```

The profile is `postgres` or `temporal`. The command receives the service test
database variables, the ACP audit database URL and, for `temporal`, the
Temporal test address. `TEST_POSTGRES_URL` always points to the newly created
ACP database, overriding any inherited value. The wrapper uses a unique Compose
project and loopback ports, builds no images, and removes only that project's
resources. It also accepts `--cwd`, `--timeout-ms`, `--grace-ms` and
`--startup-wait-seconds`.

### Environment snapshots

The output's parent directory must already exist. Capture the state
immediately before a run, then compare:

```sh
node tests/support/verification/environment.mjs snapshot --output /path/to/private/before.json --image antnest/agent-controller:local
node tests/support/verification/environment.mjs compare --baseline /path/to/private/before.json --output /path/to/private/after.json
```

Snapshots record resource identities, container ID, image, start time, restart
count, sorted mounts and networks, and actual running and health state. A
stopped container in the baseline stays a stopped baseline; cached health
metadata is not treated as fresh service health. `compare` also writes
`<output>.comparison.json` and exits nonzero on drift. Repeat `--image` to pin
image references in the baseline. The tool does not snapshot database rows or
workspace contents.

### Cleanup checker

```sh
python3 -B tests/support/verification/cleanup.py --config /path/to/config.json
```

The configuration requires `profile`, `input_root` (existing durable evidence
directory) and `output` (fresh durable report directory):

```json
{
  "profile": "identity-migration",
  "input_root": "artifacts/verification/my-identity-run",
  "output": "artifacts/verification/my-identity-cleanup"
}
```

Profile names, baseline filenames, required logs and fixed selectors are
defined in [cleanup_profiles.py](cleanup_profiles.py). Some profiles need extra
fields:

- Profiles with fixed projects require `projects`, a list of Compose project
  names in the format the profile defines (for example
  `antnest-workflow-tests-<digits>` or lifecycle names ending in eight
  lowercase hex digits).
- Network and shutdown profiles require `trace_directory`, ending in
  `<project>/traces`, whose project must match the profile's Docker log.
- The Temporal readiness profile requires `trace_roots` with `shutdown` and
  `foundation` directories.
- The Runtime inspect profile requires `candidate_reference` and the full
  SHA-256 `candidate_image` identity, and verifies the local Runtime Controller
  identity from its saved baseline.

The checker rejects unknown fields, incomplete or empty baselines, duplicate
container IDs, and cache paths or cache aliases for any input or output.
Ownership label selectors cannot be disabled. Existing reports are never
overwritten, and new files are created with mode 0600. Resource, container and
image drift is saved before the checker returns failure. Process checks
exclude the checker and its own ancestor chain, so running it under
`run-command.mjs` does not hide sibling or descendant test processes.

Unit tests and an opt-in Docker check cover the checker:

```sh
python3 -B -m unittest discover -s tests/support/verification -p 'cleanup*_test.py'
python3 -B tests/integration/verification/cleanup-docker.py --image debian:bookworm-slim --output artifacts/verification/cleanup-docker
```

The Docker check creates one isolated container from an already installed
image, runs every profile against synthetic logs and Trace fixtures, checks a
real leftover failure, then removes the container and compares the environment.
It needs the local `antnest/runtime-controller:local` image for the inspect
profile and never pulls or retags images or restarts other services.

### Offline evidence processing

Create the private output directories first and run these through
`run-command.mjs` to keep a private umask:

```sh
python3 tests/support/verification/summarize-log.py --output /path/to/private/parsed /path/to/run.log
python3 tests/support/verification/audit-traces.py --input /path/to/logs --evidence-root /path/to/evidence --output /path/to/private/audit.json
python3 tests/support/verification/check-links.py README.md tests/README.md
node tests/support/verification/recheck-crash-traces.mjs --input /path/to/crash-project --output /path/to/private/rechecked.json
python3 -B tests/support/verification/summarize-evidence.py --output /path/to/private/summary /path/to/project
python3 -B tests/support/verification/summarize-cost.py --input /path/to/cost.log --output /path/to/private/summary --status business_passed
```

- `summarize-log.py` writes `<log-stem>.parsed.json` with `log_sha256` and the
  selected objects. Stored objects are not redacted; only the terminal summary
  is compact.
- `audit-traces.py` pairs `*.parsed.json` files with same-stem `.log` files in
  `--input`, extracts project and Trace identities, and scans
  `--evidence-root/<family>/<project>`, keeping the largest saved response per
  Trace. `--allow-unlisted-repeat NAME` (repeatable) includes additional saved
  Traces for a named repeated scenario whose log omits some IDs. Counts describe
  saved evidence only.
- `recheck-crash-traces.mjs` reads `business.json`,
  `before-create.recovered.private.json`, `after-start.recovered.private.json`
  and the matching `traces/<trace-id>.json` files. The crash scenario itself is
  `make e2e-lifecycle-crash`.

`audit-lifecycle-evidence.mjs --config /path/to/audit-config.json` takes an
existing durable `output` directory and a nonempty `profiles` array. Each entry
requires `profile` (`foundation` or `interrupted`), `log`, `evidenceRoot`,
`projectPattern` (whose first capture group is the project directory name) and
a positive `expectedTraceCount`. Interrupted entries also require a positive
`expectedTargetTemplateRevision` and a nonnegative `expectedErrors`. All
entries are validated before the first log is read, and `trace-audit.json` is
written only after every assertion passes. Stored strict failures remain
counted.

Drivers for an existing development deployment are described in
[development drivers](../../e2e/development/README.md). HTTP and process
observers are described in [diagnostic collectors](../diagnostics/README.md).
