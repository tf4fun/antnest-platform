# Runtime Context And Managed MCP

Status: five backend batches and the Admin Console follow-up complete;
Docker end-to-end and Console browser acceptance passed on 2026-09-07.
Stable-v1 and draft-v2 active-Run rebuild acceptance was added on 2026-09-10; see the
[C1 rebuild evidence](docker-single-node-closeout.md#c1-active-run-rebuild-2026-09-10).

## Scope

Provide Runtime information for model context construction and host configured
stdio MCP processes inside the Agent's Runtime. Agent ACP Service must never
launch these programs on its own host. This expands the earlier information-only
scope; managed stdio MCP is part of this feature, not an unrelated follow-up.

All client-supplied MCP injection is deferred by the 2026-09-08 trust-policy
decision, including HTTP, stdio and SSE; ACP inputs require `mcpServers: []`.
Platform-managed stdio MCP is administrator-owned Agent configuration, applied
through Runtime creation/rebuild. ACP Service does not launch these programs on
its own host. Skill Registry and Channel Gateway remain deferred. See the
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
| 2 | `runtime-controller` | Configuration transport, mounts/permissions and readiness integration | Complete; service-local accepted |
| 3 | `agent-controller` | Configuration validation/snapshot and create/rebuild execution publication | Complete (service-local) |
| 4 | `agent-acp-service` | Information consumption, managed tool discovery and budgeted context injection | Complete; service-local accepted |
| 5 | Integration | Docker create/chat/rebuild workflow and Gateway-rooted trace verification | Complete; Docker accepted |
| 6 | `admin-console` | Template MCP editor, immutable detail, deployed Agent summary and BFF integration | Complete; browser and Docker accepted |

## Acceptance

Batch 6 final evidence: all Admin Console Go tests, 81 frontend unit tests and
126 component tests passed, together with `make fmt-check`, `make lint` and the
production Docker build. Read-only review exposed multiline input loss; LF/CRLF/CR
edit regressions now pass. BFF tests enforce administrator scope, raw validation
transport, empty-list removal, summary projections and `no-store` responses.

The Stage 3 Docker profile now configures MCP through Gateway/Console BFF and
passes five Runs, 12 model requests and seven real tool calls. It verifies frozen
Template history and deployed Agent summaries before/after rebuild. Jaeger traces
`b1c3b2276f2ef2e1210ad9ae59fdfa90` and `4d1a4d568698da15fb2f0c0efd23a4fe`
passed the existing causal-parent assertions (five information/catalog reads).
Chrome acceptance at 1440x900 and 390x844 verified create, edit/publication,
multiline preservation, masked environment values, historical read-only inspection
and no horizontal form overflow. The synthetic development stack
`antnest-stage3-e2e-58844` was retained for human feedback at port 44845; the managed
test Agent and temporary model container were removed. Existing instances were
not reset. The only post-E2E adjustment was textarea row sizing, followed by a
full Console test rerun, lint, rebuild and browser recheck. See the service-local
[Console contract and workflow](../services/admin-console/docs/managed-mcp.md).

Batch 1 final evidence: Linux 107 unit tests and one Executor integration test;
seven real-container managed MCP E2E cases; `make fmt-check` and `make lint`
passed. Read-only review findings were fixed, including network availability
during child initialization and SDK parameter-header validation for aggregated
tools. The E2E suite cleans its own containers and network. Cross-service
configuration, context consumption and Gateway-rooted traces were outside this
batch; their later acceptance is recorded in batches 2-5 below.

Batch 2 final evidence: Runtime Controller module tests, including strict RPC
transport for Initialize/Update/Enable, shared bootstrap bounds, immutable
configuration copying, physical digest sensitivity, mount preservation and
non-disclosure in operation responses; `make fmt-check` and `make lint` passed.
No persistence schema was added. Real cross-service create/rebuild acceptance
is recorded in batch 5.

Batch 3 final evidence: complete Agent Controller module tests and real PostgreSQL
repository/E2E tests passed, including immutable MCP revisions, create/rebuild/
enable forwarding, wire contract validation and exclusion from Run admission.
`make fmt-check` and `make lint` passed. Read-only review findings were fixed:
the control schema now references the shared Runtime MCP definition, and malformed
Unicode is rejected before process configuration decoding. No tables were added.
The existing Identity consumer revision assertion was aligned with revision 11
after verifying its consumed route/fields/errors were unchanged. Test PostgreSQL
resources are cleaned after verification. ACP consumption is covered by batch 4.

Batch 4 final evidence: 199 unit/component tests and 15 real PostgreSQL tests
passed, including ACP v1 reconnect/application-recreation history recovery (not
an OS-process crash test), actual model input,
per-Run freshness, complete Skill metadata truncation, structured tool results,
setup cancellation, execution fencing, and telemetry without content leakage.
`make fmt-check` and `make lint` passed. Runtime observations are not persisted
as chat or compaction history. Read-only review identified and fixed guidance
being displaced by large Skill catalogs.

Batch 5 final evidence: the complete Stage 3 Docker profile and its managed MCP
extension passed. Five Runs in one durable Session issued 12 deterministic model
requests and seven real Tool calls. Required outcomes were checked at actual model
input/output boundaries: guidance and Personal Skill discovery, ordinary child
error recovery, child reuse across Runs, same-Runtime guidance refresh, explicit
rebuild from `alpha` to `beta`, retained workspace and changed tool catalog.
The model fixture and trace oracle have six independent tests, including negative cases.
No external Provider credential was used. This original backend acceptance used
internal catalog RPC. The Console follow-up below moves MCP configuration to the
Gateway/BFF template workflow.

Jaeger final evidence (temporary backend; trace URLs expire after cleanup):

| Trace ID | Spans | Information reads | Catalog reads | Tool calls | Verified causal path |
| --- | ---: | ---: | ---: | ---: | --- |
| `538b080ab922c03168702f4e26b5137f` | 244 | 4 | 4 | 6 | Gateway -> ACP -> Runtime; Controller and Identity dependencies |
| `d57bc50a1ce4a55638071b777a449941` | 75 | 1 | 1 | 1 | Gateway -> ACP -> replacement Runtime, same Session |

The assertions follow parent IDs, require strict Runtime descendants below each
ACP information/catalog/call span, and reject secret/context contents. Every model
request is joined to its actual span and admission, proving one information read
and catalog discovery completed before model execution in each Run. The read-only
review's three oracle weaknesses were fixed and their negative cases passed;
the entire Docker profile was rerun with these stricter assertions. Existing Stage 3
lifecycle admission and linked worker trace assertions also passed. All containers
and volumes under test project `antnest-stage3-e2e-52182`, including dynamically
created Runtime resources, were removed and verified absent. Existing development
instances were not reset. See the [reproduction instructions](../tests/e2e/managed-mcp/README.md).

Scope limits remain intentional: client-injected stdio is not hosted on ACP,
managed child configuration is applied on rebuild, there are no per-child HTTP
endpoints, and Egress forwarding has no per-packet traces. This acceptance closes
this feature, not every item in the wider Docker single-node closeout plan.

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

Batch 5 uses the existing isolated Stage 3 Compose acceptance environment, one
PostgreSQL instance with service-owned databases, and an official-SDK stdio fixture
in a test-only Runtime image. Internal catalog RPC seeds the synthetic model;
managed process settings now enter through Console Template create/revise routes.
Agent lifecycle and ACP chat enter through Gateway with normal login cookies. A deterministic model fixture
asserts fresh AGENTS.md/Skill summaries and actual tool schemas, returns managed
tool calls, and validates the real subprocess results. The same conversation is
loaded after explicit rebuild with a changed child ID. Jaeger assertions require
Gateway ancestry for Runtime information and tool calls, not just matching trace
IDs. Test-owned containers/volumes are removed on both success and failure.
