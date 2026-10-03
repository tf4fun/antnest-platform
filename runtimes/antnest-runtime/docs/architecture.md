# Antnest Runtime Architecture

This document describes the Runtime domain model, bootstrap sequence, execution
boundary, network boundary, failure semantics, and module ownership.

## Mission

Antnest Runtime gives one Agent an isolated Linux workspace and exposes that
workspace through four built-in MCP tools, configured managed stdio tools and
a bounded information Resource. Agent reasoning, scheduling, generation selection,
container lifecycle, persistence, and audit stay outside this process.

Runtime is an internal remote MCP server. It is not an Agent, a Controller, a
service registry, or an API gateway.

## Domain Model

Runtime is composed from a small domain model before any subsystem starts:

- `RuntimeIdentity`: stable Agent ID plus immutable generation;
- `RuntimeSpec`: identity, listen address, network spec, and filesystem spec;
- `NetworkSpec`: the required UDP Egress endpoint plus the TUN and resolver
  addresses assigned to this Agent;
- `FilesystemSpec`: workspace and system-Skill root locations. Runtime's
  `write` and `edit` tools target only the workspace; mount permissions belong
  to Runtime Controller's platform adapter/container policy.

The `ANTNEST_RUNTIME_SPEC` environment value is the one deployment adapter that
decodes the machine-readable RuntimeSpec contract. MCP, tools, filesystem,
network, and telemetry depend on the domain model and must not import
environment parsing types or reconstruct the spec from parallel fields.

## Runtime Identity

Runtime identity is the pair `(agent_id, generation)`:

- `agent_id` is a stable 1-255 byte visible-ASCII identifier for the Agent and
  its workspace;
- `generation` is the Controller-assigned deployment generation frozen in RuntimeSpec;
- a process restart within that deployment retains its generation but changes
  `execution_id`; recovery/replay of the same lifecycle operation also retains
  its already-allocated target generation;
- every new Initialize, Update or Enable allocates a new generation, even when
  the requested configuration is unchanged.

Each PID 1 start also generates a fresh `execution_id`, returned by `/status`
and checked against the expected-execution header before MCP dispatch. It
detects a changed process environment even when the generation is unchanged;
it is not a credential, connection epoch or deployment generation. There is no
separate admission/Egress token. Docker or Kubernetes and their internal network
are trusted infrastructure. Platform resource IDs remain Controller details.

## Bootstrap Sequence

The binary has explicit Supervisor, one-shot Executor and managed stdio modes:

```text
antnest-runtime serve
antnest-runtime bash
antnest-runtime read
antnest-runtime write
antnest-runtime edit
antnest-runtime info
antnest-runtime mcp-stdio
```

`serve` is the long-lived Supervisor; `mcp-stdio` replaces itself with one
configured non-root server. The Supervisor does not listen until its execution
boundary and all required managed servers are ready.

Before this bootstrap, `serve` rejects compiled test features unless
`ANTNEST_RUNTIME_ALLOW_TEST_FEATURES` is exactly `true`. An admitted test binary
logs one `test_features_enabled` warning. Release binaries contain no test
features; this variable cannot enable them. Docker's default `release` target
builds without features, while the explicitly selected `e2e` target labels and
opts in its separate test binary.

Bootstrap then proceeds as follows:

1. Require container PID 1 and root, then load the immutable RuntimeSpec.
2. Set the Agent home and XDG locations beneath `/workspace`.
3. Reconcile the Runtime-owned resolver file, TUN, UID policy route, and
   fail-closed nftables rules. The root Supervisor replaces deployment-platform
   DNS stubs with the single virtual resolver from RuntimeSpec before any
   Executor exists, then verifies the exact file. Reconciliation deletes only
   exact owned entries, rejects any conflicting reserved table/priority
   content, and leaves the platform main routing table intact.
4. Validate that the workspace and system-Skill roots can be opened by
   UID/GID 1000.
