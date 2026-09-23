# Explicit regression suites

These versioned templates preserve 21 historical final-regression/follow-up
queues (259 rows) and two test-layout manifests (14 rows). Row order and original
`accepted_exits`, `pin_images` and `check_resources` are preserved. They are
configured execution plans, not new successful runs of those historical batches.
Source hashes and destinations are in
[the migration map](../support/migrations/suite-manifests.json).

Run from the repository root, with the intended Node/Go/Rust toolchains on PATH:

```sh
node tests/support/run-suite.mjs --manifest tests/suites/final-regression/integration-queue.json --output artifacts/verification/new-run --baseline /path/to/before.json --inputs /path/to/suite-inputs.json
```

Capture the baseline with `tests/support/verification/environment.mjs` immediately
before the run, supplying every image reference to be pinned. A historical
baseline describes its original resources; it is not a substitute for the
intended current candidate. All commands run serially. Build suites create images;
business suites create disposable services and can call the configured models.
These suites do not run automatically during source migration.

`--inputs` is a JSON object of nonempty strings. A reference such as
`{"input":"acp_audit_image"}` fills one complete argv or environment value.
It never substitutes text inside a shell program. All required references are
resolved before the first command. `output` is reserved and comes from
`--output`; `{"input":"output","relative":"dependencies"}` resolves within
that durable directory. Cache paths and `..` path escapes are rejected.

Only provide the fields used by the selected suite:

| Input | Meaning |
| --- | --- |
| `acp_audit_image` | Already built ACP image for the SDK Docker regression. |
| `runtime_test_image`, `runtime_moved_image` | Two installed references with different image IDs. The adapter verifies a Unix Docker endpoint and sets all three required opt-in variables before running the two Go image tests. It does not pull images. |
| `commands_observer_config` | Explicit configuration file for the Commands diagnostic observer; its child command/environment and project selectors must describe the intended test. |
| `build_runtime_image`, `build_egress_image`, `build_runtime_controller_image`, `build_temporal_image`, `build_agent_acp_service_image`, `build_identity_service_image`, `build_agent_controller_image`, `build_admin_console_image`, `build_agent_ui_image`, `build_edge_gateway_image` | Explicit output tags for build rows. There are no implicit retained `:local` targets. |

The two original queues used Compose environment values
`COMPOSE_PARALLEL_LIMIT=1` and `COMPOSE_ENV_FILES=.env.example`; every migrated row
retains them. Creating `output/pause-before-next` prevents the next child from
starting and returns incomplete status 125. Accepted exit 2 remains nonzero even
when later rows are allowed to run. Business failure still triggers its resource
comparison before the suite stops. SIGINT/SIGTERM now consistently report 130;
the old queues could accidentally return zero after a failed check.

## Path and execution changes

- Go race rows use overlays with profile `all` across all five original services.
  ACP local rows include both service unit and root protocol integration tests.
- Persistence opt-in uses the disposable ACP database through `TEST_POSTGRES_URL`;
  SDK audit uses its separate `_audit` database. The old unconfigured SDK audit
  row now explicitly starts that dependency and checks cleanup.
- Root shared tests include relocated deployment/Temporal and all E2E fixture
  helpers. The targeted ACP script lint uses its relocated ESLint configuration.
- Build rows use the current owning Dockerfiles with explicit output tags. Their
  Compose build definitions had the same root context and no additional build
  arguments. Runtime/Egress use `--no-cache` to retain the old nonce's fresh-build
  intent; current Dockerfiles include the relocated root tests. No historical
  successful build is inferred from rendering these commands.
- The two test-layout manifests retain their formatting mutations and their
  existing scopes. Output paths are supplied through the current run directory.

## Fixed dependency profiles

The `dependencies/` directory holds the three old fixed commands. Other recovered
dependency wrappers accepted an arbitrary argv; continue to use
`tests/support/dependencies.mjs -- …` for those commands rather than narrowing
them to a single test.

| Profile | Preserved command scope | Readiness / command / TERM grace |
| --- | --- | --- |
| `controller-workflow-span.json` | Controller orchestration, PostgreSQL repository and internal E2E with race detection, PostgreSQL and initialized Temporal namespace | 180 s / 900 s / 20 s |
| `runtime-crash-postgres.json` | Runtime Controller PostgreSQL repository, Go timeout 4 minutes; this is not the explicit crash E2E opt-in | 60 s / 300 s / 10 s |
| `runtime-inspect.json` | Full Runtime Controller service runner plus both real installed-image checks | 90 s / 900 s / 30 s |

Service roles own isolated test databases; five old wrappers instead used the
Postgres bootstrap superuser. The unused ACP release-audit URL has no current
consumer and is retired. Its old unbounded wrapper now uses the common 20-minute
limit, with its five-second cleanup grace supplied explicitly when invoked.
The other arbitrary-command wrappers use 30-second readiness, 900-second command
and 15-second TERM grace. Use `npm --prefix services/agent-acp-service …` for the
former ACP service-relative cwd, or pass `--cwd services/agent-acp-service` to
the dependency runner and retain the original service-relative command vector.
Cleanup reports are now `<name>.cleanup.json`
with `project`, `cleanup` and `exit_code`; old fixed report filenames are not
selected implicitly.
