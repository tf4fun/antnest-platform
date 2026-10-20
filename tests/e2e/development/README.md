# Development deployment drivers

This directory contains explicit opt-in E2E drivers that run against a
development deployment. They use the deployed Gateway, Identity,
private ACP transport, PostgreSQL and Jaeger to check Agent state, Session replay,
chat Traces, lifecycle operations, Runtime loss and recovery. Individual drivers
use an existing deployment. The explicit `e2e-development` target builds and
owns a disposable deployment for their combined acceptance; no default `make`
target runs it.

The in-progress migration of retired browser routes follows the
[private execution consumer contract](private-contract.md). Configuration,
state, replay and browser consumers are verified separately before the full
development deployment gate; shared-component acceptance is not driver acceptance.

## Complete disposable deployment

```sh
make e2e-development
```

The existing authenticated shell wrapper builds the Runtime and application
images from the current source with one fresh candidate tag. The runner starts
that stack, discovers its actual loopback diagnostic ports, and opens the real
Console and Agent UI in a browser. It creates the provider, model, Template and
Agent from the empty instance; controlled acceptance cannot reuse an Agent.

The test-only model implements the selected DeepSeek model's discovery and tool
protocol. Its six completion requests answer the original greeting, write/read
and restored-read prompts only after the actual Runtime tool results match.
Reports explicitly label this provider scope `controlled`; this gate does not
claim external provider availability. The separate browser CLI retains its
external-provider default.

After browser closure the runner executes state-before, replay-before,
chat-trace, rejection-trace, lifecycle, runtime-loss, recover, state-after and
replay-after in that order. The unsupported-audio prompt uses the original
Identity-authorized private connection. Its real RPC Trace is selected from the
original connection and request IDs before the CLIENT exporter shuts down.
Recovery stops the owned Agent Controller, restarts the original Runtime,
observes a healthy new execution identity, and starts the same Controller. It
waits for Controller health and the actual `runtime_execution_changed` state
before rebuilding, without modifying database state.

Acceptance requires all browser and driver reports, original Trace bindings,
candidate Runtime identities and retained workspace bytes. Service logs and
original failures are saved under fresh private `artifacts/verification/`
directories. Cleanup joins the owned resources and removes candidate image
references before the wrapper can report success. Unit and component results
alone do not constitute a passing deployed run.

## Running a driver

Run a selected driver from the repository root with an explicit JSON
configuration file:

```sh
node tests/e2e/development/agent-state.mjs --config /path/to/private-config.json
```

There are no defaults for Agents, containers, Compose projects, host ports or
evidence paths. Paths in the configuration are relative to the calling working
directory, not to the configuration file. `output` is a required evidence
directory; use a fresh private directory, normally under
`artifacts/verification/`, for each invocation. Drivers create output with a
private umask and write reports exclusively, so existing reports are never
overwritten. Credentials stay in `envFile` and `secretFile`; raw responses and
Traces remain private.

The drivers resolve Playwright (used as an HTTP client) from the Agent UI web
package. Install `services/agent-ui/web` dependencies before running them.

## Drivers