5. Initialize telemetry and the single-flight Execution Actor.
6. Connect the UDP Egress socket selected by RuntimeSpec, register the TUN file
   with the asynchronous reactor, and verify the assigned packet path with a
   bounded IPv4/TCP probe to a permanently rejected documentation address.
   Failure to register the local TUN reactor reports `local_network_failed`;
   Egress connection or probe failure reports `network_transport_failed`. Both
   are startup preparation failures rather than background task failures. Agent
   Controller must allocate the Agent network before creating the Runtime.
7. Drive the packet loop while starting and discovering the configured stdio
   MCP servers. Required initialization shares a bounded 30-second deadline.
8. Bind the internal HTTP server and expose `/status` and `/mcp`. Continue
   forwarding packets and monitoring managed processes for the Runtime lifetime.

The PID 1 Supervisor remains root. It owns MCP, TUN, Egress, telemetry, signals,
and child-process reaping, but never executes Agent-selected filesystem or shell
operations in-process.

Any failure before step 8 exits the process. Runtime-owned network artifacts use
stable names and priorities and are reconciled on every start, so Docker or
Kubernetes may restart the container in an existing network namespace. Failure
to prove convergence is fatal. Runtime Controller may instead replace the complete
container or Pod sandbox through an explicit lifecycle operation. Both paths
retain the Agent workspace; a new Update/Enable advances generation, whereas
same-deployment restart or same-operation recovery retains its allocated value.

## Internal HTTP Surface

Runtime exposes exactly two internal endpoints:

| Endpoint | Purpose |
| --- | --- |
| `GET /status` | Current Runtime identity and application readiness |
| `POST /mcp` | MCP 2026-07-28 Streamable HTTP endpoint |

`/status` returns HTTP 200 only after local bootstrap is complete, every
fallible local network transport resource is registered, the assigned Egress
packet path has returned a matching readiness probe, the network loop is
running, and MCP can accept tool calls. The probe proves current Runtime-to-
Egress routing and Agent allocation, but deliberately does not claim public or
upstream DNS connectivity. If a required managed MCP server later becomes
unhealthy, `/status` returns HTTP 503 with `"status": "unavailable"` until the
process exits. The ready body is:

```json
{
  "agent_id": "agent-123",
  "generation": 8,
  "execution_id": "d83f89db-74f3-49df-a3b8-83d6718a45fd",
  "status": "ready",
  "test_features": []
}
```

The required `test_features` array reports compiled identity in both ready and
unavailable responses; it is empty for release binaries. See the
[status contract](../../../contracts/runtime/status.md). The RC reader must
be upgraded first; image admission is deferred to #29.

Runtime Controller performs one bounded `/status` request, verifies
`(agent_id, generation)`, and returns the ready endpoint to Agent Controller.
Agent ACP Service later calls MCP under a Run snapshot and supplies that
snapshot's expected execution ID on every request. Runtime rejects missing or
stale execution identity before MCP dispatch. Runtime performs no
self-registration and maintains no reverse control connection.

## File Observation Boundary

`file_observation.rs` defines transport-neutral location/change facts.
`tools.rs` observes them at the unprivileged execution boundary, using bounded
best-effort before-images for replacement and existing buffers for edit.
`file_observation_wire.rs` owns bounded JSON conversion for the private executor
codec and MCP result metadata. The MCP adapter keeps facts out of the ordinary
tool output schema. No ACP types, service persistence or post-write rereads are
added; ACP presentation is a separate consumer. See [contract](file-observations.md).

## MCP Tool Model

Runtime uses the pinned MCP revision, `2026-07-28`, through the
official Rust `rmcp` SDK. Antnest does not hand-write MCP framing, lifecycle,
cancellation, discovery, or version negotiation.

The server advertises tools and its information Resource. These four built-ins
are always present; configured managed stdio tools extend the discovered list:

| Tool | Effect |
| --- | --- |
| `bash` | Run `/bin/bash -lc` in a workspace-relative directory |
| `read` | Read bounded text from `workspace` or `system_skills` |
| `write` | Atomically create or replace a workspace text file |
| `edit` | Replace exactly one matching string in a workspace text file |

