# Retained development acceptance

**Migration checkpoint:** Runtime/Temporal final checks and the idle-restart
entry have passed contract, historical-Trace and disposable-Docker checks.
Controller final checks also pass contracts, historical-report compatibility
and disposable Docker/PostgreSQL verification.
Agent-state, chat-Trace review and rejection-Trace drivers also pass configuration,
actual CLI/local-HTTP and saved-report replay checks; their nine originals have
left cache. The SDK Session replay entry also passes contracts, disposable
PostgreSQL/pinned-SDK checks and both historical database restores; its two
originals have left cache. Recovery also passes 79 related checks and ten actual
Docker scenarios, including the original workspace archive and recovery report;
its original has left cache. Ordinary lifecycle passes 118 related checks and
nine Docker cases, including three exact historical reports; its three originals
have left cache. Runtime-loss passes 159 related checks and seven actual Docker
cases, including its exact historical report; its original has also left cache.
The former metadata browser driver passed 239 related checks, 44 focused
contracts and nine UI/Chromium cases before retirement. Its historical source
remains archived outside cache; current Agent UI metadata and model rejection
are checked through the HTTP/SSE browser fixture and six-service E2E.
Runtime deployment now passes 22 stateful entry tests and six actual Docker
cases, including missing-container recovery; its original has left cache. Controller 20260921 also passes
12 focused entry tests, six actual Docker cases and legacy snapshot/report-field
compatibility. Controller 20260917 now passes 96 support/38 integration tests, nine
actual Docker cases and legacy compatibility; the shared 20260921 profile also
passes six rerun Docker cases. Temporal now passes 96 support/50 integration
tests, eight actual Docker cases and saved-evidence compatibility. All 25 source
originals have left cache; final integration is complete in the
[cache exit record](../../../docs/cache-source-exit.md). No retained environment
was deployed or restarted by this source migration. Source presence alone is
not a completion claim.

These eight JavaScript drivers recover reusable acceptance code previously kept only in
ignored task caches. They use the existing Gateway, SDK, persistence and Trace
oracles. They are explicit E2E entry points: ordinary test targets do not run
them against a retained environment. Moving a driver is not a fresh deployment
acceptance result. Verification and execution scope are recorded only in the
[test layout migration report](../../../docs/test-layout-migration.md).

Run a selected driver from the repository root with an explicit JSON config:

```sh
node tests/e2e/development/agent-state.mjs --config /path/to/private-config.json
```

There are no real Agent, container, project, host-port or historical-evidence
path defaults. Paths in the config are relative to the calling working directory,
not the config file. `output` is a required evidence directory; use a separate
private directory for each invocation because the drivers retain their original
report filenames. They create output with a private umask. Credentials stay in
`envFile` / `secretFile`, and raw responses and screenshots remain private.

## Driver configuration and effects

| Driver | Required configuration | Effects and assertions |
| --- | --- | --- |
| `agent-state.mjs` | `gateway`, `envFile`, `output`, `agentId` or `browserReport`; optional `reportBasename` | Logs in and reads management/execution state; requires matching Agent identity, ready, no active Session and allowed access. Writes `<reportBasename>.json` (default `agent-state`); does not request Agent lifecycle changes or a Run. |
| `replay.mjs` | `gateway`, `jaeger`, `envFile`, `output`, `database`, `agentId` and `sessionId` or `browserReport` | Checks Session ownership/cwd and reads existing messages from PostgreSQL, then loads the Session through the SDK. Compares decoded history/file changes, requires unchanged four-table row counts and checks the actual load request/connection Trace. Writes private updates, Trace and `replay-report.json`. |
| `trace-review.mjs` | `jaeger`, `envFile`, `secretFile`, `output`, `sessionId` or `browserReport`, `expectedTraceCount`, `minRuntimeTraces` | Reads saved Session identity and queries chat traces; checks the expected count, topology, allowed timing diagnostic category and minimum number containing Runtime calls. Saves raw traces and a separate review. It makes no model request. |
| `lifecycle.mjs` | `gateway`, `jaeger`, `envFile`, `secretFile`, `retainedAgentId`, `output`, `fixtureName`, `workspaceFile`, `workspaceMarker`, `runtimeControllerScope` | Uses the retained Agent's current Template/owner to create a temporary Agent. Writes its fixture file, disables/enables/rebuilds/deletes it, verifies workspace/volume retention and deletion, three independent publications and five lifecycle traces. Compares the retained Agent's Runtime/configuration/revisions before and after. |
| `runtime-loss.mjs` | All `lifecycle.mjs` fields except `runtimeControllerScope`, plus `restartSnapshot`, `composeSnapshot` | Runs the temporary-Agent lifecycle, stops its owned Runtime normally and removes that stopped container. Verifies exited/absent/offline observation, explicit source-missing Rebuild, workspace retention, expected 404 Trace behavior and publications after the supplied start-time cutoff. Deletes the temporary Agent and compares the retained Agent. |
| `rejection-trace.mjs` | `jaeger`, `output`, `rejectedSessionId` or `metadataReport` | Queries the rejected Session's single prompt Trace, requires the expected unsupported-content category, disabled capture and no model HTTP or Runtime Tool call. Saves raw Trace and its review; does not issue another prompt. |
| `recover.mjs` | `gateway`, `jaeger`, `envFile`, `secretFile`, `output`, `retainedAgentId`, `runtimeContainerPrefix`, `runtimeControllerScope`, `workspaceVolume`, `workspaceManifest` | Explicitly rebuilds the selected Agent after checking its failure, container identity/scope and complete RW workspace volume. Compares configuration, workspace bytes/volume and its recovery Trace. Verified with isolated fixtures; not a default retained-environment gate. |

