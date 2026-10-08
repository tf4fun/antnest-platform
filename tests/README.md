# Platform tests

This document describes where tests live, how to run them from the repository
root, which external dependencies each level needs, and the resource-hygiene
rules every test runner follows.

Deployment secret regression is in `tests/integration/deployment/development-secrets.test.mjs`:
the generator, file mode/non-overwrite checks and all twelve unset/empty Compose
fields run in `make test-repo` / `make test-deployment-wiring` with Compose CLI,
without an Engine. `make e2e-deployment-wiring` uses a fresh generated `.env` and
verifies administrator login and public-password rejection in the actual stack.
Fixed disposable workflows explicitly select `tests/support/compose.public-development-secrets.yaml`
and opt in through their fixture environment. This setting is absent from standard
Compose and never inherited from a retained deployment.

`make e2e-stage1`, `make e2e-stage2`, `make e2e-runtime-controller` and
`make e2e-lifecycle` use `tests/support/authenticated-shell-e2e.mjs`. It builds
uniquely tagged images from the current checkout, provisions private workload
tokens/CCT keys for an isolated project, and removes its containers, volumes,
networks, credentials and candidate tags afterward. Stage1 selects base Compose
without the debug overlay; Stage2 and RC select the diagnostic relay explicitly.
Direct private API probes use the fixture's allowed caller identity, real
Identity login session and organization/Agent scope. Native
Runtime probes also supply the per-instance credential before checking execution
fences. Stage2 uses deterministic model replies and never calls a real Provider.
Private logs and cleanup results live under `artifacts/verification/shell-*`.
Stage2 starts the bounded Runtime OTLP ingress and a separate loopback ingress
for its host-side test client's spans; Jaeger remains on the isolated
observability network. It records the established clock-only warning review
without changing raw spans. Missing parents and
unknown warnings still fail normal scenarios. Its explicit SIGKILL diagnostic
keeps business recovery assertions but excludes the killed Run and its source
trace from stable Trace admission. Expected-503 fault probes outlive the
standard 150-second dependency deadline.
Lifecycle waits up to 60 seconds for RC's asynchronous Skill-volume cleanup
after Delete, then requires every owned Runtime container and volume to be gone.
Its Trace review also checks preparation retries, expected busy rejections and
the deliberate graceful Controller restart against their complete topology and
exact error classes. Raw warnings and error spans remain in the evidence;
unrelated errors or missing parents fail admission.

## Layout

Tests are placed by the boundary they exercise, not by filename suffix.

| Location                               | Contents                                                                                                                                                                                                                                            |
| -------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `services/<name>/`, `runtimes/<name>/` | Service unit and contract tests that use only fake adapters. They stay with the owning service or Runtime package.                                                                                                                                  |
| `tests/integration/`                   | Tests that use real dependencies (PostgreSQL, Temporal, Docker), real protocol peers or several components. Browser tests against synthetic backends are integration tests.                                                                         |
| `tests/e2e/`                           | Complete deployed workflows, usually a disposable Docker Compose stack reached through the Edge Gateway. Browser tests through the deployed Gateway are E2E tests. Fixture validators (`*.test.mjs`) beside each scenario check the harness itself. |
| `tests/support/`                       | Shared fixture, process, dependency, environment and evidence utilities, plus tests of that infrastructure. See [verification tools](support/verification/README.md) and [diagnostic tools](support/diagnostics/README.md).                         |
| `tests/suites/`                        | Explicit serial command manifests, including the fixed `dependencies/` profiles. See [suites](suites/README.md).                                                                                                                                    |

Some integration tests need private symbols of their owning language package.
Their sources still live under `tests/integration/`, and the runners keep the
original package identity: Go sources are compiled through overlays by
`tests/integration/go/run.mjs`, and Rust sources are wired in as test targets
of the owning crate. This must not add public production APIs, and root entry
points must not silently omit integration cases. The ACP service configuration
and lockfile stay with the service; root ACP integration sources reuse that
installation.

