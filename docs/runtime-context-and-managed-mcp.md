# Runtime Context And Managed MCP

Status: implementation in service-owned batches; not end-to-end accepted.

## Scope

Provide Runtime information for model context construction and host configured
stdio MCP processes inside the Agent's Runtime. Agent ACP Service must never
launch these programs on its own host. This expands the earlier information-only
scope; managed stdio MCP is part of this feature, not an unrelated follow-up.

Client-supplied HTTP MCP remains Session-owned. Platform-managed stdio MCP is
Agent configuration, applied through Runtime creation/rebuild. Accepting arbitrary
ACP client stdio commands or implementing stdio process hosting in ACP Service is
not part of this delivery. Skill Registry and Channel Gateway remain deferred.

## Ownership And Flow

1. Agent Controller validates and snapshots the Agent's managed MCP configuration.
   It submits the required Runtime configuration and publishes the resulting
   execution binding only after Runtime Controller reports readiness.
2. Runtime Controller translates that configuration into the RuntimeSpec,
   persistent workspace and read-only system Skill mounts. It verifies startup
   through the existing readiness flow. It does not read Skill content or build
   model prompts.
3. Runtime prepares its isolated environment, starts the configured non-root
   stdio MCP processes, and completes their MCP initialization before reporting
   readiness. It provides bounded environment, AGENTS.md and Skill metadata,
   and aggregates the managed servers' tools into its own tool catalog.
4. Agent ACP Service captures the execution binding on Run admission, reads the
   Runtime information and discovers tools, then builds budgeted model context.
   Runtime observations are refreshed per Run; they are not a permanently cached
   Session snapshot. They do not become user messages or synthetic chat history.

Runtime owns child-process lifecycle and protocol forwarding, not Agent business
configuration or persistence. Neither Controller duplicates the Runtime's current
AGENTS.md/Skill contents in its database. Controllers never proxy model Tool
traffic. All inter-service access remains through the documented contracts.

## Runtime Boundaries

- Keep `read`, `write`, `edit`, and `bash` as the built-in tools. Runtime
  information uses the standard MCP Resource `antnest://runtime/info`.
- The existing Runtime `/mcp` endpoint is the single platform Tool entry point.
  `tools/list` aggregates built-in tools and configured stdio MCP tools. There
  are no per-child HTTP endpoints or child addresses for Agent ACP Service to
  discover or connect to.
- Information collection runs with the Agent's file permissions. Return Skill
  name, description, source and manifest path, not complete Skill bodies or
  executables. Missing optional content is allowed; truncation and unreadable
  content have bounded diagnostics.
- Managed stdio processes run as UID/GID 1000 with the existing privilege and
  network isolation. Only their explicit environment plus the minimal executor
  environment is inherited, never the Supervisor's credentials or RuntimeSpec.
- A completed Tool/turn/Run does not end the Runtime environment. Ordinary Bash
  background jobs and managed MCP processes can both persist across calls.
  Remove per-call container-wide process termination, rather than introducing a
  special exemption for MCP. Reaping zombies is distinct from killing live jobs.
  Cancellation affects only the current execution scope, not all UID 1000 work.
- Configured MCP servers are required: spawn or initialization failure prevents
  readiness. Startup has a deadline. Shutdown cleans up children; a broken
  required child must not leave a silently healthy Runtime.
- Use the official MCP SDK for initialization, discovery and protocol handling.
  Advertise only operations the bridge actually supports. Do not claim arbitrary
  protocol transparency if server-initiated interactions are unsupported.
- Request traces span Runtime HTTP, MCP dispatch and local execution/forwarding.
  Record outcomes and stable error categories, not commands, environment values,
  prompts, protocol payloads or tool results. Egress packets remain untraced.

## Tool Discovery And Dispatch

Runtime is an MCP server toward Agent ACP Service and an MCP client toward its
managed stdio subprocesses. The subprocesses remain stdio-only. This is tool
aggregation and dispatch, not conversion of each subprocess into an independent
HTTP MCP service.