`browserReport` is a JSON file with `agent_id` and `session_id`. Explicit
`agentId` and `sessionId` override the corresponding report fields. A driver
reads only the identities it needs. Historical `metadataReport` supplies
`rejected_session_id`; `rejectedSessionId`
overrides it.

`database` is an object with `container`, `user` and `name`. Replay invokes
`docker exec <container> psql` with those explicit values. It does not create,
restore or drop a database. Its SQL remains the original saved-history/count
comparison, and it requires existing messages for the selected Session.
Replay's database object permits only `container`, `user` and `name`; role and
database values must be simple identifiers, not connection strings. It validates
all configuration, credentials, three output leaves and encoded history before
login/load. Loading can restore Session activity, so unchanged row counts do not
claim that no existing database row can change. The driver never sends a prompt.
Trace polling may update only the raw file created by the current writer, with
device/inode checks and `O_NOFOLLOW`; other reports are exclusive. Intermediate
raw snapshots and the original three-sample convergence rule are preserved.

Recovery reads its SHA-256 `workspaceManifest`, credentials and full configuration
before HTTP/Docker, and rejects existing or symbolic-link targets for all four
reports. The manifest uses complete `sha256sum` records with a final newline;
an empty workspace uses one newline. `runtimeContainerPrefix + retainedAgentId`
must match the inspected container name. The Runtime must carry matching Agent,
managed-Runtime and `runtimeControllerScope` labels; `/workspace` must be exactly
the configured `workspaceVolume`, writable and unshadowed by nested mounts or
tmpfs. The old Runtime execution ID is deliberately not equated with a Docker
container ID. Recovery requires a new container ID after rebuilding and executes
the complete workspace hash against that immutable new ID. Traversal/read errors
propagate before sorting. Only this invocation's raw Trace file may be updated
during convergence; the other reports remain exclusive.

The unused historical publication helper was removed; the report still contains
empty `checks` and `publication` arrays and exactly one rebuild on success. No
automatic rollback or retained-Agent deletion is performed after a failed rebuild.
The opt-in migration gate uses shell containers as isolated Runtime stand-ins,
real Docker mounts and local Gateway/Jaeger adapters:

```sh
node tests/integration/development/recovery-docker.mjs \
  --image postgres:17-bookworm --history-root artifacts/verification \
  --output artifacts/verification/recovery-fixture-new
```

Use a fresh output directory and an already installed image with `sh`, `find`,
`sha256sum` and `tar`. The history option checks the original report/Trace and
restores original workspace bytes; only Agent identity is rebound for the
isolated CLI. Fixture read permissions differ from the archived UID so the
unprivileged checker can separately test unreadable files/directories. This is
not a new deployed Controller/Runtime recovery acceptance result.

`expectedTraceCount` and `minRuntimeTraces` are explicit numeric expectations for
the selected chat scenario; both must be at least 2, and the Runtime minimum
cannot exceed the expected count, which must not exceed 20. Trace review retains the original one-hour query
window and limit of 20. Rejection review retains a one-hour window, limit of 10
and exactly one matching trace.

