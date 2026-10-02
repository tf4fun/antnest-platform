# Platform tests

This document describes where tests live, how to run them from the repository
root, which external dependencies each level needs, and the resource-hygiene
rules every test runner follows.

## Layout

Tests are placed by the boundary they exercise, not by filename suffix.

| Location | Contents |
| --- | --- |
| `services/<name>/`, `runtimes/<name>/` | Service unit and contract tests that use only fake adapters. They stay with the owning service or Runtime package. |
| `tests/integration/` | Tests that use real dependencies (PostgreSQL, Temporal, Docker), real protocol peers or several components. Browser tests against synthetic backends are integration tests. |
| `tests/e2e/` | Complete deployed workflows, usually a disposable Docker Compose stack reached through the Edge Gateway. Browser tests through the deployed Gateway are E2E tests. Fixture validators (`*.test.mjs`) beside each scenario check the harness itself. |
| `tests/support/` | Shared fixture, process, dependency, environment and evidence utilities, plus tests of that infrastructure. See [verification tools](support/verification/README.md) and [diagnostic tools](support/diagnostics/README.md). |
| `tests/suites/` | Explicit serial command manifests, including the fixed `dependencies/` profiles. See [suites](suites/README.md). |

Some integration tests need private symbols of their owning language package.
Their sources still live under `tests/integration/`, and the runners keep the
original package identity: Go sources are compiled through overlays by
`tests/integration/go/run.mjs`, and Rust sources are wired in as test targets
of the owning crate. This must not add public production APIs, and root entry
points must not silently omit integration cases. The ACP service configuration
and lockfile stay with the service; root ACP integration sources reuse that
installation.

## Main targets

| Command | Coverage | Dependencies |
| --- | --- | --- |
| `make fmt-check` | gofmt, `cargo fmt`, Prettier for the ACP service and root `tests/**/*.mjs` / `*.ts`. `make fmt` applies the same formatters. | Go, Rust, installed ACP service dependencies |
| `make lint` | `go-lint` (Go services and root Go integration/E2E sources, compiled but not executed), `rust-clippy` with `-D warnings`, and `node-lint` (syntax checks, ESLint and TypeScript type checks). | Go, golangci-lint, Rust, Node dependencies |
| `make test` | Test-storage policy, Go service and portable root integration sources, Rust tests, Python verification tools, Node support tests, ACP, Admin Console and Agent UI unit tests, and all E2E fixture validators. External database and Temporal profiles are not included. | Go, Rust, Node, Python 3 |
| `make test-go-unit` | Go service-local unit tests only. `make test-go` also includes root sources through overlays. | Go |
| `make test-integration` | Go PostgreSQL and Temporal tests, Rust dependency and SDK probes, ACP PostgreSQL and audit tests, and Admin Console and Agent UI browser integration. | Docker, local PostgreSQL and Temporal images, Playwright browsers |
| `make test-postgres` | All service PostgreSQL tests in one disposable dependency project, including the Agent Controller Temporal tests. | Docker, local PostgreSQL and Temporal images |
| `make test-<service>-postgres` | One service's PostgreSQL tests: `egress`, `runtime-controller`, `agent-acp`, `identity`, `agent-controller`. | Docker; `agent-controller` also needs Temporal |
| `make e2e-*` | Deployed workflows under `tests/e2e/`; see below. | Docker; some targets need Playwright |

The PostgreSQL targets run through `tests/support/dependencies.mjs`, which
starts a uniquely named Compose project, runs the command and removes the
project's containers, volumes and network on exit.

To compile all root Go sources for one service without running them:

```sh
node tests/integration/go/run.mjs SERVICE --profile all -- -run '^$'
```

Go profiles default to `integration`. Runtime crash recovery uses the separate
`e2e` profile and requires its explicit environment opt-in.

## E2E targets

E2E targets build or reuse local images, start a disposable stack, run the
scenario and remove every resource they own. They are never part of
`make test`.