```text
Initialization:
  Runtime -> start configured non-root stdio processes
          -> MCP initialize and tools/list through the official SDK
          -> build tool catalog and internal dispatch bindings

Context construction:
  ACP Service -> Runtime: runtime information + tools/list
              <- environment, guidance, Skill summaries, aggregated tool definitions
  ACP Service -> model: budgeted context + callable tool schemas

Execution:
  ACP Service -> Runtime /mcp: tools/call(exposed_name, arguments)
    built-in binding -> existing read/write/edit/bash executor
    managed binding  -> SDK MCP client -> child stdin: tools/call(original_name, arguments)
                                      <- child stdout: correlated result/error
  ACP Service <- Runtime: result/error for the original call
```

Runtime owns the mapping from exposed tool name to built-in executor or
`(server ID, original tool name)`. Managed tools use a stable namespace so two
servers cannot overwrite one another or the built-ins. Discovery and dispatch
must use the same binding; never ask the model to select a process or transport.
Keep the child's tool description and parameter schema rather than replacing
them with a generic "call MCP" tool. Tool definitions are callable model inputs,
not just descriptive text appended to a system prompt.

`tools/list` is the authority for these definitions. The information Resource
does not maintain a duplicate tool catalog or return child connection addresses.
The official SDK owns framing, request IDs, response correlation and cancellation
on the stdio connection; Runtime does not write an ad-hoc JSON protocol to stdin.

## Delivery Batches

Each batch follows documentation, failing tests, implementation, then local
admission checks. Change one service implementation at a time; shared contracts
and that service's fixtures belong to the same batch.

| Batch | Owner | Deliverable | Status |
| --- | --- | --- | --- |
| 1 | `antnest-runtime` | Information Resource, stdio process hosting, aggregated tool discovery/dispatch, lifecycle and telemetry tests | Complete; service-local accepted |
| 2 | `runtime-controller` | Configuration transport, mounts/permissions and readiness integration | Pending |
| 3 | `agent-controller` | Configuration validation/snapshot and create/rebuild execution publication | Pending |
| 4 | `agent-acp-service` | Information consumption, managed tool discovery and budgeted context injection | Pending |
| 5 | Integration | Docker create/chat/rebuild workflow and Gateway-rooted trace verification | Pending |

## Acceptance

Batch 1 final evidence: Linux 107 unit tests and one Executor integration test;
seven real-container managed MCP E2E cases; `make fmt-check` and `make lint`
passed. Read-only review findings were fixed, including network availability
during child initialization and SDK parameter-header validation for aggregated
tools. The E2E suite cleans its own containers and network. Cross-service
configuration, context consumption and Gateway-rooted traces remain pending.

Runtime tests must cover empty configuration, real stdio MCP initialization and
calls, process reuse, startup failure/timeout, cancellation, child exit, shutdown
cleanup, non-root execution, and protocol capability honesty. Tool tests must
prove that two children with the same tool name remain distinct, built-in names
cannot be overwritten, listed schemas match callable tools, the selected child
receives the original name/arguments, and its errors/results reach the caller.
No per-child HTTP address may appear in Runtime information. Information tests
cover fresh reads, absent optional files, large/invalid manifests, duplicate names
across Skill sources and restricted file access. Tests must assert no secrets or
Skill bodies appear in metadata/log output.

Process tests must start a background job, finish its originating call, perform
unrelated built-in and managed calls, and prove the job still works. Canceling a
different call must not kill it. A later call may explicitly stop it. Runtime
shutdown/replacement, not turn completion, releases the whole environment.

Controller batches must prove configuration is neither dropped nor exposed as
public execution metadata, and failure prevents publication of a usable Agent.
ACP tests must inspect the actual model request: guidance and compact summaries
are present, complete Skill bodies are absent, refresh occurs on the next Run,
and context budgeting includes the injected content.

Final Docker acceptance starts from Agent configuration, exercises creation,
conversation and explicit rebuild, and invokes a real Runtime-hosted stdio MCP
tool. A reusable trace assertion verifies the Gateway-to-Runtime request path.
Producer-only tests do not establish this full workflow.