The three verified read-only entries (`agent-state`, `trace-review`,
`rejection-trace`) validate configuration and all report filenames before any
HTTP call. URLs must be HTTP(S) origins without credentials, path, query or hash.
Agent/Session IDs must match the platform format. Env/report/config inputs must
be ordinary durable files; the three bootstrap login fields are required for
Agent state, and the bootstrap password plus a secret env file for chat review.
Unknown options, existing report targets and symbolic-link report leaves reject.
Writers recheck paths and create mode-600 files exclusively. Use a fresh output
directory or a new Agent `reportBasename` containing only letters, digits,
underscore and hyphen, beginning with a letter or digit. This preserves the
historical before/intermediate/final report workflow without overwriting evidence.

`fixtureName` names the temporary Agent. `workspaceFile` identifies its synthetic
file under `/workspace`; `workspaceMarker` is the exact expected content. The
file is written in the temporary Runtime, not the retained Agent. Both lifecycle
drivers attempt public Agent deletion in their final cleanup if needed.

Ordinary lifecycle validates configuration, credentials and all fixed report
leaves before HTTP. `fixtureName` and `workspaceMarker` cannot have edge whitespace;
the marker path must be under `/workspace` without traversal or `.cache` segments.
The created Agent must differ from the retained Agent before it can become a
cleanup target. Before marker access, the full Docker ID, name, Agent/managed
labels, `runtimeControllerScope` and complete RW workspace volume are checked.
Resolved paths also reject symlink escapes and cache targets. Trace/request IDs
are distinct. Only this writer's own progress/raw Trace files may be updated;
other reports are exclusive. A structurally valid publication Trace is saved
before unexpected warnings cause failure, preserving failure evidence.

Its opt-in migration gate uses real owned shell containers and workspace volumes
with local Gateway/Jaeger fixtures:

```sh
node tests/integration/development/lifecycle-docker.mjs \
  --image postgres:17-bookworm --history-root artifacts/verification \
  --output artifacts/verification/lifecycle-fixture-new
```

Use a fresh output directory and an already installed image. Nine cases cover a
synthetic success, five expected failures and three historical report replays.
Only temporary Agent identity is rebound; all fifteen historical lifecycle strict
failures remain. This does not repeat deployed Controller business acceptance.

`restartSnapshot` is a private Runtime Controller Docker inspect object with
`State.StartedAt`; Runtime-loss uses that time as the publication cutoff.
`composeSnapshot` is the
resolved private Compose JSON containing
`services["runtime-controller"].environment.ANTNEST_RUNTIME_CONTROLLER_SCOPE`.
Both ordinary files are read before any HTTP/Docker call. The Controller must
have a full container ID, the matching `/<compose.name>-runtime-controller-1`
name and Compose project/service labels, and exactly one scope environment
entry matching Compose. `StartedAt` must be a valid nonzero RFC3339 timestamp.
Scope is derived from these inputs; there is no additional scope config field
for Runtime-loss. The two files must describe the intended run; no old snapshot
is selected implicitly.

Runtime-loss shares the ordinary lifecycle's input/output and Runtime/workspace
checks. It keeps `docker stop -t 10 <full ID>`, verifies exit zero and no OOM,
observes `runtime_exited`, removes that same stopped container, observes absence
and App offline state, then rebuilds. Both Agent state routes must return the
expected identity. Trace validation binds the actual missing source generation
to its replacement, with five absence probes and no Runtime Controller errors.
Publications are collected after delete, with the original 120-second search
deadline. Three distinct roots must meet the restart cutoff in both search and
collected detail responses and must not reuse lifecycle Trace IDs.

The opt-in gate uses owned shell Runtime containers and real workspace volumes
with local Gateway/Jaeger fixtures:

```sh
node tests/integration/development/runtime-loss-docker.mjs \
  --image postgres:17-bookworm --history-root artifacts/verification \
  --output artifacts/verification/runtime-loss-fixture-new
```

Use a fresh output directory and an installed image. Seven cases include the
original report/Trace replay and an exit-7 rejection before rebuild. Historical
Controller snapshots retain their scope/cutoff; only temporary Agent identity is
rebound in the CLI report. All five historical lifecycle strict failures remain.
This proves migrated driver behavior, not fresh deployed Controller recovery.

The browser drivers resolve Playwright from the Agent UI web package. Install
that package's dependencies and Chromium before a browser invocation. The
metadata driver uses the configured real model and can incur usage; ordinary
layout checks do not invoke it. Its browser closes and signal hooks are removed
in `finally`.