| Driver                | Required configuration                                                                                                                                                                 | Effects and assertions                                                                                                                                                                                                                                                                                                                                                                                |
| --------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `agent-state.mjs`     | `gateway`, `envFile`, `output`, `privateAccess`, `agentId` or `browserReport`; optional `reportBasename`                                                                               | Logs in and reads management and execution state. Requires the matching Agent identity, a ready state, no active Session and allowed access. Writes `<reportBasename>.json` (default `agent-state`). Read-only: it requests no lifecycle change and no Run.                                                                                                                                           |
| `replay.mjs`          | `gateway`, `jaeger`, `envFile`, `output`, `database`, `privateAccess`, `agentId` and `sessionId` or `browserReport`                                                                    | Checks Session ownership and working directory, reads existing messages from PostgreSQL, then loads the Session through the SDK. Compares decoded history and file changes, requires unchanged row counts in the four history tables, and checks the initialize/load requests and private connection Trace. Writes private updates, raw Trace sources and `replay-report.json`. Never sends a prompt. |
| `trace-review.mjs`    | `jaeger`, `envFile`, `secretFile`, `output`, `sessionId` or `browserReport`, `expectedTraceCount`, `minRuntimeTraces`                                                                  | Queries chat Traces for the Session and checks the expected count, Gateway HTTP / Agent UI Bridge / ACP HTTP topology, allowed timing diagnostic category and the minimum number of Traces that contain Runtime calls. Saves raw Traces and a separate review. Makes no model request.                                                                                                                |
| `rejection-trace.mjs` | `jaeger`, `output`, `rejectedSessionId` or `metadataReport`                                                                                                                            | Queries the rejected Session's single prompt Trace. Requires the expected unsupported-content category, disabled content capture, and no model HTTP or Runtime Tool call. Saves the raw Trace and its review; does not issue another prompt.                                                                                                                                                          |
| `lifecycle.mjs`       | `gateway`, `jaeger`, `envFile`, `secretFile`, `retainedAgentId`, `output`, `fixtureName`, `workspaceFile`, `workspaceMarker`, `runtimeControllerScope`                                 | Uses the retained Agent's Template and owner to create a temporary Agent, writes a marker file in its workspace, then disables, enables, rebuilds and deletes it. Verifies workspace and volume retention and deletion, three independent execution publications and five lifecycle Traces. Compares the retained Agent's Runtime, configuration and revisions before and after.                      |
| `runtime-loss.mjs`    | All `lifecycle.mjs` fields except `runtimeControllerScope`, plus `restartSnapshot`, `composeSnapshot` and `privateAccess`                                                              | Runs the temporary-Agent lifecycle, stops the temporary Agent's Runtime normally and removes the stopped container. Verifies the exited, absent and offline observations, an explicit source-missing Rebuild, workspace retention, the expected 404 Trace behavior and publications after the Runtime Controller start time. Deletes the temporary Agent and compares the retained Agent.             |
| `recover.mjs`         | `gateway`, `jaeger`, `envFile`, `secretFile`, `output`, `retainedAgentId`, `runtimeContainerPrefix`, `runtimeControllerScope`, `workspaceVolume`, `workspaceManifest`, `privateAccess` | Explicitly rebuilds the selected Agent after checking its failure, container identity and scope, and complete read-write workspace volume. Compares configuration, workspace bytes and volume, and the recovery Trace.                                                                                                                                                                                |

`publication.mjs` is not a driver. It is the shared execution-publication
oracle used by `lifecycle.mjs`, `runtime-loss.mjs` and their integration
fixtures. It selects three independent root publication Traces after an
optional start-time cutoff and checks their topology, organization and that
content capture is disabled. Lifecycle drivers wait up to two minutes for
three periodic publications on a fresh deployment. Discovery uses each
publication's own synchronous parent references and start time, so partial
unrelated or nested Traces do not abort discovery. The original first three
candidates are then collected and fully validated with the existing bounded
collector; a broken candidate is never replaced by a later healthy Trace.
HTTP, topology and publication validation failures still fail the run.

Each completed search is saved before selection as `publication-search-N.json`,
including empty searches. Selected details are saved before inspection as
`publication-<trace-id>.json`; this file retains the latest original sample if
validation fails. Failure to preserve a search result stops the driver.

## Configuration rules

### Shared inputs

- URLs (`gateway`, `jaeger`) must be HTTP(S) origins without credentials, path,
  query or fragment.
- Agent IDs must match the platform identifier format. Session IDs retain the
  original `session_` plus 32 lowercase hex digits from the Browser Bridge or
  the UUID from an existing private ACP Session.
- Configuration, environment and report inputs must be ordinary durable files.
  Unknown options, existing report targets and symbolic-link report paths are
  rejected before any HTTP call.
- `browserReport` is a JSON file with `agent_id` and `session_id`. Explicit
  `agentId` and `sessionId` override the report fields. `metadataReport`
  supplies `rejected_session_id`, which `rejectedSessionId` overrides.
- `reportBasename` may contain only letters, digits, underscore and hyphen, and
  must start with a letter or digit.
- `agent-state.mjs` requires the three bootstrap login fields in `envFile`.
  `trace-review.mjs` requires the bootstrap password and a secret environment
  file.

### Private execution state