## Main targets

| Command                            | Coverage                                                                                                                                                                                                                                                                                     | Dependencies                                                      |
| ---------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| `make fmt-check`                   | gofmt, `cargo fmt`, Prettier for the ACP service and root `tests/**/*.mjs` / `*.ts`. `make fmt` applies the same formatters.                                                                                                                                                                 | Go, Rust, installed ACP service dependencies                      |
| `make lint`                        | `go-lint` (Go services and root Go integration/E2E sources, compiled but not executed), `rust-clippy` with `-D warnings`, and `node-lint` (syntax checks, ESLint and TypeScript type checks).                                                                                                | Go, golangci-lint, Rust, Node dependencies                        |
| `make test`                        | Test-storage policy, Go service and portable root integration sources, Rust tests, Python verification tools, Node support tests, ACP, Admin Console and Agent UI unit tests, and all E2E fixture validators. External database and Temporal profiles are not included.                      | Go, Rust, Node, Python 3                                          |
| `make test-go-unit`                | Go service-local unit tests only. `make test-go` also includes root sources through overlays.                                                                                                                                                                                                | Go                                                                |
| `make test-service-authentication` | Platform CCT schemas/signed vectors, token receiver/header/file/rotation/mode vectors, enforced caller catalogs and missing-route checks, JSON media-type probes, and development credential/PKI provisioning, CLI, cancellation and real TLS checks. Does not prove full-platform security. | Node, Go, OpenSSL, installed ACP dependencies; no Docker          |
| `make test-integration`            | Go PostgreSQL and Temporal tests, Rust dependency and SDK probes, ACP PostgreSQL and audit tests, and Admin Console and Agent UI browser integration.                                                                                                                                        | Docker, local PostgreSQL and Temporal images, Playwright browsers |
| `make test-postgres`               | All service PostgreSQL tests in one disposable dependency project, including the Agent Controller Temporal tests.                                                                                                                                                                            | Docker, local PostgreSQL and Temporal images                      |
| `make test-<service>-postgres`     | One service's PostgreSQL tests: `egress`, `runtime-controller`, `agent-acp`, `identity`, `agent-controller`.                                                                                                                                                                                 | Docker; `agent-controller` also needs Temporal                    |
| `make e2e-*`                       | Deployed workflows under `tests/e2e/`; see below.                                                                                                                                                                                                                                            | Docker; some targets need Playwright                              |

`node tests/e2e/service-authentication/deployment-credentials/run.mjs` checks
private read-only generated mounts for every static service and sender-file atomic
replacement with no container network or host ports. It cleans its own containers
and credentials; it is deployment preparation evidence, not a business workflow.

`node tests/e2e/service-authentication/development-pki/run.mjs` checks each
static service's private, read-only leaf/key and public CA mounts in an isolated
nonroot container. Actual loopback mTLS accepts the generated identity and rejects
missing certificates and wrong server names. Containers have no network or host
ports and cannot see the CA private key. It cleans owned containers/keys and is
PKI preparation evidence, not platform mTLS or business acceptance.

The PostgreSQL targets run through `tests/support/dependencies.mjs`, which
starts a uniquely named Compose project, runs the command and removes the
project's containers, volumes and network on exit. It explicitly loads
`compose.debug.yaml` and assigns loopback ports; base Compose has no dependency
publications. Full-stack entry points select the same overlay before stage3,
so application diagnostic ports remain suppressed.

`make test-deployment-ports` renders all Compose profiles and both overlay orders,
verifying the Gateway-only base and exact loopback diagnostic mappings. It needs
the Compose CLI, but no running Engine. `make e2e-deployment-ports` uses a fresh
PostgreSQL/Temporal project to verify a real database query and Temporal's gRPC
system-info/namespace calls through Docker-assigned host ports, then verifies
owned resource cleanup. This is deployment-tooling evidence; full platform
security and business acceptance remains in the final integration batch.

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