## Result and historical boundaries

### Verified Python final/restart entries

Invoke these with `python3 -B tests/e2e/development/<entry>.py --config <file>`.
All four require `output`; configuration and output paths must be durable,
including existing leaf files. Unknown selectors are rejected, and existing final
reports are never overwritten. Configuration paths ending in `_path` are
relative to `output` unless absolute.

- `runtime-final-checks.py` and `temporal-final-checks.py` require
  `agent_before_path`, `agent_final_path`, `lifecycle_report_path`,
  `replay_report_path`, `temporary_agent_path`, `after_snapshot_path`,
  `replay_trace_path`, `lifecycle_trace_glob`, `publication_trace_glob`, and
  `summary_path`. Runtime also requires `runtime_controller_container`;
  Temporal requires `agent_controller_container` and `compose_snapshot_path`.
  Relative globs select files under `output`; every resolved leaf is validated.
- The selected evidence must contain exactly five lifecycle kinds (create,
  disable, enable, rebuild, delete), three publications and one replay: nine
  distinct files and trace IDs, bound to the report IDs and lifecycle Agent/
  request identities. Every publication must start after the live Controller's
  start time, independent of filenames. Strict failures remain counted.
- `idle-restart.py` requires `controller_container` ending in
  `-agent-controller-1`. This entry really stops/starts that container. It checks
  a healthy starting state, normal exit zero, the same container ID, a changed
  start time and recovered health. The migration verification used an owned
  disposable fixture; it did not restart a retained Controller.
- `controller-final-checks.py` requires `postgres_container`, `database_user`,
  `database_name`, `runtime_container_prefix` (exactly `antnest-runtime-`),
  `browser_report_path`, `agent_before_path`, `agent_final_path`,
  `temporary_agent_path`, `trace_review_path`, `final_report_path`, and
  `workspace` with `container`, `path` (exactly `/workspace`) and `volume`.
  Browser, Agent snapshots and three Trace reviews must agree on identities.
  The entry checks live Session ownership, three settled Runs/Tool attempts,
  schema rejections without attempts, full Agent-state equality, the marker
  inside the expected RW volume, no active Run anywhere and temporary-resource
  absence. Strict warnings remain counted separately.

Final checks use fixed historical/formal process entries, normalized path
spellings and conservative bare-name matching. The checker and its actual
ancestor chain are excluded; arbitrary `process_scope`, `process_exclude`,
`verification_commands`, `processPatterns` and `publication_trace_prefix`
configuration are not accepted. Run verification serially.

The disposable gate is
`python3 -B tests/integration/verification/development-final-docker.py --image debian:bookworm-slim --output <fresh-evidence-directory>`.
It uses an installed image, two isolated containers and synthetic business/Trace
reports. It verifies a real normal restart, Docker resource/process reads and
an old-publication failure, then removes both fixtures and compares the entire
retained environment. The separate historical replay checks 18 saved raw Traces
and both summary JSONs. Temporal's latest restart inspection was not saved; its
replay uses the saved deployment inspection and does not claim to prove that
historical latest-restart cutoff.

Controller's disposable gate is
`python3 -B tests/integration/verification/controller-final-docker.py --postgres-image postgres:17-bookworm --runtime-image debian:bookworm-slim --output <fresh-evidence-directory>`.
It uses installed images, actual PostgreSQL/Docker and synthetic business data;
two successful cases and eleven expected failures cover the CLI assertions.
It removes owned containers and volume and compares retained resources/images.
The separate saved-report compatibility check does not replay historical SQL,
workspace bytes or cleanup. Neither gate repeats browser business acceptance.

### Integration closeout

All development source originals have passed migration checks and left cache.
Runtime missing-container recovery now passes 22 flow tests, 96 support/54
integration tests and six real Docker cases. The final storage/ledger/regression
audit passes: 3,364 checks in the complete Node/Python gate, five existing opt-in
skips, unchanged retained resources/images and no remaining test processes.
Detailed scope and earlier failed attempts remain in the cache exit report.

### Temporal deployment migration

`deployment/temporal-20260921.py` retains `before`, `deploy`, `restart`, `resume`
and `after`, using the whole daemon snapshot, including stopped containers.
Temporal requires `candidateImage`, `localTag` and `rollbackTag`; its optional
`candidateTag` is checked when present. Agent Controller requires only its own
`rollbackTag`: its image remains unchanged. The Temporal local tag already
points to the candidate before `before`, although the running container can use
the old image. All tag aliases must be distinct after normalization.

