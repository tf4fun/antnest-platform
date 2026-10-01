# Development deployment drivers

This directory contains explicit opt-in E2E drivers that run against an
existing development deployment. They use the deployed Gateway, the ACP SDK,
PostgreSQL and Jaeger to check Agent state, Session replay, chat Traces,
lifecycle operations, Runtime loss and recovery. No default `make` target runs
them, and they never start or deploy the platform themselves.

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

| Driver | Required configuration | Effects and assertions |
| --- | --- | --- |
| `agent-state.mjs` | `gateway`, `envFile`, `output`, `agentId` or `browserReport`; optional `reportBasename` | Logs in and reads management and execution state. Requires the matching Agent identity, a ready state, no active Session and allowed access. Writes `<reportBasename>.json` (default `agent-state`). Read-only: it requests no lifecycle change and no Run. |
| `replay.mjs` | `gateway`, `jaeger`, `envFile`, `output`, `database`, `agentId` and `sessionId` or `browserReport` | Checks Session ownership and working directory, reads existing messages from PostgreSQL, then loads the Session through the SDK. Compares decoded history and file changes, requires unchanged row counts in the four history tables, and checks the load request and connection Trace. Writes private updates, the Trace and `replay-report.json`. Never sends a prompt. |
| `trace-review.mjs` | `jaeger`, `envFile`, `secretFile`, `output`, `sessionId` or `browserReport`, `expectedTraceCount`, `minRuntimeTraces` | Queries chat Traces for the Session and checks the expected count, topology, allowed timing diagnostic category and the minimum number of Traces that contain Runtime calls. Saves raw Traces and a separate review. Makes no model request. |
| `rejection-trace.mjs` | `jaeger`, `output`, `rejectedSessionId` or `metadataReport` | Queries the rejected Session's single prompt Trace. Requires the expected unsupported-content category, disabled content capture, and no model HTTP or Runtime Tool call. Saves the raw Trace and its review; does not issue another prompt. |
| `lifecycle.mjs` | `gateway`, `jaeger`, `envFile`, `secretFile`, `retainedAgentId`, `output`, `fixtureName`, `workspaceFile`, `workspaceMarker`, `runtimeControllerScope` | Uses the retained Agent's Template and owner to create a temporary Agent, writes a marker file in its workspace, then disables, enables, rebuilds and deletes it. Verifies workspace and volume retention and deletion, three independent execution publications and five lifecycle Traces. Compares the retained Agent's Runtime, configuration and revisions before and after. |
| `runtime-loss.mjs` | All `lifecycle.mjs` fields except `runtimeControllerScope`, plus `restartSnapshot` and `composeSnapshot` | Runs the temporary-Agent lifecycle, stops the temporary Agent's Runtime normally and removes the stopped container. Verifies the exited, absent and offline observations, an explicit source-missing Rebuild, workspace retention, the expected 404 Trace behavior and publications after the Runtime Controller start time. Deletes the temporary Agent and compares the retained Agent. |
| `recover.mjs` | `gateway`, `jaeger`, `envFile`, `secretFile`, `output`, `retainedAgentId`, `runtimeContainerPrefix`, `runtimeControllerScope`, `workspaceVolume`, `workspaceManifest` | Explicitly rebuilds the selected Agent after checking its failure, container identity and scope, and complete read-write workspace volume. Compares configuration, workspace bytes and volume, and the recovery Trace. |

`publication.mjs` is not a driver. It is the shared execution-publication
oracle used by `lifecycle.mjs`, `runtime-loss.mjs` and their integration
fixtures. It selects three independent root publication Traces after an
optional start-time cutoff and checks their topology, organization and that
content capture is disabled.

## Configuration rules

### Shared inputs

- URLs (`gateway`, `jaeger`) must be HTTP(S) origins without credentials, path,
  query or fragment.
- Agent and Session IDs must match the platform identifier format.
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

`fixtureName` names the temporary Agent. `workspaceFile` is the marker path
under `/workspace` and `workspaceMarker` is its exact expected content. Neither
`fixtureName` nor `workspaceMarker` may have leading or trailing whitespace, and
the marker path must not contain traversal or `.cache` segments. The marker is
written in the temporary Runtime, never in the retained Agent.

The created Agent must differ from the retained Agent before it becomes a
cleanup target. Before marker access, the driver checks the full Docker ID,
container name, Agent and managed-Runtime labels, `runtimeControllerScope` and
the complete read-write workspace volume. A structurally valid publication
Trace is saved before unexpected warnings fail the run, so failure evidence is
kept.

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
  HTTP checks as part of `make test`.
- Opt-in Docker gates exercise the drivers against owned shell containers, real
  workspace volumes and local Gateway and Jaeger adapters. Each requires a fresh
  output directory and an already installed image, does not pull images, and
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
HTTP, WebSocket and Jaeger adapters.

Agent UI metadata synchronization and model rejection are covered separately by
`tests/integration/agent-ui/workspace-bridge-browser.test.mjs` and the
full-stack `tests/e2e/agent-ui/fullstack-current.test.mjs`.