| Targets                                                                                                                                                                                                                                                                                                       | Scenario directory                                                         | Coverage                                                                                                                                                                                                                                                                                           |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `e2e-stage1`, `e2e-stage2`, `e2e-stage3`, `e2e-stage3-local`, `e2e-runtime-controller`                                                                                                                                                                                                                        | `tests/e2e/`, `runtime-controller/`, `stage3-base/`                        | Runtime and Runtime Controller, identity and Agent orchestration, and the full admin control plane through the Gateway.                                                                                                                                                                            |
| `e2e-runtime-controller-observation-retry`                                                                                                                                                                                                                                                                    | `runtime-controller/`                                                      | Docker socket loss during startup and Watch, HTTP 200/503/200 recovery without process restart, shared observation readiness and Runtime initialize/delete. Watch-only loss also verifies lifecycle calls remain available. Uses an isolated socket proxy and a separately tagged candidate image. |
| `e2e-acp-session`, `e2e-acp-closeout`, `e2e-acp-persistence`, `e2e-acp-restart`, `e2e-tool-progress`, `e2e-file-observations`, `e2e-structured-plan`, `e2e-tool-permissions`, `e2e-slash-commands`, `e2e-multimodal`, `e2e-session-cost`, `e2e-rpc-response-loss`, `e2e-managed-mcp-v1`, `e2e-managed-mcp-v2` | `acp-*/`, `rpc-response-loss/`, `managed-mcp/`                             | ACP protocol behavior on the full stack. Each is an opt-in flag of `tests/e2e/e2e-stage3a.sh`.                                                                                                                                                                                                     |
| `e2e-identity-core`, `e2e-identity-access`, `e2e-agent-access`, `e2e-organization-display`                                                                                                                                                                                                                    | `identity-closeout/`                                                       | Login, sessions, access control, Agent access and real local/OIDC Organization display through Node/SSR/browser.                                                                                                                                                                                   |
| `e2e-lifecycle`, `e2e-lifecycle-shutdown`, `-health`, `-restore`, `-interrupted`, `-network`, `-loss`, `-crash`                                                                                                                                                                                               | `lifecycle-closeout/`                                                      | Agent and platform lifecycle, normal shutdown, health, backup restore, interruption, network loss and Runtime loss. `e2e-lifecycle-crash` is an abnormal-exit diagnostic excluded from the stable targets.                                                                                         |
| `e2e-workspace`, `e2e-workspace-browser`                                                                                                                                                                                                                                                                      | `workspace-closeout/`                                                      | Agent UI workspace protocol and browser behavior.                                                                                                                                                                                                                                                  |
| `e2e-agent-ui-receipt-contract`                                                                                                                                                                                                                                                                               | `agent-ui/`                                                                | A real failed Run through Gateway and Chromium; actual ACP receipt/observation JSON validates against the shared schema and Node parsers; workspace failure survives reload. Builds isolated current ACP, Agent UI, Gateway, Identity and RC candidates without replacing local tags.              |
| `e2e-gateway-security-headers`                                                                                                                                                                                                                                                                                | `edge-gateway/`                                                            | Existing-conversation navigation/reload through Gateway and Chromium, one upstream CSP, nonce script execution, blob image/audio loading, and zero CSP violations. Uses the local model fixture and isolated current candidates; verifies cleanup preserves the retained Docker environment.       |
| `e2e-stage3-skill-delivery`, `e2e-stage4-skill-*`, `integration-stage4-skill-*`                                                                                                                                                                                                                               | `stage3-base/`, `lifecycle-closeout/`, `tests/integration/skill-registry/` | Skill package delivery to Runtimes, including Registry outage, races, response loss, drift and restore.                                                                                                                                                                                            |
| `e2e-skill-learning-*`, `e2e-runtime-tool-usability`                                                                                                                                                                                                                                                          | `skill-learning/`                                                          | Automatic Skill learning: creation and update, notices, preemption, policy and lifecycle cancellation, install interruption and resend, key rotation, model failure and recovery, restart and browser checks.                                                                                      |
| `e2e-skill-discovery-*`, `e2e-skill-temporary-*`, `e2e-skill-deployment`, `e2e-skill-source-lifecycle`, `e2e-skill-registry-trace`                                                                                                                                                                            | `skill-registry/`, `skill-learning/`                                       | Skill Registry discovery, temporary Runtime use, Console promotion, Template propagation and source lifecycle.                                                                                                                                                                                     |