The baseline binds configuration, explicit and effective Compose, full/safe
container snapshots, four ACP row maps and complete workspace manifest bytes.
Runtime identity/scope comes from the unchanged Runtime Controller and its
complete RW workspace volume. The old Temporal probe is recorded as it is;
historical TCP readiness is allowed before the candidate adds
`CMD sh /etc/temporal/readiness.sh`.

Deployment stops Agent Controller then Temporal, requiring normal exit zero
without OOM. With both stopped, it dumps and lists Temporal, visibility, Agent
Controller and ACP databases in that order through private exclusive files.
Temporal starts and becomes healthy before Agent Controller starts. Restart
preserves both full IDs and requires changed start times. `resume` waits for
Temporal, then starts only Agent Controller; it does not impose an idle SQL gate
or start Temporal. A validated resume record completes the binding after a
partial deployment and is consumed by later stages.

Failed deployment restores old Temporal before the consumer. Existing old
containers are started by full ID; confirmed-absent or observed replacements can
be recreated. A private recovery Compose override pins old image IDs and their
saved healthchecks, because the old image need not contain the new readiness
script. Restart/resume recovery uses the bound current IDs. Successful recovery
retains the original failure, and failed dependency recovery leaves the consumer
stopped. Candidate mount/network and readiness changes reject immediately.

`after` preserves complete mounts/networks and requires every original container
running, with original health expectations. Both services' images are checked;
all other containers retain ID, StartedAt and restart count. ACP row maps must
match exactly, including no added rows, and complete workspace hashing propagates
find/read failures. Both idle checks and final environment/readiness checks must
pass. Counts are calculated from the validated snapshot. Its ordinary `after.json`
may update safely; baseline, backup and stage files are fresh/private.

The isolated gate is:

```sh
python3 -B tests/integration/verification/temporal-deployment-docker.py \
  --output artifacts/verification/temporal-deployment-NEW
```

The fixture uses installed images and creates a disposable candidate containing
only its shell readiness fixture; it exercises actual Compose, PostgreSQL and
workspace files, not a real Temporal server. It does not restart retained
containers to satisfy global `after`: stopped retained containers remain an
expected negative, while the complete daemon component model proves the positive.
`verify-temporal-deployment.py` validates the actual saved baseline/deployment
records, four original archive hashes and recorded outcomes. It retains the
older Compose-start failure and subsequent resume/restart success without
inventing a missing latest-restart/after inspect or raw final SQL/workspace data.

### Runtime deployment migration

`deployment/runtime-20260921.py` retains the four explicit modes `before`,
`deploy`, `restart` and `after`. Start with a new `before` capture in a fresh
durable evidence directory; historical snapshots without
`deployment-context.private.json` are not silently promoted. Later modes bind
configuration and baseline hashes, compare freshly resolved Compose (including
environment interpolation), and validate live full IDs before SQL or mutations.
Candidate/local/rollback image aliases must be distinct. Each mode preflights
its private output leaves; only ordinary `after.json` may be updated.

The three database backups remain separate `pg_dump -Fc` archives checked by
`pg_restore --list`, with actual byte counts and SHA-256. Only Runtime Controller
is stopped for its database archive. Stop, backup, promotion, startup, report and
normal interruption failures trigger bounded recovery after service mutation;
successful recovery still returns the original failure. A failed recovery
retains that cause. Commands target bound full IDs; Compose updates recheck the
known target and effective configuration. If the old container has disappeared,
recreation requires two successful exact-name absence checks, unchanged Compose
and every other baseline ID/name. An unknown replacement or failed query cannot
authorize recreation. Workspace hashing covers every file,
preserves the empty-manifest digest and propagates traversal/read errors.

The root integration test executes the full four-mode chain with a complete
daemon model including an unrelated project. It is included in
`make test-verification-python`. The opt-in actual Docker gate is:

```sh
node tests/support/run-command.mjs --output artifacts/verification/runtime-deployment-gate \
  --name docker --timeout-ms 600000 --grace-ms 60000 -- \
  python3 -B tests/integration/verification/runtime-deployment-docker.py \
  --output artifacts/verification/runtime-deployment-fixture
```

