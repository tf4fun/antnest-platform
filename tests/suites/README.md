# Explicit verification suites

This directory holds versioned command manifests for explicit, serial
verification runs. Suites never run as part of `make test` or any other default
target; an operator starts them deliberately with
`tests/support/run-suite.mjs`.

## Suite runner

Run from the repository root with the intended Node, Go and Rust toolchains on
`PATH`:

```sh
node tests/support/run-suite.mjs \
  --manifest tests/suites/dependencies/runtime-crash-postgres.json \
  --output artifacts/verification/runtime-crash-postgres \
  --baseline /path/to/before.json \
  --inputs /path/to/suite-inputs.json
```

| Option | Meaning |
| --- | --- |
| `--manifest` | Required. JSON array of command rows. |
| `--output` | Required. Fresh durable output directory, normally under `artifacts/verification/`. Cache paths are rejected. |
| `--baseline` | Environment snapshot taken before the run. Required when any row sets `pin_images` or `check_resources`. |
| `--inputs` | JSON object of nonempty string values referenced by the manifest. |

Capture the baseline with `tests/support/verification/environment.mjs`
immediately before the run, supplying every image reference that must stay
pinned.

Each manifest row has a unique `name` and an argv `command`. Optional fields are
`env`, `cwd`, `timeout_ms`, `grace_ms`, `pause_file`, `accepted_exits`
(default `[0]`), `pin_images` and `check_resources`.

The runner behaves as follows:

- Rows run strictly in order, one child process at a time. Each row writes
  `<name>.log` to the output directory; existing evidence is never overwritten.
- An input reference such as `{"input":"runtime_test_image"}` replaces one
  complete argv or environment value. It never substitutes text inside a shell
  program. All references are resolved before the first command starts.
  `output` is reserved and comes from `--output`;
  `{"input":"output","relative":"dependency"}` resolves inside that directory.
  Absolute paths and `..` escapes are rejected.
- `pin_images` compares image IDs with the baseline before the row and stops on
  drift. `check_resources` compares Docker resources after the row, writes
  `<name>.environment.json` and stops if anything remains.
- A business failure reported in the log (a JSON report with
  `"status": "failed"`, or a `... business/topology failed;` line) stops the
  suite even when the exit code is listed in `accepted_exits`.
- If a row's `pause_file` exists when the row is reached, the row does not
  start and the run ends incomplete with reason `paused`.
- SIGINT and SIGTERM stop the current child and report exit code 130.
- The final summary is written to `suite.result.json` with `exit_code`,
  `complete`, `results` and an optional `reason` (`paused`,
  `environment-drift`, `business-failure`, `interrupted` or
  `suite-check-failed`).

## Dependency profiles

`dependencies/` contains fixed commands that run under
`tests/support/dependencies.mjs`. That wrapper starts a disposable Compose
project with PostgreSQL (profile `postgres`) or PostgreSQL plus an initialized
Temporal namespace (profile `temporal`), runs the command, and removes the
project's containers, volumes and network afterwards. All three profiles set
`check_resources`, so they require `--baseline`.

| Profile | Command scope | Dependency | Readiness / command timeout / TERM grace |
| --- | --- | --- | --- |
| `controller-workflow-span.json` | Agent Controller orchestration package plus the PostgreSQL repository and internal E2E packages, with race detection | `temporal` | 180 s / 900 s / 20 s |
| `runtime-crash-postgres.json` | Runtime Controller PostgreSQL repository with a 4-minute Go timeout. This does not enable the explicit crash E2E. | `postgres` | 60 s / 300 s / 10 s |
| `runtime-inspect.json` | Full Runtime Controller service runner plus the two real installed-image checks | `postgres` | 90 s / 900 s / 30 s |

`runtime-inspect.json` requires two inputs, `runtime_test_image` and
`runtime_moved_image`. They must be locally installed image references with
different image IDs. `tests/support/docker-test-images.mjs` verifies a Unix
Docker endpoint and sets the required opt-in variables before running the image
tests; it does not pull images.

For commands that have no fixed profile, call the wrapper directly:

```sh
node tests/support/dependencies.mjs --profile postgres --name my-check -- COMMAND ARGS
```

Without explicit options the wrapper uses a 180-second readiness wait, a
20-minute command timeout and a 180-second TERM grace period. Use `--cwd` to run
the command from a service directory. Cleanup reports are written to
`<name>.cleanup.json` under `--output` (default
`artifacts/verification/dependencies`) and contain `project`, `cleanup` and
`exit_code`.
