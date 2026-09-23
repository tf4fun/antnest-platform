# Antnest Runtime

Antnest Runtime is the per-Agent execution process. It runs inside one isolated
Linux container, establishes the container's network boundary, and exposes four
tools and a Runtime information Resource through the official MCP 2026-07-28
Streamable HTTP transport. The
root Runtime Supervisor and per-call Agent Executors have distinct privilege
and network boundaries.

## Responsibilities

- Run `antnest-runtime serve` as root container PID 1 and own MCP, TUN, Egress,
  telemetry, signals, and process reaping.
- Send UID/GID 1000 traffic through TUN while preserving root control traffic
  on the platform main routing table.
- Execute `bash`, `read`, `write`, and `edit` through explicit one-shot
  UID/GID 1000 subcommands with no capabilities.
- Execute child processes with bounded time and output.
- Produce bounded live Bash output and managed MCP progress through standard
  request-scoped notifications; see [Tool progress](docs/tool-progress.md).
- Return bounded file locations and complete observed text differences in MCP
  result metadata, separate from model-facing output; see [File observations](docs/file-observations.md).
- Managed MCP elicitation is deferred pending official SDK support; see
  [Elicitation](docs/elicitation.md). No SDK fork or partial interaction bridge
  is maintained; existing non-interactive managed tools remain supported.
- Read files through named roots; write and edit only the workspace.
- Collect bounded environment information, root `AGENTS.md`, and Skill metadata
  through the non-root `info` subprocess for `antnest://runtime/info`.
- Carry structurally valid IPv4/TCP packets to Runtime Egress as one raw packet
  per UDP datagram, and reject unsupported local traffic without bypassing Egress.
- Preserve background processes across successful calls and turns. Cancellation
  targets only the current invocation's process group; PID 1 reaps exited orphans
  without terminating live jobs. Container stop/rebuild reclaims the environment.
- Expose `GET /status` only after bootstrap is complete.
- Emit structured stderr logs and optionally export HTTP/tool traces through
  OTLP.
- Preserve local trace correlation when OTLP export is disabled.

## Non-Responsibilities

- It does not create, replace, retire, or purge its container, Pod, or volume.
- It does not access Docker, PostgreSQL, or Controller persistence.
- It does not implement Agent loops, model calls, prompts, memory, or Skill
  Registry behavior.
- It does not choose or apply Agent network policy or authorize end users.
- It does not own Agent scheduling, Work/session identity, replay policy, or
  side-effect reconciliation.
- It does not implement service registration, discovery, or a reverse control
  connection.

## Execution Boundary

The long-lived `serve` process remains root but never executes Agent-selected
commands or filesystem operations. A single-flight Execution Actor starts the
matching `bash`, `read`, `write`, or `edit` subcommand for each MCP call. The
subcommand drops irreversibly to UID/GID 1000 with empty supplementary groups
and capability sets plus `no_new_privileges` before reading its request. Its
environment uses:

- `$HOME=/workspace`: persistent, writable Agent workspace.
- `/skills`: system Skills; Runtime Controller/container policy must mount this
  read-only.
- `$HOME/.antnest/skills`: persistent, writable personal Skills.
- `/tmp`: bounded ephemeral execution space.
- Root-owned image filesystem; Agent-selected work always runs as UID/GID 1000
  with no capabilities and can write only locations granted by Unix ownership
  or explicit mounts.

The baseline image includes Python 3.12, Node.js/npm, Git, and curl. Runtime
does not model language-specific Skill runtimes or install dependencies on
behalf of the control plane; an Agent may use these tools inside its own
workspace.

The Runtime listens on an internal platform address for `GET /status` and
`POST /mcp`. Runtime Controller performs one bounded status verification and
returns the endpoint to Agent Controller. Agent ACP Service discovers tools
through MCP only after acquiring a Run snapshot. The endpoint accepts internal
Docker/Kubernetes Host names and is not published outside that trusted network.