The fixture output must not exist. The installed `node:24-bookworm-slim` and
`postgres:17-bookworm` images supply shell Controller/Runtime and PostgreSQL
fixtures; the gate does not pull images or deploy production services. It tests
normal deployment/restart, backup failure recovery, candidate exit rollback,
recovery after normal removal before creation, and find/hash failures. Whole-daemon `after` keeps its original all-running
assertion: a shared daemon with stopped retained containers is an expected
negative case; its positive chain is verified by the component model. Cleanup
compares all retained resources and image references after removing owned
containers, volume and tags. CLI descendants are owned by the shared runner.

### Controller 20260917 deployment migration

`deployment/controller-20260917.py` keeps `before`, `agent-controller`,
`runtime-controller`, `after` and `final`. The two service modes may run in either
order. Its contract differs from the later single-service profile: every
non-target container, including the retained Runtime, keeps its original ID.
The running-container snapshot covers the entire Docker daemon, including other
projects. Five mount fields and network names remain equal; original four-table
rows remain unchanged, while additions are allowed.

Declare both services' distinct candidate/local/rollback tags and candidate IDs,
all three database roles, `/workspace` container/volume, and the five report paths
`browser`, `agentBefore`, `agentFinal`, `temporaryAgent`, `lifecycle` before the
baseline capture. Reports may be produced later, but their paths and all other
configuration remain bound to the private baseline context. Three online
archives are verified in Agent Controller, Runtime Controller, ACP order.
Each service deployment binds any already completed sibling to its saved full
inspect and only updates the selected service. Failed promotion, Compose,
health or interruption restores that service's old image while preserving the
original failure; confirmed absence after removal permits recreation. A sibling
already at its candidate image stays there.

Final acceptance retains eight browser checks, three completed Runs, three
settled tool attempts and exactly two schema rejections without execution.
Browser/Agent/Session/Runtime identities and the complete RW workspace bind
before marker reads. Marker comparison preserves every byte, including trailing
newlines, and resolved paths must remain outside `.cache`. Agent snapshots stay
equal except `checked_at`; six temporary-resource probes and the process check
must be clear. Lifecycle warnings keep the original clock-prefix allowance;
this profile does not add a strict-Trace success requirement. Both final success
files are created only after all assertions pass.

The isolated gate is:

```sh
python3 -B tests/integration/verification/controller17-deployment-docker.py \
  --output artifacts/verification/controller17-deployment-NEW
```

It uses installed images, owned shell services, actual PostgreSQL and a workspace
volume. Browser/lifecycle reports and ACP business rows are fixture inputs; this
is not a replay of deployed Gateway, Provider or Trace behavior. Historical
compatibility uses `tests/support/migrations/verify-controller17-deployment.py`.
It compares saved snapshots/report fields and preserves the original browser
Trace failure plus five lifecycle strict failures; historical live SQL/workspace
and cleanup claims are not re-proven by that static comparison.

### Controller 20260921 deployment migration

`deployment/controller-20260921.py` retains `before`, `agent-controller`, `after`
and `final`. All modes now require explicit `workspace` and `reports.recovery`,
including the future recovery file path during `before`. Capture a new baseline
in a fresh durable output directory; old safe snapshots cannot replace the new
complete context. Baseline reports, full inspect, resolved Compose and all three
private `pg_dump -Fc` archives are hashed and bound to configuration. Each archive
is checked with `pg_restore --list` through its original open descriptor.
Output leaves are private/exclusive; reuse a completed mode's evidence only for
reading, not overwriting.

This profile preserves the original **all running containers** scope, including
other projects, and the original five mount fields plus network/image checks.
It allows new ACP rows while requiring every original row's MD5 to remain the
same. Before deployment, full live IDs and resolved Compose must still match.
The 120-second Compose wait is preserved. Candidate, report and normal signal
failures restore the known old Controller, or recreate it after confirming its
absence and the other baseline container identities. Recovery keeps the original
failure; it does not turn the deployment into a passing result.

The five recovery fields are `before_id`, `after_id`, `workspace`,
`configuration_preserved` and `workspace_bytes_preserved`. They must bind the
configured Runtime and RW volume, distinct full Docker IDs, true preservation
flags and the actual current Runtime identity/labels. They do not contain an
Agent generation or prove a new Trace acceptance. `after` and `final` require
the recovery to have occurred. The historical earlier `after` snapshot predates
that recovery, so compatibility checking intentionally rejects it; the later
`final` snapshot passes without changing historical data or its strict failure.