`e2e-skill-learning-runtime` verifies that the default Runtime image has an empty
test-feature label, no test-feature startup opt-in, and `test_features: []` on
its live `/status`; that signed requests for the retired transaction actions are
unknown; and that `install` and `digest` work across dual-key trust and old-key
removal. It then runs the gate-image install suite. The `e2e-skill-learning-install-after-rename-*` variants
explicitly build `--target e2e` with `skill-maintenance-e2e-gate`, check its
image label and startup opt-in, and verify the live status and single feature
warning before pausing an install after its rename. The install interruption
harness accepts isolated RC/Identity candidates through
`ANTNEST_E2E_RUNTIME_CONTROLLER_IMAGE` / `ANTNEST_E2E_IDENTITY_IMAGE` and the
Gateway candidate through `ANTNEST_C4_EDGE_GATEWAY_IMAGE`; deploy the new RC
reader before using the new Runtime status producer.

The Stage 3a profile runners start their client detached and read its result
with `docker logs`. Docker splits output lines longer than 16 KiB, and the
json-file log driver replaces a multi-byte character cut by that split with
U+FFFD. These clients therefore print every JSON line through
[`support/ascii-json.mjs`](support/ascii-json.mjs), which escapes non-ASCII
characters; `support/ascii-json.test.mjs` finds the clients from the runners
and rejects raw `JSON.stringify` output.

All Skill E2E flows use a local deterministic model fixture. The browser
targets (`e2e-workspace-browser`, `e2e-skill-learning-browser`,
`e2e-skill-learning-diagnostics-browser`, `e2e-skill-discovery-console`) need
installed Playwright Chromium and close their browsers before Docker cleanup.
`e2e-agent-ui-receipt-contract` also uses the local model fixture and needs
Playwright Chromium and the standard local stack images. Its captured receipt
evidence defaults to `artifacts/verification/`; override its directory with
`ANTNEST_UI_RECEIPT_E2E_OUTPUT`. It closes Chromium, removes its labeled candidate
images and compares the retained Docker environment after cleanup.

`e2e-gateway-security-headers` has the same prerequisites and uses no external
model provider. Set `ANTNEST_GATEWAY_SECURITY_E2E_OUTPUT` to override its private
evidence directory. It also removes its owned candidates and verifies that
retained containers, volumes, networks and image references are unchanged.

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

## Continuous integration

`.github/workflows/integration.yml` runs the suites on every push to `main`,
on manual runs, and on a pull request when it is opened, reopened or marked
ready for review, or when the `ci:full` label is added. Each later push to a
pull request, and every push to a draft, runs only `Repository checks` and the
path-filtered service workflows (lint, unit tests, image build). Such runs
report `Integration checks (not run)`, so the required `Integration checks`
stays pending until a full run covers the head commit: add `ci:full` before
merging. The run removes the label, so add it again after further pushes.
[`support/ci-mode.mjs`](support/ci-mode.mjs) decides the mode.

[`support/ci-changes.mjs`](support/ci-changes.mjs) holds the suite
catalog: each suite lists its commands, host setup, prebuilt images and the
paths it exercises. The workflow runs only the suites that match the changed
files (prose-only changes select none). Changes to the workflow, `tests/support/`,
`contracts/` or the `Makefile` select every suite.

Suites are grouped into shards by product area (`shards` in the catalog).
Each shard is one CI job, `Tier <tier> / <shard>`: it installs the setup and
images its selected suites need and runs them in order on one runner through
[`support/ci-shard.mjs`](support/ci-shard.mjs). Every selected suite runs even
after an earlier one fails, each in its own process group with a timeout, and
the job summary lists each suite's result. Destructive suites come last in
their shard. Every suite starts and removes its own stack, so a shard reuses
pulled images and host setup but no platform state.