`tools/list` is the only tool-definition authority. Built-in input and output
schemas are generated from Rust types by the official SDK; managed stdio MCP
schemas are discovered from required children and namespaced without replacing
their parameter/output definitions. There is no separate
capabilities array or Antnest JSON-RPC schema.

Runtime disables the SDK Host allowlist because the endpoint is deliberately
reachable through dynamic internal Docker/Kubernetes names. The trusted platform
network, not application authentication or HTTP Host validation, is the access
boundary.

Runtime accepts at most one active tool execution. A second call receives the
stable `runtime_busy` tool error instead of entering an internal queue. This
single-flight boundary covers foreground tool calls, not all processes in the
workspace. Successful Bash calls may leave background jobs running across turns
and Runs; these jobs can modify files while later tools execute. Agent
Controller still serializes Agent Runs and replacement across generations, but Runtime
does not rely on that caller behavior for local correctness.

## Tool Execution Boundary

The MCP adapter maps each tool to a fixed executable subcommand. It never
constructs argv from untrusted input:

```text
MCP bash  -> /proc/self/exe bash
MCP read  -> /proc/self/exe read
MCP write -> /proc/self/exe write
MCP edit  -> /proc/self/exe edit
information Resource -> /proc/self/exe info
managed Tool -> SDK connection -> /proc/self/exe mcp-stdio -> configured executable
```

The root Supervisor's Execution Actor owns spawning, timeout, cancellation,
termination, and reaping. Every invocation uses cleared environment state,
piped stdin/stdout/stderr, and a dedicated process group. The subcommand drops
to UID/GID 1000 with empty supplementary groups and capability sets, enables
`no_new_privileges`, validates that state, then reads exactly one bounded JSON
request from stdin. It emits bounded newline-delimited progress frames and
exactly one terminal JSON response on stdout and
uses stderr only for bounded diagnostics.

The tool name is already encoded by the subcommand, so the JSON request has no
second tool discriminator. MCP DTOs exist only at the HTTP adapter. The Actor
and Executor exchange the same transport-neutral execution request/result
model used by `tools`; the private JSON codec adds no business fields, work
identity, replay metadata, or version negotiation. Parent and child execute the
same binary through `/proc/self/exe`.

The execution boundary preserves:

- bounded command time and output;
- cancellation that targets only the current invocation's process group;
- one owner for each direct child's exit status, with PID 1 separately reaping
  exited orphans without signaling live background jobs;
- named-root filesystem access;
- atomic workspace writes;
- `write` and `edit` constrained to the workspace named root;
- stable structured tool errors;
- no replay, retry, run, or audit semantics inside Runtime.

MCP is Runtime's only execution interface, but it is still an adapter. MCP DTOs
own external JSON decoding and generated schemas, then convert once into
transport-neutral execution requests whose constructors enforce command, path,
environment, timeout, and size invariants. The Actor, private Executor codec,
Executor entrypoint, and `tools` depend only on those execution types; neither
the MCP wire adapter nor its generated schema defines the execution model.

`contracts/runtime/runtime-spec.schema.json` is the language-neutral wire
authority for RuntimeSpec input. Rust constructors are the semantic domain
authority after decoding; neither the environment adapter nor a Rust-only DTO
shape may redefine the cross-service contract.

Structured tool errors are valid Executor responses and exit with status zero.
A non-zero Executor exit means the internal exchange did not complete and its
stdout is not authoritative. For `bash`, `write`, and `edit`, cancellation,
timeout, crash, or a lost response after execution begins is reported as an
unknown side-effect outcome; Runtime never claims that an unobserved operation
did not take effect.

Executor processes run as UID/GID 1000 with empty effective, permitted,
inheritable, ambient, and bounding capability sets plus `no_new_privileges`.
Normal completion never triggers container-wide process cleanup. Deliberately
detached jobs are not claimed to be contained by per-call cancellation. If the
actor cannot terminate/reap its direct Executor, it stops accepting calls and
delegates recovery to the container platform. Unobserved side effects remain
unknown, not rolled back.

