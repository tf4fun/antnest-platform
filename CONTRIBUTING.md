# Contributing to Antnest Platform

Thank you for your interest in improving Antnest Platform. This guide explains
how the repository is organized and what a change needs before it can merge.

## Before you start

- For anything larger than a small fix, open an issue first and describe the
  problem, the owning service and the proposed contract change.
- Report security problems privately as described in [SECURITY.md](SECURITY.md).
- Follow the [Code of Conduct](CODE_OF_CONDUCT.md) in issues, pull requests and
  every other project space.
- By contributing, you agree that your contribution is licensed under the
  [MIT License](LICENSE).

## Toolchain

| Tool | Version | Source of truth |
| --- | --- | --- |
| Go | 1.27.1 | `go.work`, each `services/*/go.mod` |
| Rust | 1.98.1 | `rust-toolchain.toml` |
| Node.js | 24.21.0 | `.nvmrc` |
| golangci-lint | 2.14.0 | `.golangci.yml`, CI workflows |
| Docker Engine with Compose v2 | recent | required for images and E2E tests |
| Python | 3.12 or newer | test support scripts |

The Runtime crate links `libnftables`; on Debian or Ubuntu install
`libnftables-dev` and `pkg-config` to build it outside Docker.

Install the locked Node dependencies used by host-side checks:

```bash
npm --prefix services/agent-acp-service ci
npm --prefix services/admin-console/web ci
npm --prefix services/agent-ui/web ci
```

## Repository layout

- `services/<name>/` and `runtimes/<name>/`: one independently deployable
  component each, with its own `README.md`, `docs/architecture.md`, unit tests
  and `Dockerfile`.
- `contracts/`: language-neutral contracts between services. A service never
  imports another service's code.
- `docs/`: cross-service architecture, deployment and operations.
- `tests/integration/`, `tests/e2e/`, `tests/support/`: cross-service
  integration tests, deployed acceptance tests and shared test tooling. See
  [tests/README.md](tests/README.md).

Read [docs/service-layout.md](docs/service-layout.md) and the README of the
service you are changing before you write code.

## How changes are made

1. **Contract first.** If a change crosses a service boundary, update the
   contract under `contracts/` and its compatibility tests first.
2. **One owning service per change.** Change the producing service, its
   documentation and its tests together. Consumer services follow in separate
   changes. Cross-service behavior is verified in an explicit integration change
   after each service passes its own checks.
3. **Test first.** New behavior starts with a failing unit, contract or component
   test.
4. **Keep documentation current.** A service README and `docs/` describe the code
   as it is. Mark designs that are not implemented yet as planned.
5. **Data ownership.** Every durable fact has exactly one writer service. Do not
   read another service's database, volume or secrets.

## Checks

Run from the repository root:

```bash
make fmt-check   # Go, Rust and TypeScript formatting
make lint        # golangci-lint, cargo clippy, ESLint and TypeScript checks
make test        # unit and integration tests that need no running stack
make test-postgres   # persistence suites against a disposable PostgreSQL
```

Service-specific commands are listed in each service README. Docker E2E targets
(`make e2e-*`) create disposable Compose projects; run them one at a time and
check for leftover containers afterwards.

Do not store test sources, fixtures or evidence in `.cache/`; it holds only
rebuildable dependency and compiler caches. Local verification output belongs
in `artifacts/verification/`, which is ignored by Git and Docker.

## Pull requests

- Keep each pull request focused on one service or one contract change.
- Use [Conventional Commits](https://www.conventionalcommits.org/) style
  subjects, for example `fix(edge-gateway): strip trusted administrator header`.
- Describe the behavior change, the contracts touched and the checks you ran.
- CI must pass. It runs lint, unit tests and an image build for every changed
  component, and the `integration` workflow runs the component, browser and
  service-owned Docker E2E suites that the change exercises. Only
  `Repository checks` and `Integration checks` are required; see
  [tests/README.md](tests/README.md#continuous-integration).
