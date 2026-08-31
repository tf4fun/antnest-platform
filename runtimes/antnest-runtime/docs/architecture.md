# Antnest Runtime Architecture

## Mission

Antnest Runtime gives one Agent an isolated Linux workspace and exposes that
workspace as four MCP tools. Agent reasoning, scheduling, generation selection,
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
- `generation` is the immutable RuntimeSpec revision;
- replacing a failed instance with the same RuntimeSpec keeps the same generation;
- a configuration change creates a new generation.

There is no Runtime instance ID, boot ID, connection epoch, admission token, or
Egress token. Docker or Kubernetes and their internal network are trusted
infrastructure. Platform resource IDs remain Runtime Controller adapter details.

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
7. Bind the internal HTTP server, start the prepared packet loop, and expose
   `/status` and `/mcp`.

The PID 1 Supervisor remains root. It owns MCP, TUN, Egress, telemetry, signals,
and child-process reaping, but never executes Agent-selected filesystem or shell
operations in-process.

Any failure before step 7 exits the process. Runtime-owned network artifacts use
stable names and priorities and are reconciled on every start, so Docker or
Kubernetes may restart the container in an existing network namespace. Failure
to prove convergence is fatal. Runtime Controller may instead replace the complete
container or Pod sandbox. Either recovery path reattaches the Agent workspace
and keeps the generation only when RuntimeSpec is unchanged.

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
upstream DNS connectivity. Its body is:

```json
{
  "agent_id": "agent-123",
  "generation": 8,
  "execution_id": "d83f89db-74f3-49df-a3b8-83d6718a45fd",
  "status": "ready"
}
```

Runtime Controller performs one bounded `/status` request, verifies
`(agent_id, generation)`, and returns the ready endpoint to Agent Controller.
Agent ACP Service later calls MCP under a Run snapshot and supplies that
snapshot's expected execution ID on every request. Runtime rejects missing or
stale execution identity before MCP dispatch. Runtime performs no
self-registration and maintains no reverse control connection.

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
If the actor cannot prove that every UID 1000 descendant has been removed, the
Supervisor exits and delegates recovery to the container platform.

The Supervisor keeps `CAP_KILL` so it can signal Executors after their
irreversible UID transition. Admission closure and execution activity are
separate state: shutdown rejects new calls, cancels the active call, and waits
for its lease and descendant cleanup before the process flushes telemetry.

## Explicit Runtime Replacement

Agent Controller allocates generations and owns the rebuild workflow:

1. close Agent Run admission and wait for the current Run to finish;
2. delete the old generation through Runtime Controller and require an
   `Absent` result;
3. call Runtime Egress `ResetAgentFlows` and wait for acknowledgement;
4. create the replacement generation through Runtime Controller;
5. wait for platform health and matching `/status`;
6. atomically publish the new Agent ExecutionRevision and reopen admission.

Runtime does not implement drain, shutdown, candidate, or activation RPCs.
Runtime Controller only realizes and removes the caller-selected generation.
Ambiguous deletion or Egress reset keeps admission closed and prevents creation
of a second Runtime.

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
| `mcp` | Official SDK adapter, `/mcp`, and `/status` HTTP composition |
| `telemetry` | Structured logs and optional OTLP traces |

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
Adding a fifth tool requires a deliberate architecture decision; it is not a
local handler-only edit.

### Approved Stage 1C Change, Not Yet Implemented

Runtime Controller integration requires one future lockstep contract change:

1. PID 1 generates a fresh random `execution_id` on every process start.
2. `/status` returns that value with `agent_id`, `generation`, and readiness.
3. Every MCP request carries the execution ID expected by the Agent Run
   snapshot, for example in `X-Antnest-Expected-Execution-ID`.
4. Runtime rejects a mismatch before Tool dispatch.

This identity is a stale-execution consistency check, not an authentication
credential or rollout generation. Until the Runtime code, language-neutral contract, and tests land
together, the implemented identity and status body remain exactly as described
earlier in this document.