The Supervisor keeps `CAP_KILL` so it can signal Executors after their
irreversible UID transition. Admission closure and execution activity are
separate state: shutdown rejects new calls, cancels the active call, and waits
for its lease before the process flushes telemetry. Container stop/rebuild owns
whole-environment reclamation. PID 1 reaps only exited orphans, excluding children
whose exit status is still owned by a tool or managed MCP task.

The production image provides Python, Node.js with npm, Git, and curl. Runtime
does not model language-specific Skill runtimes or install dependencies on
behalf of the control plane; an Agent may use these tools inside its own
workspace.

## Failure Semantics

Actor admission is fail-closed. Shutdown closes it permanently, and an
unprovable direct Executor termination or an abnormal Executor coordination
task exit poisons it before Runtime exits; a finished lease cannot reopen
either terminal state. Release builds keep Rust panic unwinding so Tokio can
report a coordination-task panic to this boundary. `panic=abort` is forbidden
because it would bypass poisoning, structured fatal logs, and telemetry flush.
HTTP, network, and the Execution Actor drain concurrently under one shutdown
deadline before telemetry is flushed. Failure of a required managed MCP process
makes Runtime unavailable and exits; normal tool cancellation does not restart
managed servers.

Runtime is crash-only. If PID 1 exits, Docker or Kubernetes restarts it, or
Runtime Controller replaces the complete container or Pod. Bootstrap reconciles
Runtime-owned network artifacts even when the network namespace survives, and
Runtime Controller reattaches the workspace.

## Private Skill Endpoints

Two private HTTP route families sit beside `/mcp`. They never appear in
`tools/list`, the information Resource, or model tool definitions, and ordinary
`tools/call` rejects the reserved `antnest_skill_maintenance_` and
`antnest_skill_temporary_` names.