`/status` is local application readiness: RuntimeSpec, Supervisor capabilities,
roots, TUN, the assigned Egress packet path, the local network loop, and MCP are
ready. Before binding HTTP, Runtime executes a UID/GID 1000 probe that verifies
the workspace is writable/traversable and the system Skill root is
readable/traversable, then requires a matching packet response from Egress. The
packet probe does not claim end-to-end public connectivity. Runtime Controller
combines this startup signal with platform health before reporting the physical
Runtime ready.

Runtime permits one active tool execution and returns `runtime_busy` for a
concurrent call. Agent Controller separately serializes Agent Runs and explicit
Runtime replacement, while Runtime owns only local process and workspace
correctness.

The information Resource shares that execution boundary, is refreshed on each
read, and never returns complete Skill bodies or environment values. It supplies
facts for the ACP service, not a composed system prompt. Optional `mcp_servers`
in RuntimeSpec starts required UID/GID 1000 stdio processes and aggregates their
tools into the same `/mcp` endpoint. The information Resource does not duplicate
tool definitions or expose child addresses. See the [feature delivery plan](../../docs/runtime-context-and-managed-mcp.md)
for the completed Runtime, Controller and ACP delivery batches and integration
evidence. ACP reads fresh Runtime facts within its Run context budget.

Actor admission is fail-closed. Shutdown closes it permanently, and an
unprovable direct Executor termination or abnormal Executor coordination task
exit poisons it before Runtime exits; a finished lease cannot reopen either
terminal state. Release builds retain Rust panic unwinding so Tokio can report a
coordination-task panic to this boundary; `panic=abort` is forbidden because it
would bypass poisoning, structured fatal logs, and telemetry flush. HTTP,
network, and the Execution Actor drain concurrently under one shutdown deadline
before telemetry is flushed. Required MCP process failure makes Runtime
unavailable and exits; normal tool cancellation does not restart these services.

### Managed MCP Verification