The complete daemon-model chain and failure tests run in
`make test-verification-python`. For actual Compose/PostgreSQL/workspace checks:

```sh
node tests/support/run-command.mjs --output artifacts/verification/controller-deployment-gate \
  --name docker --timeout-ms 600000 --grace-ms 60000 -- \
  python3 -B tests/integration/verification/controller-deployment-docker.py \
  --output artifacts/verification/controller-deployment-fixture
```

The fixture output must be fresh. Installed Node/PostgreSQL images provide owned
shell services; no retained service is restarted, no image is pulled, and cleanup
compares all retained resources and tags. Its six cases include a real Runtime
rebuild and explicit Controller removal-before-create failure. Legacy evidence
compatibility uses `tests/support/migrations/verify-controller-deployment.py`
with explicit `--history` and fresh `--output`. It checks saved fields and static
identity only: the saved full inspect was captured after services stopped, so no
healthy full baseline or new live SQL/Trace result is reconstructed from it.

The three verified read-only entries have 22 actual CLI/local-HTTP integration
cases under `tests/integration/development/read-only.test.mjs`, included in
`make test-node`, plus shared configuration and oracle checks. Historical replay
uses `tests/support/migrations/verify-development-reads.mjs --evidence <verification-root> --output <fresh-directory>`.
It compares thirteen saved Agent reports (excluding `checked_at`), four raw chat
Trace collections and one rejection Trace. HTTP Agent replies are reconstructed
from saved reports and credentials are fixtures; this is not current Gateway,
Jaeger or browser business acceptance. The four recorded strict failures remain.

Replay's opt-in gate is
`node tests/integration/development/replay-docker.mjs --postgres-image postgres:17-bookworm --output <fresh-directory> [--history-root <verification-root>]`.
It uses an installed image and a disposable database, pinned SDK, and local
HTTP/WebSocket/Jaeger adapters. Two synthetic success cases and seven negative
cases cover original assertions and new preflight/binding checks. With a history
root it restores the original Runtime/Temporal `antnest_agent_acp.dump` backups,
sends saved SDK notifications and checks exact original reports (71 messages,
69 notifications each). Saved Trace timestamps/warnings remain unchanged; only
connection/request links are rebound to the actual new SDK request. Runtime's
strict failure and Temporal's strict pass remain. The fixture uses the shared
process-group runner, removes its database and compares retained resources/images.

### Preserved results

The migrated code preserves its business assertions and report formats.
Lifecycle and chat review reports retain per-trace strict timing results;
a business `passed` value is not a claim that every strict Trace check passed.
Rejection is an expected failure scenario, and its review is not a successful
chat Trace result. Saved raw evidence is not rewritten.

Controller and Temporal ordinary lifecycle drivers were the same scenario apart
from fixture labels and paths, so they use `lifecycle.mjs`. The older Controller
query selected unfiltered publications; the migrated source is the later version
that selects independent roots. Runtime-loss keeps its separate source-missing
flow and post-start publication cutoff. Ordinary lifecycle now has a shared
publication oracle and shares Runtime/workspace helpers with recovery and
Runtime-loss. Runtime-loss retains its separate flow and validated cutoff.

The old `idle-restart.py` assertions also appear in the current
[shutdown scenario](../lifecycle-closeout/README.md) and
[shutdown evidence helper](../lifecycle-closeout/shutdown-evidence.mjs).
The old `recover.mjs` and four deployment scripts are records of completed
candidate-specific upgrades or recovery. Their explicit manual copies are not
default executable workflows. Their database/workspace snapshots remain evidence
of those upgrades; reusable container/image/resource comparison is owned by
[the environment tool](../../support/verification/README.md).

The complete 134-file source disposition and original reports are linked from
[the cache inventory](../../../docs/cache-test-inventory.md). Consult the
[migration report](../../../docs/test-layout-migration.md) for actual validation;
this README does not assert a new successful run against a retained environment.

### Agent UI metadata and rejection integration

The old Vite/WebSocket metadata driver and its local fixture were retired with
the browser ACP entry. Current metadata synchronization, reload without prompt
replay, model rejection copy and composer recovery are checked by
`tests/integration/agent-ui/workspace-bridge-browser.test.mjs`. The real
Gateway/Identity/Node/ACP/Controller/Runtime path, including durable rejection
class, provider non-invocation and reload, is checked by
`tests/e2e/agent-ui/fullstack-current.test.mjs`. Historical source and private
evidence remain in the cache migration archive and verification record.