`agent-state.mjs`, `recover.mjs` and `runtime-loss.mjs` require
`privateAccess: { credentials, acp, identity, otlp }` before any HTTP or Docker
call. `acp` and `identity` are explicit HTTP loopback origins with ports; `otlp`
is the loopback `/v1/traces` endpoint. `credentials` names a durable directory
containing the existing `edge-gateway/tokens/identity-service` and
`agent-ui/tokens/agent-acp-service` workload grants.

Each driver uses the original login Cookie and Principal for Identity
authorization and validates the full private state response. The obsolete public state path
has no fallback. `private-access.private.json` retains the original state and
authority receipts, errors and joined cleanup result. Passing reports are written
only after private requests, telemetry and evidence writes finish.

### Private Session replay

`replay.mjs` requires the same `privateAccess` configuration. It checks the
original database Session and history before login, authorizes the original login
Cookie and Principal through Identity, then opens one private connection. The
shared SDK initializes once; the driver sends one `session/load` and no Prompt.
It joins that connection before comparing the four table counts, collecting the
initialization and load Traces, and closing the exporter.

`replay-updates.private.json` retains the original notifications.
`private-access.private.json` contains connection and authority receipts, errors
and cleanup status. `replay-trace.private.json` indexes initialization and load
reports whose `evidence_directory` values point to the complete raw sources under
`traces/`. Each requires three stable source samples. The passing
`replay-report.json` is written after cleanup succeeds. Existing `traces/`
directories and aliases are rejected before HTTP or Docker effects.

### Trace review limits

`expectedTraceCount` and `minRuntimeTraces` are explicit numbers for the
selected chat scenario. Both must be at least 2, `minRuntimeTraces` cannot
exceed `expectedTraceCount`, and `expectedTraceCount` cannot exceed 20. Trace
review uses a one-hour query window and a limit of 20. Rejection review uses a
one-hour window, a limit of 10 and requires exactly one matching Trace.

Lifecycle and chat review reports keep per-Trace strict timing results
separately. A business `passed` value does not mean every strict Trace check
passed. A rejection review is an expected-failure scenario, not a successful
chat Trace result.

### Replay database

`database` is an object with exactly `container`, `user` and `name`. Role and
database values must be simple identifiers, not connection strings. Replay runs
`docker exec <container> psql` with those values; it never creates, restores or
drops a database, and it requires existing messages for the selected Session.
All configuration, credentials, output paths and encoded history are validated
before login. Loading a Session can update Session activity, so unchanged row
counts do not prove that no existing row changed.

### Lifecycle and Runtime loss

Create, Enable and Rebuild declare asynchronous Skill preparation, including an
empty Skill set. The existing lifecycle inspector accepts only its precise
preparation states on the original Workflow with a later successful admission;
unknown errors and missing successful retries fail. Raw lifecycle Traces are
saved before inspection so failed validation retains its original evidence.

Absence probes are validated individually and grouped by their original owning
Span. Create requires storage and Runtime creation probes; Enable and Rebuild
require Runtime creation probes. Preparation and cleanup may add valid probes,
so their total is recorded rather than fixed. Missing required boundaries,
foreign owners, ERROR probes and missing successful allocation still fail.
Runtime loss independently requires its single original source-generation
absence and the subsequent replacement. Docker resource names are not present
in these Traces; owner groups do not claim to identify individual helper or
receiver resources.

`fixtureName` names the temporary Agent. `workspaceFile` is the marker path
under `/workspace` and `workspaceMarker` is its exact expected content. Neither
`fixtureName` nor `workspaceMarker` may have leading or trailing whitespace, and
the marker path must not contain traversal or `.cache` segments. The marker is
written in the temporary Runtime, never in the retained Agent.

The created Agent must differ from the retained Agent before it becomes a
cleanup target. Before marker access, the driver checks the full Docker ID,
container name, Agent and managed-Runtime labels, `runtimeControllerScope` and
the complete read-write workspace volume. Original publication details are
saved before topology or warning validation, so failed samples remain available.

`runtime-loss.mjs` derives the scope and publication cutoff from two private
inputs:

- `restartSnapshot`: the Runtime Controller `docker inspect` object. Its
  `State.StartedAt` must be a valid nonzero RFC 3339 timestamp and becomes the
  publication cutoff.