- `POST /internal/skill-maintenance/{action}` applies Skill learning
  candidates. See [MCP contract](mcp-contract.md#skill-maintenance-boundary)
  and the [learning contract](../../../contracts/skill-learning/learning-api.md).
- `POST /internal/skill-temporary/install` and `/release` deliver signed,
  Run-bound temporary Skill packages as UID/GID 1000 files under a reserved
  workspace namespace and remove them on release, startup, and normal shutdown.
  While a temporary scope is active, new Bash calls are foreground-only and
  retire their own remaining subprocesses before returning. See the
  [temporary Skill contract](../../../contracts/runtime/temporary-skills.md).

Both require an Ed25519-signed ticket verified against keys in RuntimeSpec, and
all file effects still run through the Execution Actor and the UID/GID 1000
Executor. Missing verifier configuration keeps both route families closed.

## Explicit Runtime Replacement

Agent Controller owns the rebuild workflow without choosing physical generations:

1. close Agent Run admission and wait for the current Run to finish;
2. close the Egress attachment with CAS, including Egress-owned flow cleanup;
3. call Runtime Controller `UpdateRuntime` with the opaque source revision and
   complete target configuration;
4. Runtime Controller removes old compute, selects the next private generation,
   reuses workspace, and verifies replacement health and matching `/status`;
5. open the attachment with CAS after the replacement is ready;
6. atomically publish the new Agent ExecutionRevision and reopen admission.

Runtime does not implement drain, shutdown, candidate, or activation RPCs.
Runtime Controller owns physical generation allocation and platform resources.
An ambiguous platform effect or attachment barrier keeps Agent admission closed;
the existing operation must reconcile before another lifecycle mutation.

## Network Boundary

- root Supervisor traffic uses the unchanged platform main routing table;
- locally generated UID 1000 traffic is selected by an Agent policy route and
  sent to TUN instead of inheriting direct platform routes;
- nftables rejects UID 1000 traffic that bypasses TUN, reaches Runtime's own
  MCP port, or uses unsupported IPv6;
- every structurally valid supported packet is carried to Runtime Egress, which
  is the only network-policy authority;
- Runtime requires every outbound inner source and inbound inner destination to
  equal its assigned Tunnel IPv4; an Agent cannot select another Agent's Egress
  identity by forging packet headers;
- malformed or unsupported local packets are rejected or dropped without
  terminating Runtime;
- the MCP listen port is reachable only on the internal platform network;
- Agent-originated public traffic still enters TUN;
- changing an Agent policy does not create a new Runtime generation.

The UDP tunnel has no custom framing, batching, identity, heartbeat, retry, or
Trace envelope. Inner TCP owns retransmission and congestion control. MCP never
carries packet data and Runtime Egress never carries tool calls.

## Module Map

| Module | Responsibility |
| --- | --- |
| `main` | Explicit subcommand dispatch plus ordered `serve` bootstrap, signal handling, and composition |
| `spec` | Runtime identity and immutable domain specification |
| `config` | Strictly decode `ANTNEST_RUNTIME_SPEC` into the domain model |
| `execution` | Transport-neutral tool requests, results, and invariants |
| `privilege` / `evidence` | Root Supervisor and Executor privilege verification |
| `network` / `packet` | TUN, routes, kill switch, packet validation, and local rejection |
| `network_session` | Single raw-IP-over-UDP TUN tunnel loop |
| `protocol` | MCP input/output DTOs and generated JSON Schemas |
| `roots` | Named-root reads and atomic workspace writes |
| `executor` | Shared subcommand entry, privilege drop, and bounded JSON exchange |
| `tools` | Four execution operations without transport semantics |
| `execution_actor` | Single-flight spawn, cancellation, timeout, and process cleanup |
| `managed_mcp` | Validated stdio configuration, non-root launch, SDK discovery/call dispatch and child lifecycle |
| `progress` / `mcp_progress` | Transport-neutral bounded previews / request-scoped SDK notification delivery; see [contract](tool-progress.md) |
| `processes` | Direct-child wait ownership and PID 1 reaping of exited orphans |
| `startup` | Drive network forwarding during managed MCP initialization before HTTP readiness |
| `mcp` | Official SDK adapter, `/mcp`, and `/status` HTTP composition |
| `telemetry` | Structured logs and optional OTLP traces and metrics |
| `information` | Bounded Runtime information Resource collection |
| `file_observation` / `file_observation_wire` | File location and diff facts and their bounded wire encoding |
| `skill_maintenance_*` / `skill_candidate` | Signed maintenance tickets, candidate storage, check, and commit |
| `skill_temporary_*` / `skill_package_*` | Signed temporary Skill install/release and package validation |
| `tool_error` | Closed tool error code set and effect projection |

Runtime must not import Docker, Kubernetes, PostgreSQL, Agent scheduling,
templates, Skills Registry, ACP, Channel, or end-user authentication logic.

Runtime consumes the `/skills` mount Runtime Controller supplies. Its platform
adapter and the container platform are solely responsible for mounting it
read-only; Runtime
cannot enforce mount flags. Runtime's own MCP `write` and `edit` tools reject the
`system_skills` root, but Bash receives ordinary kernel permissions. Preparing,
updating, or versioning the mount is outside Runtime and does not add Skill
Registry behavior here.

## Contract Changes

Runtime has no legacy compatibility branch. A
change to RuntimeSpec, status, tools, tool schemas, or the UDP packet contract
must update the applicable file under `contracts/runtime`, Runtime DTOs or
domain types, contract tests, and these documents in one lockstep change.
Adding another built-in tool requires a deliberate architecture decision; it
is not a local handler-only edit. Configured managed tools use the existing
discovery/dispatch contract rather than extending this built-in list.

### Execution Identity Fence

Runtime, the language-neutral contract, and its consumers implement:

1. PID 1 generates a fresh random `execution_id` on every process start.
2. `/status` returns that value with `agent_id`, `generation`, and readiness.
3. Every MCP request carries the execution ID expected by the Agent Run
   snapshot in `X-Antnest-Expected-Execution-ID`.
4. Runtime rejects a missing or mismatched value with HTTP 409 before Tool
   dispatch.

This identity is a stale-execution consistency check, not an authentication
credential or rollout generation. A stale execution fails before Tool dispatch;
it is never transparently retargeted to a restarted process.
