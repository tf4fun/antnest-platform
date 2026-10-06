# Runtime Context And Managed MCP

This document describes how Runtime provides information for model context
construction, how Runtime hosts administrator-configured stdio MCP processes,
and how their tools are discovered and dispatched through the Runtime `/mcp`
endpoint.

## Scope

Provide Runtime information for model context construction and host configured
stdio MCP processes inside the Agent's Runtime. Agent ACP Service must never
launch these programs on its own host. Runtime information and managed stdio
MCP are one feature.

All client-supplied MCP injection is disabled by the trust policy, including
HTTP, stdio and SSE; ACP inputs require `mcpServers: []`.
Platform-managed stdio MCP is administrator-owned Agent configuration, applied
through Runtime creation/rebuild. ACP Service does not launch these programs on
its own host. See the
[client MCP policy](../services/agent-acp-service/docs/client-mcp-policy.md).

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
Admin Console edits managed MCP settings in Templates; see the service-local
[Console contract and workflow](../services/admin-console/docs/managed-mcp.md).

## Runtime Boundaries

- Keep `read`, `write`, `edit`, and `bash` as the built-in tools. Runtime
  information uses the standard MCP Resource `antnest://runtime/info`.
  Their [public input contract](../contracts/runtime/builtin-tools.schema.json)
  uses string paths, 1-based line reads and optional read/bash defaults.
- The [Skill learning design](skill-learning-design.md) and
  [shared contract](../contracts/skill-learning/learning-api.md) add a separate
  authenticated Runtime maintenance endpoint. Candidate/check/commit operations
  never become MCP tools or enter `tools/list`; the four model built-ins remain
  unchanged. Runtime rejects reserved maintenance names on ordinary
  `tools/call`, independently of ACP's source checks.
- The existing Runtime `/mcp` endpoint is the single platform Tool entry point.
  `tools/list` aggregates built-in tools and configured stdio MCP tools. There
  are no per-child HTTP endpoints or child addresses for Agent ACP Service to
  discover or connect to.
- Information collection runs with the Agent's file permissions. Return Skill
  name, description, source and manifest path, not complete Skill bodies or
  executables. Missing optional content is allowed; truncation and unreadable
  content have bounded diagnostics.
- Managed stdio processes run as distinct UIDs 2000..2007 with workspace GID
  1000, the Executor's tunnel policy and no capabilities. The root entry reads
  only its own values from RC's root-only read-only bootstrap, then injects them
  immediately before exec. Public environment and minimal process defaults are
  explicit; Supervisor credentials and RuntimeSpec are never inherited. UID
  1000 tools cannot inspect another UID's environ, memory, descriptors or ptrace
  it. Each server has UID-owned 0700 HOME/TMPDIR/XDG directories in bounded
  private tmpfs and uses umask 077, while cwd remains workspace. This protects
  usual on-disk credential caches, including default `/tmp` files. Cache data
  resets on restart; intentional shared files require explicit group grants.
  MCP implementations and executable dependencies remain trusted; UID
  isolation does not prevent a server deliberately leaking its own secrets.
  See the [secret contract](../contracts/runtime/managed-mcp-secrets.md).
- A completed Tool/turn/Run does not end the Runtime environment. Ordinary Bash
  background jobs and managed MCP processes can both persist across calls.
  There is no per-call container-wide process termination, and MCP processes
  need no special exemption. Reaping zombies is distinct from killing live jobs.
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

Runtime `tools/list` is the authority for Runtime built-in and managed tool definitions. ACP
also owns separately contracted platform tools: `update_plan` and the opt-in
[Skill find/load tools](../contracts/agent-acp/skill-discovery-tools.md). These use
`source=agent` and local dispatch; they do not become Runtime MCP definitions.
The information Resource
does not maintain a duplicate tool catalog or return child connection addresses.
The official SDK owns framing, request IDs, response correlation and cancellation
on the stdio connection; Runtime does not write an ad-hoc JSON protocol to stdin.

The learning control path is outside this model-tool catalog and is not
a child MCP address or an ACP filter over hidden Tool definitions. ACP issues
bound maintenance requests only from internal maintenance jobs; Runtime checks
their credentials and execution identity before using the same UID 1000 executor
and Execution Actor. An execution ID alone is not authentication. The
bootstrap contains a bounded current/next public-key set; requests select `kid`.
Runtime Controller freezes that set in each accepted operation and includes it
in deployment identity, so recovery does not read a newly rotated configuration.
Changing a Runtime's trusted set requires explicit rebuild; stopping ACP signing
alone does not revoke a compromised key.

## Scope Limits

Client-injected stdio is not hosted on ACP, managed child configuration is
applied on rebuild, there are no per-child HTTP endpoints, and Egress
forwarding has no per-packet traces.

## Test Requirements

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

Controller tests must prove configuration is neither dropped nor exposed as
public execution metadata, and failure prevents publication of a usable Agent.
ACP tests must inspect the actual model request: guidance and compact summaries
are present, complete Skill bodies are absent, refresh occurs on the next Run,
and context budgeting includes the injected content.

## Docker End-To-End Workflow

The Docker end-to-end test starts from Agent configuration, exercises creation,
conversation and explicit rebuild, and invokes a real Runtime-hosted stdio MCP
tool. A reusable trace assertion verifies the Gateway-to-Runtime request path.
Producer-only tests do not establish this full workflow.

The test uses the isolated Stage 3 Compose environment, one PostgreSQL instance
with service-owned databases, and an official-SDK stdio fixture in a test-only
Runtime image. Internal catalog RPC seeds the synthetic model; managed process
settings enter through Console Template create/revise routes. Agent lifecycle
and ACP chat enter through Gateway with normal login cookies. A deterministic
model fixture asserts fresh AGENTS.md/Skill summaries and actual tool schemas,
returns managed tool calls, and validates the real subprocess results. It
covers guidance and Personal Skill discovery, ordinary child error recovery,
child reuse across Runs, same-Runtime guidance refresh, explicit rebuild, the
retained workspace and the changed tool catalog. The same conversation is
loaded after explicit rebuild with a changed child ID.

Jaeger assertions follow parent IDs and require Gateway ancestry and strict
Runtime descendants below each ACP information, catalog and call span, not just
matching trace IDs. Every model request is joined to its actual span and
admission, which proves that one information read and catalog discovery
complete before model execution in each Run. The assertions reject secret and
context contents. Test-owned containers and volumes, including dynamically
created Runtime resources, are removed on both success and failure. See the
[reproduction instructions](../tests/e2e/managed-mcp/README.md).
