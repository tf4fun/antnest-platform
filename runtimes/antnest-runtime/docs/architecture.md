# Antnest Runtime Architecture

## Mission

Antnest Runtime gives one Agent an isolated Linux workspace and exposes that
workspace as four MCP tools. Agent reasoning, scheduling, generation rollout,
container lifecycle, persistence, and audit stay outside this process.

Runtime is an internal remote MCP server. It is not an Agent, a Controller, a
service registry, or an API gateway.

## Domain Model

Runtime is composed from a small domain model before any subsystem starts:

- `RuntimeIdentity`: stable Agent ID plus immutable generation;
- `RuntimeSpec`: identity, listen address, network spec, and filesystem spec;
- `NetworkSpec`: a mode-specific restricted or unrestricted value. Only
  unrestricted mode contains a required UDP Egress endpoint; both modes contain
  the TUN and resolver addresses;
- `FilesystemSpec`: workspace and system-Skill root locations. Runtime's
  `write` and `edit` tools target only the workspace; mount permissions belong
  to Provider/container policy.

Environment variables are one input adapter that constructs `RuntimeSpec`.
MCP, tools, filesystem, network, and telemetry depend on the domain model and
must not import environment parsing types.

## Runtime Identity

Runtime identity is the pair `(agent_id, generation)`:

- `agent_id` is stable for the Agent and its workspace;
- `generation` is the immutable RuntimeSpec revision;
- replacing a failed instance with the same RuntimeSpec keeps the same generation;
- a configuration change creates a new generation.

There is no Runtime instance ID, boot ID, connection epoch, admission token, or
Egress token. Docker or Kubernetes and their internal network are trusted
infrastructure. Platform resource IDs remain Provider implementation details.

## Bootstrap Sequence

The binary has five explicit process modes:

```text
antnest-runtime serve
antnest-runtime bash
antnest-runtime read
antnest-runtime write
antnest-runtime edit
```

`serve` is the only long-lived mode. It does not listen until its execution
boundary is ready:

1. Require container PID 1 and root, then load the immutable RuntimeSpec.
2. Set the Agent home and XDG locations beneath `/workspace`.
3. Reconcile the Runtime-owned TUN, UID policy route, resolver policy, and
   fail-closed nftables rules. The platform main routing table remains intact.
4. Validate that the workspace and system-Skill roots can be opened by
   UID/GID 1000.
5. Initialize telemetry and the single-flight Execution Actor.
6. Start restricted local rejection, or connect the unrestricted UDP Egress
   socket selected by RuntimeSpec.
7. Bind the internal HTTP server and expose `/status` and `/mcp`.

The PID 1 Supervisor remains root. It owns MCP, TUN, Egress, telemetry, signals,
and child-process reaping, but never executes Agent-selected filesystem or shell
operations in-process.

Any failure before step 7 exits the process. Runtime-owned network artifacts use
stable names and priorities and are reconciled on every start, so Docker or
Kubernetes may restart the container in an existing network namespace. Failure
to prove convergence is fatal. Provider may instead replace the complete
container or Pod sandbox. Either recovery path reattaches the Agent workspace
and keeps the generation only when RuntimeSpec is unchanged.

## Internal HTTP Surface

Runtime exposes exactly two internal endpoints:

| Endpoint | Purpose |
| --- | --- |
| `GET /status` | Current Runtime identity and application readiness |
| `POST /mcp` | MCP 2026-07-28 Streamable HTTP endpoint |

`/status` returns HTTP 200 only after local bootstrap is complete, the network
loop is running, and MCP can accept tool calls. It is not an Egress handshake
and does not prove public connectivity. Its body is:

```json
{
  "agent_id": "agent-123",
  "generation": 8,
  "status": "ready",
  "network_mode": "restricted"
}
```

Controller already receives the endpoint from Runtime Provider. It polls
`/status`, verifies `(agent_id, generation)`, calls MCP `tools/list` once,
and combines those local signals with Provider/Egress deployment health before
marking a candidate generation ready. Runtime performs no self-registration
and maintains no reverse control connection.

## MCP Tool Model

Runtime uses the latest released MCP revision, `2026-07-28`, through the
official Rust `rmcp` SDK. Antnest does not hand-write MCP framing, lifecycle,
cancellation, discovery, or version negotiation.

The server advertises only the `tools` feature and exactly four tools:

| Tool | Effect |
| --- | --- |
| `bash` | Run `/bin/bash -lc` in a workspace-relative directory |
| `read` | Read bounded text from `workspace` or `system_skills` |
| `write` | Atomically create or replace a workspace text file |
| `edit` | Replace exactly one matching string in a workspace text file |

`tools/list` is the only tool-definition authority. Tool input and output
schemas are generated from Rust types by the official SDK. There is no separate
capabilities array or Antnest JSON-RPC schema.

Runtime disables the SDK Host allowlist because the endpoint is deliberately
reachable through dynamic internal Docker/Kubernetes names. The trusted platform
network, not application authentication or HTTP Host validation, is the access
boundary.

Runtime accepts at most one active tool execution. A second call receives the
stable `runtime_busy` tool error instead of entering an internal queue. This
single-flight boundary covers all four tools, permits complete UID 1000 process
cleanup after each call, and prevents concurrent workspace mutation. Agent
Controller still serializes Agent operations across generations, but Runtime
does not rely on that caller behavior for local correctness.

## Tool Execution Boundary

The MCP adapter maps each tool to a fixed executable subcommand. It never
constructs argv from untrusted input:

```text
MCP bash  -> /proc/self/exe bash
MCP read  -> /proc/self/exe read
MCP write -> /proc/self/exe write
MCP edit  -> /proc/self/exe edit
```

The root Supervisor's Execution Actor owns spawning, timeout, cancellation,
termination, and reaping. Every invocation uses cleared environment state,
piped stdin/stdout/stderr, and a dedicated process group. The subcommand drops
to UID/GID 1000 with empty supplementary groups and capability sets, enables
`no_new_privileges`, validates that state, then reads exactly one bounded JSON
request from stdin. It emits exactly one bounded JSON response on stdout and
uses stderr only for bounded diagnostics.

The tool name is already encoded by the subcommand, so the JSON request has no
second tool discriminator. MCP DTOs exist only at the HTTP adapter. The Actor
and Executor exchange the same transport-neutral execution request/result
model used by `tools`; the private JSON codec adds no business fields, work
identity, replay metadata, or version negotiation. Parent and child execute the
same binary through `/proc/self/exe`.

The execution boundary preserves:

- bounded command time and output;
- cancellation that terminates and reaps the complete Executor process tree;
- one owner for `wait`/`waitpid`, including descendants that change session or
  process group before the request completes;
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

Structured tool errors are valid Executor responses and exit with status zero.
A non-zero Executor exit means the internal exchange did not complete and its
stdout is not authoritative. For `bash`, `write`, and `edit`, cancellation,
timeout, crash, or a lost response after execution begins is reported as an
unknown side-effect outcome; Runtime never claims that an unobserved operation
did not take effect.

Executor processes run as UID/GID 1000 with empty effective, permitted,
inheritable, ambient, and bounding capability sets plus `no_new_privileges`.
If the actor cannot prove that every UID 1000 descendant has been removed, the
Supervisor exits and delegates recovery to the container platform.

The Supervisor keeps `CAP_KILL` so it can signal Executors after their
irreversible UID transition. Admission closure and execution activity are
separate state: shutdown rejects new calls, cancels the active call, and waits
for its lease and descendant cleanup before the process flushes telemetry.

## Generation Rollout

Agent Controller owns `desired_generation`, `candidate_generation`, and
`active_generation`:

1. create a candidate generation through Runtime Provider;
2. wait for `/status` and `tools/list` to succeed;
3. wait for the old generation's current Agent operation to finish;
4. atomically route future MCP calls to the candidate endpoint;
5. remove the old container through Runtime Provider.

Runtime does not implement drain or shutdown RPCs. Stopping new calls at the
caller removes the special case; Provider deletes the old container after its
in-flight request count reaches zero.

## Network Boundary

Network mode is immutable RuntimeSpec input rather than a value returned by a
control session.

- root Supervisor traffic uses the unchanged platform main routing table;
- locally generated UID 1000 traffic is selected by an Agent policy route and
  sent to TUN instead of inheriting direct platform routes;
- nftables rejects UID 1000 traffic that bypasses TUN, reaches Runtime's own
  MCP port, or uses unsupported IPv6;
- `restricted` reads packets from TUN and produces local TCP/ICMP rejection;
- `unrestricted` carries one validated raw IPv4 packet per UDP datagram to
  Runtime Egress;
- the MCP listen port is reachable only on the internal platform network;
- Agent-originated public traffic still enters TUN;
- changing network mode creates a new generation.

The UDP tunnel has no custom framing, batching, identity, heartbeat, retry, or
Trace envelope. Inner TCP owns retransmission and congestion control. MCP never
carries packet data and Runtime Egress never carries tool calls.

## Module Map

| Module | Responsibility |
| --- | --- |
| `main` | Explicit subcommand dispatch plus ordered `serve` bootstrap, signal handling, and composition |
| `spec` | Runtime identity and immutable domain specification |
| `config` | Adapt environment variables into `RuntimeSpec` |
| `execution` | Transport-neutral tool requests, results, and invariants |
| `privilege` / `evidence` | Root Supervisor and Executor privilege verification |
| `network` / `packet` | TUN, routes, kill switch, packet validation, and local rejection |
| `network_session` | Restricted TUN loop or raw-IP-over-UDP tunnel loop |
| `protocol` | MCP input/output DTOs and generated JSON Schemas |
| `roots` | Named-root reads and atomic workspace writes |
| `executor` | Shared subcommand entry, privilege drop, and bounded JSON exchange |
| `tools` | Four execution operations without transport semantics |
| `execution_actor` | Single-flight spawn, cancellation, timeout, and process cleanup |
| `mcp` | Official SDK adapter, `/mcp`, and `/status` HTTP composition |
| `telemetry` | Structured logs and optional OTLP traces |

Runtime must not import Docker, Kubernetes, PostgreSQL, Agent scheduling,
templates, Skills Registry, ACP, Channel, or end-user authentication logic.

Runtime consumes the `/skills` mount Provider supplies. Provider and the
container platform are solely responsible for mounting it read-only; Runtime
cannot enforce mount flags. Runtime's own MCP `write` and `edit` tools reject the
`system_skills` root, but Bash receives ordinary kernel permissions. Preparing,
updating, or versioning the mount is outside Runtime and does not add Skill
Registry behavior here.

## Contract Changes

Runtime has no legacy compatibility branch. A
change to RuntimeSpec, status, tools, tool schemas, or the UDP packet contract
must update the applicable file under `contracts/runtime`, Runtime DTOs or
domain types, contract tests, and these documents in one lockstep change.
Adding a fifth tool requires a deliberate architecture decision; it is not a
local handler-only edit.
