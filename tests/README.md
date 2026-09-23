# Platform tests

Service unit tests stay beside their owning service or Runtime package. Tests
that exercise real dependencies, protocol peers or several components belong in
`tests/integration/`; complete deployed workflows belong in `tests/e2e/`.
Shared fixture, process, environment and evidence utilities belong in
`tests/support/`, together with checks of the test infrastructure itself.

Directory placement follows the boundary exercised, not a filename suffix.
A fixture-validator check is part of the acceptance harness; it is not a unit
test of the production service. Service-local tests using only fake adapters
remain within the service. Browser tests against synthetic backends are
integration tests; browser tests through the deployed Gateway are E2E tests.

Some integration tests need their owning language package's private symbols.
Their sources still live under this root tree, while test runners preserve the
original package identity through Go overlays or Cargo test-source paths. This
must not add public production APIs or silently omit integration cases from the
root test entry points.

Run commands from the repository root:

| Command | Coverage |
| --- | --- |
| `make test` | Service unit/contract tests, portable root integration sources and acceptance harness self-checks. External database/Temporal profiles remain opt-in. |
| `make test-go-unit` | Go service-local unit tests only. `make test-go` also discovers migrated root sources through overlays. |
| `make go-lint` | Go service and root integration/E2E sources, including opt-in crash sources without executing them. Temporary package symlinks are removed when lint exits or is interrupted. |
| `make test-integration` | Go database/Temporal, Rust dependency/SDK, ACP database/SDK and UI/Console browser integration. Requires installed dependencies, browser binaries and local dependency images. |
| `make test-postgres` | All service PostgreSQL gates in one disposable dependency project, including the Controller Temporal tests. |
| `make e2e-stage2`, existing `make e2e-*` targets | Deployed workflows under `tests/e2e/`; each retains its original opt-in and Trace semantics. |
| `node tests/integration/go/run.mjs SERVICE --profile all -- -run '^$'` | Compile all moved Go sources using the original private package context. This is only a compilation check. |

Go profiles default to `integration`; Runtime crash recovery is a separate
`e2e` profile and retains its explicit environment opt-in. ACP configurations and
lockfile stay with the service; root integration sources reuse that installation.
Rust root sources use the owning crate's Cargo targets and original test modules,
so private access and Linux-only gates remain unchanged. Development deployment
drivers require explicit [configuration](e2e/development/README.md) and are not
part of default test targets.

`.cache/` is restricted to reproducible dependency/compiler caches. Project
test sources, manifests, fixtures, recovery inputs and lasting evidence must
never be placed there, even temporarily. Versioned sources belong under
`tests/`; durable private logs, snapshots and backups belong under
`artifacts/verification/`. Credentials, saved environments,
retained database contents and machine-specific result files stay private.

`make test-storage-policy` checks the actual layouts inside the five allowed
cache directories, including dependency checksum records and Cargo outputs.
Directory names alone do not exempt scripts or reports. Shared Shell preflight
also checks `TMPDIR` and existing evidence leaves; restore backups validate their
inputs and destinations before Docker operations. Cache aliases are rejected.

Run verification commands serially. A runner must preserve failure exit status,
own and reap its child processes, and compare the original environment before
and after disposable Docker scenarios. Previously deferred strict Trace timing
diagnostics retain their original failed status and separate scope.

The [migration record](../docs/test-layout-migration.md) tracks the source mapping,
delivery batches and verification. Historical reports describe their original
paths and candidates; the mapping supplies their current entry points.