The isolated Runtime suite uses a real PID 1 container, the official Rust SDK
stdio fixture, and a UDP readiness fixture. It needs no database, Provider or
running Controller. It covers initialization, empty configuration, process reuse,
UID/environment isolation, cancellation, background jobs, information reads,
child failure and shutdown, plus live Bash/stdio MCP progress, no-token silence,
failure/cancellation and progress payload exclusion from logs. The UDP fixture
is not a test of Egress policy or public network forwarding. The HTTP close
regression also needs Node and the installed ACP service dependencies, and starts
its own Jaeger container to check real SDK success and failure traces. See
[response close classification](docs/observability.md#mcp-response-close-classification).
Commands run
serially from the repository root:

```sh
docker build --target build -f runtimes/antnest-runtime/Dockerfile -t antnest/antnest-runtime:managed-build .
docker build -f runtimes/antnest-runtime/Dockerfile -t antnest/antnest-runtime:managed-e2e .
python3 tests/e2e/antnest-runtime/e2e_managed_mcp.py
```

Only the build stage contains the test fixture executable; it is not shipped in
the production Runtime image. The suite copies it into a temporary read-only
mount and removes its own containers/network/mounts after testing. Override
`ANTNEST_RUNTIME_BUILD_IMAGE` and `ANTNEST_RUNTIME_TEST_IMAGE` to select other
locally built tags. This isolated suite does not replace the separate completed
Controller/ACP integration recorded in the feature delivery plan.

Runtime is crash-only. If PID 1 exits, Docker or Kubernetes restarts it, or
Runtime Controller replaces the complete container or Pod. Bootstrap reconciles
Runtime-owned network artifacts even when the network namespace survives.
Runtime Controller reattaches the workspace. Same-deployment process restart
retains generation but changes execution ID. Each new Update/Enable allocates
a new generation even with unchanged configuration; exact operation recovery
retains its already-allocated target.

Runtime always uses a connected UDP socket to Runtime Egress. Each datagram
contains one complete, unfragmented IPv4/TCP packet. MCP never carries packet
traffic, and the packet tunnel has no business-level tracing. Root Supervisor
traffic uses the platform route table. UID 1000 Executor traffic enters TUN
and cannot use direct platform routes. Allow and deny decisions belong only to
Runtime Egress and can change without rebuilding Runtime.

## Integration Contract

The official `rmcp` SDK owns the MCP wire contract. `contract.json` records the
Antnest status path, MCP path, lifecycle rule, Runtime-owned single-flight rule,
protocol revision, and expected tool names. `packet-format.md` and
`packet-contract.json` and `packet-fixtures.json` define the separate tunnel
revision, constants, and bytes. Consumers must conform
to these shared artifacts; Runtime contains no legacy compatibility path.

## Local Validation

Repository admission from the repository root:

```bash
make fmt-check
make lint
make test-rust
docker build -f runtimes/antnest-runtime/Dockerfile -t antnest/antnest-runtime:local .
make e2e-stage1
```

Crate-local checks from this directory are:

```bash
cargo fmt --all --check
cargo clippy --locked --all-targets -- -D warnings
cargo test --locked
```

Unit and isolated component tests remain in the Runtime sources. SDK, wire,
network and process integration sources live in
[`tests/integration/antnest-runtime`](../../tests/integration/antnest-runtime).
Explicit Cargo test paths and test-only module includes keep the original
module names, private implementation access and test names. The commands above
continue to compile and run these sources. The isolated container suite and its
fixtures live in [`tests/e2e/antnest-runtime`](../../tests/e2e/antnest-runtime).

The Docker build uses the crate's pinned Rust toolchain and supplies the Linux
compile and test gate. `make e2e-stage1` is the production-shape admission
gate: it starts the real PID 1 binary with TUN and container capabilities,
checks the non-privileged execution and control-network boundaries, exercises
MCP, restarts Runtime to verify owned network-state reconciliation, and proves
Runtime/Egress policy changes. Host checks cover portable contract and
configuration logic; Linux-only integration cases require the Docker gate.
Building the image requires the platform repository root because
`contracts/runtime` and the root integration sources are copied into the build.
The binary requires Linux for TUN and privilege setup. Normal execution is
Controller-managed; launching it manually without generation bootstrap values
is expected to fail closed.

## Release Status

This service does not yet publish a production image. Local images use
`antnest/antnest-runtime:<development-tag>`. Before the first registry release,
the owning platform maintainers must define the immutable image repository,
version/tag policy, promotion pipeline, rollback procedure, and coordinated
Runtime/Controller/Egress contract rollout. A shared contract change must pass all
three consumers before any image is promoted.

## Maintainer Guide

- [`docs/architecture.md`](docs/architecture.md): bootstrap phases, execution model,
  module ownership, transport, filesystem, and network behavior.
- [`docs/mcp-contract.md`](docs/mcp-contract.md): status and four-tool MCP
  contract.
- [`docs/security-and-operations.md`](docs/security-and-operations.md): trust
  boundary, environment, privileges, mounts, and failure diagnosis.
- [`docs/observability.md`](docs/observability.md): structured logs, trace
  propagation, OTLP/Jaeger configuration, and telemetry data limits.
- [`../../contracts/runtime/contract.json`](../../contracts/runtime/contract.json):
  language-neutral status, MCP transport, tool-name, and packet-format contract.
- [`../../contracts/runtime/runtime-spec.schema.json`](../../contracts/runtime/runtime-spec.schema.json):
  language-neutral immutable RuntimeSpec contract supplied by Runtime Controller.
- [`../../contracts/runtime/packet-format.md`](../../contracts/runtime/packet-format.md):
  raw-IP-over-UDP tunnel contract.
- [`../../contracts/runtime/packet-contract.json`](../../contracts/runtime/packet-contract.json):
  authoritative packet revision and fixed protocol constants.
- [`../../contracts/runtime/packet-fixtures.json`](../../contracts/runtime/packet-fixtures.json):
  accepted and rejected language-neutral tunnel examples.