| Targets | Scenario directory | Coverage |
| --- | --- | --- |
| `e2e-stage1`, `e2e-stage2`, `e2e-stage3`, `e2e-stage3-local`, `e2e-runtime-controller` | `tests/e2e/`, `runtime-controller/`, `stage3-base/` | Runtime and Runtime Controller, identity and Agent orchestration, and the full admin control plane through the Gateway. |
| `e2e-runtime-controller-observation-retry` | `runtime-controller/` | Docker socket loss during startup and Watch, recovery without process restart, shared observation readiness and Runtime initialize/delete. Uses an isolated socket proxy and a separately tagged candidate image. |
| `e2e-acp-session`, `e2e-acp-closeout`, `e2e-acp-persistence`, `e2e-acp-restart`, `e2e-tool-progress`, `e2e-file-observations`, `e2e-structured-plan`, `e2e-tool-permissions`, `e2e-slash-commands`, `e2e-multimodal`, `e2e-session-cost`, `e2e-rpc-response-loss`, `e2e-managed-mcp-v1`, `e2e-managed-mcp-v2` | `acp-*/`, `rpc-response-loss/`, `managed-mcp/` | ACP protocol behavior on the full stack. Each is an opt-in flag of `tests/e2e/e2e-stage3a.sh`. |
| `e2e-identity-core`, `e2e-identity-access`, `e2e-agent-access` | `identity-closeout/` | Login, sessions, access control and Agent access. |
| `e2e-lifecycle`, `e2e-lifecycle-shutdown`, `-health`, `-restore`, `-interrupted`, `-network`, `-loss`, `-crash` | `lifecycle-closeout/` | Agent and platform lifecycle, normal shutdown, health, backup restore, interruption, network loss and Runtime loss. `e2e-lifecycle-crash` is an abnormal-exit diagnostic excluded from the stable targets. |
| `e2e-workspace`, `e2e-workspace-browser` | `workspace-closeout/` | Agent UI workspace protocol and browser behavior. |
| `e2e-stage3-skill-delivery`, `e2e-stage4-skill-*`, `integration-stage4-skill-*` | `stage3-base/`, `lifecycle-closeout/`, `tests/integration/skill-registry/` | Skill package delivery to Runtimes, including Registry outage, races, response loss, drift and restore. |
| `e2e-skill-learning-*`, `e2e-runtime-tool-usability` | `skill-learning/` | Automatic Skill learning: creation and update, notices, preemption, policy and lifecycle cancellation, commit windows, key rotation, model failure and recovery, restart and browser checks. |
| `e2e-skill-discovery-*`, `e2e-skill-temporary-*`, `e2e-skill-propagation`, `e2e-skill-deployment`, `e2e-skill-source-lifecycle`, `e2e-skill-registry-trace` | `skill-registry/`, `skill-learning/` | Skill Registry discovery, temporary Runtime use, Console promotion, Template propagation and source lifecycle. |

All Skill E2E flows use a local deterministic model fixture. The browser
targets (`e2e-workspace-browser`, `e2e-skill-learning-browser`,
`e2e-skill-learning-diagnostics-browser`, `e2e-skill-discovery-console`) need
installed Playwright Chromium and close their browsers before Docker cleanup.

Some contract checks can be run directly:

```sh
node --test tests/integration/skill-learning/contracts.test.mjs
node --test tests/integration/skill-registry/discovery-contract.test.mjs
node --test tests/integration/runtime-tools/contracts.test.mjs
make test-skill-deployment
```

The drivers in [`tests/e2e/development/`](e2e/development/README.md) target an
existing development deployment, require explicit configuration and are not
part of any default target.

## Resource hygiene

- Run verification commands serially. A runner preserves the failure exit
  status, owns and reaps its child processes, and leaves none behind after
  interruption.
- Disposable Docker scenarios compare the Docker environment before and after
  the run. Every container, volume, network and candidate image a scenario
  creates is removed.
- `.cache/` holds only reproducible dependency and compiler caches. Test
  sources, manifests, fixtures, recovery inputs and lasting evidence never go
  there, even temporarily. `make test-storage-policy` (part of `make test`)
  checks the layout of the allowed cache directories and rejects cache aliases.
- Versioned test sources belong under `tests/`. Durable private logs,
  snapshots and backups belong under `artifacts/verification/`, which is
  excluded from Git and Docker build contexts. Credentials, saved environment
  files, database contents and machine-specific results stay private.