- **Tier A:** PostgreSQL and Temporal component suites, browser suites,
  deployment render contracts and the Runtime SDK probe.
- **Tier B:** service-owned Docker E2E runners. Each starts its own
  isolated candidate images; runners that start images with `--no-build` get
  `antnest/<image>:local` first.
- **Tier C:** whole-platform scenarios whose rule spans services (stage 3a,
  authenticated shell stage 2 and lifecycle, lifecycle and workspace closeout,
  skill learning). Platform targets that test one service's rule, or behavior
  that is not settled, stay out of CI; `outsideCI` in `ci-changes.mjs` names
  the issue that moves each one to its service or re-admits it. At most six
  tier C shards run at a time. Tier C reports per shard but is not part of
  `Integration checks` yet. Lifecycle and
  workspace foundation runners and the Stage 3a identity, tool permission and
  tool progress profiles exit 2 when business and topology checks pass but
  strict trace findings remain. The shard passes such a suite with a warning
  only when [`support/strict-findings.mjs`](support/strict-findings.mjs) finds
  no Jaeger warning other than clock skew adjustments in its output; error spans on denial and cancellation paths
  are recorded by contract and checked by each runner's topology. The findings
  stay in the evidence artifact. The Stage 3a profiles run their make
  recipe directly because make reports every failed recipe as 2. Tool permission and tool
  progress first build the test-only `antnest/antnest-runtime:managed-integration`
  image with `make docker-build-managed-runtime`.

Each local image is named `ghcr.io/tf4fun/antnest-<image>:inputs-<hash>`,
where the hash covers the image's Dockerfile, `.dockerignore` and every path
the Dockerfile copies. Suites pull images that GHCR already has. The image job
builds each missing image once per run and hands it to the shards as an
artifact; shards that need no image start without waiting for it. Runs on
`main` build and publish every missing image, so a pull request that does not
change an image's inputs never rebuilds it. Every shard job runs the steps in
`.github/workflows/_suite.yml`.

Runners never rebuild a provided image. The shard lists its images in
`ANTNEST_CI_PROVIDED_IMAGES`, and
[`support/candidate-images.mjs`](support/candidate-images.mjs) turns each
candidate build into a label-only build `FROM antnest/<image>:local` that
keeps the labels cleanup checks ownership with. Outside CI the runner builds
from source. The catalog also defines Runtime test variants: the `e2e` stage
with the Skill install gate, the managed MCP fixture alone and the release
image with that fixture. The image job builds them with their own cache.
The provided Runtime images passed the Dockerfile's `fmt`, `clippy` and test
gates when the image job built their inputs.

A manual run (`gh workflow run integration.yml --ref <branch> -f suites='<id> <id>'`)
runs only the named catalog suites, in their shards; without `suites` it runs
every suite.

Each shard uploads `artifacts/verification/` (without fixture credentials) as
the `evidence-<shard>` artifact. The `Integration checks` job is the single
required status; it fails if suite selection or any selected tier A or B suite
fails. Add a suite by extending the catalog and naming it in one shard of its
tier; the catalog's unit tests check that every `make` target and runner it
names exists and that every suite belongs to exactly one shard. A suite with a `disabled` reason stays in the
catalog but is never selected until its known breakage is fixed.

A failed Stage 3a run (`tests/e2e/e2e-stage3a.sh`) omits raw service logs
because they may contain credentials. Instead it prints one
`{"startup_failures":[...]}` line from `tests/support/startup-failure-summary.mjs`.
That line covers each exited, restarting, OOM-killed or unhealthy container and
gives its exit code and health, the `msg` and `error.code` of its ERROR-level
structured records, and the first line of any panic or uncaught error. A field
containing a credential the run provisioned is replaced with
`[withheld: credential]`.

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
