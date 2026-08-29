# Antnest Runtime

Antnest Runtime is the per-Agent execution process. It runs inside one isolated
Linux container, establishes the container's network boundary, and exposes four
tools through the official MCP 2026-07-28 Streamable HTTP transport. The
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
- Read files through named roots; write and edit only the workspace.
- Carry structurally valid IPv4/TCP packets to Runtime Egress as one raw packet
  per UDP datagram, and reject unsupported local traffic without bypassing Egress.
- Accept MCP request cancellation, including terminating and reaping canceled
  `bash` process groups and descendants that change process group or session.
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
- Read-only container root filesystem.

The baseline image includes Python 3.12, Node.js/npm, Git, and curl. Runtime
does not model language-specific Skill runtimes or install dependencies on
behalf of the control plane; an Agent may use these tools inside its own
workspace.

The Runtime listens on an internal platform address for `GET /status` and
`POST /mcp`. Runtime Controller gives this endpoint to Agent Controller. Agent
Controller polls status and calls MCP `tools/list` before routing work to a new
generation. The endpoint accepts internal Docker/Kubernetes Host names and is
not published outside that trusted network.

`/status` is local application readiness: RuntimeSpec, Supervisor capabilities,
roots, TUN, the local network loop, and MCP are ready. Before binding HTTP,
Runtime also executes a UID/GID 1000 probe that verifies the workspace is
writable/traversable and the system Skill root is readable/traversable. It does
not probe Runtime Egress or claim end-to-end public connectivity. Controller
combines this signal with Runtime Controller and Egress deployment health
deployment before rollout.

Runtime permits one active tool execution and returns `runtime_busy` for a
concurrent call. Agent Controller still serializes the broader Agent operation,
including generation handoff, while Runtime owns only local process and
workspace correctness.

Actor admission is fail-closed. Shutdown closes it permanently, and an
unprovable Executor process-tree cleanup poisons it before Runtime exits; a
finished lease cannot reopen either terminal state. HTTP, network, and the
Execution Actor drain concurrently under one shutdown deadline before telemetry
is flushed.

Runtime is crash-only. If PID 1 exits, Docker or Kubernetes restarts it, or
Runtime Controller replaces the complete container or Pod. Bootstrap reconciles
Runtime-owned network artifacts even when the network namespace survives.
Runtime Controller reattaches the workspace; unchanged RuntimeSpec keeps the generation,
while a configuration change creates a new generation.

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
```

Crate-local checks from this directory are:

```bash
cargo fmt --all --check
cargo clippy --locked --all-targets -- -D warnings
cargo test --locked
```

The Docker build uses the crate's pinned Rust toolchain and supplies Linux-only
network, privilege, MCP, filesystem, and process-containment checks. Host checks
cover portable contract and configuration logic; the Docker build is the
required Linux admission gate. Building the image requires the platform
repository root because `contracts/runtime` is a shared, language-neutral
artifact. The binary requires Linux for TUN and privilege setup. Normal
execution is Controller-managed; launching it manually without generation
bootstrap values is expected to fail closed.

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