- `composeSnapshot`: the resolved Compose JSON containing
  `services["runtime-controller"].environment.ANTNEST_RUNTIME_CONTROLLER_SCOPE`.

The Runtime Controller must have a full container ID, the
`/<compose.name>-runtime-controller-1` name, matching Compose project and
service labels, and exactly one scope environment entry matching Compose. The
driver stops the Runtime with `docker stop -t 10 <full ID>`, requires exit code
zero without OOM, observes `runtime_exited`, removes the same container,
observes absence and the offline App state, then rebuilds. Publications are
collected after deletion with a 120-second search deadline; three distinct roots
must start after the cutoff and must not reuse lifecycle Trace IDs.

### Recovery

`recover.mjs` reads its SHA-256 `workspaceManifest`, credentials and full
configuration before any HTTP or Docker call. The manifest uses complete
`sha256sum` lines with a final newline; an empty workspace is a single newline.
`runtimeContainerPrefix + retainedAgentId` must match the inspected container
name. The Runtime must carry matching Agent, managed-Runtime and
`runtimeControllerScope` labels, and `/workspace` must be exactly the configured
`workspaceVolume`, writable and not shadowed by nested mounts or tmpfs. After
the rebuild, the driver requires a new container ID and hashes the complete
workspace in that container. A successful report contains exactly one rebuild.
No automatic rollback or retained-Agent deletion happens after a failed
rebuild.

## Cleanup

`lifecycle.mjs` and `runtime-loss.mjs` attempt public Agent deletion of the
temporary Agent in their final cleanup if the scenario did not already delete
it. Read-only drivers (`agent-state.mjs`, `trace-review.mjs`,
`rejection-trace.mjs`) and `replay.mjs` create no platform resources.
`recover.mjs` rebuilds only the configured Agent and leaves the result in
place.

## Driver fixtures

The driver logic is also checked without a development deployment:

- `tests/integration/development/*.test.mjs` runs the drivers' CLI and local
  HTTP checks as part of `make test`, alongside the owning helper tests in
  `tests/e2e/development/*.test.mjs`.
- Opt-in Docker gates exercise the drivers against owned shell containers, real
  workspace volumes and local Gateway and Jaeger adapters. The migrated state
  drivers also use original-login Identity and private ACP state adapters. Each
  requires a fresh output directory and an already installed image, does not pull images, and
  removes its containers and volumes before comparing the remaining Docker
  resources:

```sh
node tests/integration/development/lifecycle-docker.mjs \
  --image postgres:17-bookworm --output artifacts/verification/lifecycle-fixture
node tests/integration/development/runtime-loss-docker.mjs \
  --image postgres:17-bookworm --output artifacts/verification/runtime-loss-fixture
node tests/integration/development/recovery-docker.mjs \
  --image postgres:17-bookworm --output artifacts/verification/recovery-fixture
node tests/integration/development/replay-docker.mjs \
  --postgres-image postgres:17-bookworm --output artifacts/verification/replay-fixture
```

The recovery gate image must contain `sh`, `find`, `sha256sum` and `tar`. The
replay gate uses a disposable PostgreSQL database, the pinned SDK and local
login, Identity, private ACP WebSocket and Jaeger adapters. It verifies the
actual SDK CLIENT OTLP export and observed request IDs, with synthetic peer
SERVER Traces. Ten cases cover normal replay, preserved Trace warnings, foreign
Session/Principal rejection, changed history/file diffs, extra execution, empty
or malformed history, and output aliases. This is adapter acceptance; full
Development service deployment is verified separately.

An optional `--history-root` accepts preserved `runtime-sync-20260921` and
`temporal-sync-20260921` directories containing the original PostgreSQL dump,
updates, report and Trace. The adapter restores the dump and checks the same
business history. Archived Gateway reports and Traces are validated separately
and saved unmodified in `historical-replay.private.json`; they are never rebound
to the new private connection. Historical credentials are not rechecked.

Agent UI metadata synchronization and model rejection are covered separately by
`tests/integration/agent-ui/workspace-bridge-browser.test.mjs` and the
full-stack `tests/e2e/agent-ui/fullstack-current.test.mjs`.
