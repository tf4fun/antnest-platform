# Agent ACP Service

Agent ACP Service is Antnest's replaceable Agent compute service. It exposes
stable ACP v1 and the draft ACP v2 protocol over separate endpoints, owns
durable conversation and Run execution state, calls the model, and invokes MCP
Tools. It does not construct Agents or Runtimes.

## Status

The [execution-boundary refactor](docs/execution-configuration.md) was closed by
the user's scoped acceptance decision on 2026-09-15.
Production composition now uses local access/configuration, logical Provider
clients and execution ownership; the old outbound Controller RPC client is removed.
Agent-level settlement, durable old Runtime protection, and workspace state
read/subscription routes are now locally wired. Administrative audit queries
read retained input, execution and permission records from ACP's own storage.
Gateway and Console consumers have completed their service-local migrations.
Nine Controller/ACP integration scenarios and trace topology checks passed.
Jaeger clock warnings are deferred as OBS-ACP-CLOCK; the strict script still exits
with failure, and no raw trace, warning or gate was modified. See the
[final results and explicit exception](../../docs/controller-acp-execution-boundary-plan.md#103-可执行的小步交付).
Agent UI was excluded from that refactor's protocol acceptance, which used the
official ACP SDK. Subsequent workspace/model-selection browser evidence is
tracked separately in [current status](../../docs/current-status.md).
The acceptance history below describes the earlier
deployed baseline, not acceptance of this refactor.

The declared platform-only ACP profile is accepted in C1 of the Docker
single-node closeout. ACP v1 is the compatibility baseline; ACP v2 is an
explicitly draft, side-by-side adapter. Client editor delegation, authentication,
and Provider administration remain outside this service's architecture.
Gateway/Runtime/Jaeger evidence covers the scoped protocol, isolation, recovery
and managed MCP workflows. This is not unrestricted protocol conformance:
client MCP injection is deliberately prohibited and F07 awaits SDK support.
Coverage boundaries remain distinguished in the
[protocol matrix](docs/protocol-conformance.md) and
[single-node closeout](../../docs/docker-single-node-closeout.md).
The [interface and Goose gap review](docs/protocol-gap-review.md) records the
seven baseline delivery/content/Session defects and their service-level fixes.
The service targets all applicable stable ACP capabilities, including optional
ones. Only explicit architecture incompatibilities and protocol-stability
deferrals can exclude work; clients choose their own presentation and usage
subset. Unadvertised functionality remains a backlog item, not an implicit
product choice. See the [scope decision](docs/protocol-gap-review.md#5-服务端完整性目标与补齐清单).
The [completion plan](docs/protocol-completion-plan.md) separates confirmed
implementation gaps, Goose-based reuse choices, confirmed organization-wide
model selection and Agent-default/Session-override authorization, and evidenced
exclusions. Non-architectural behavior reuses Goose patterns without changing
platform ownership or isolation. Historical batch notes record delivery order;
current capability and acceptance status comes from the protocol matrix.
The first completion batch adds real model text/thought streaming with durable
batched output, stable message identities in v1/v2, and nonduplicating replay
and context reconstruction. Runtime MCP progress now feeds bounded, durable
Tool previews in both ACP versions, including cancellation and replay. See
[Tool progress](docs/tool-progress.md) and the completion plan for service-level
evidence and the completed 12-path Gateway / Rust Runtime deployment integration.
F03 adds deterministic Tool kinds/titles, bounded structured `rawOutput` and
actual Runtime file observations, persisted for v1/v2 replay. Complete file
before/after becomes standard version-specific diff content without entering
model context. See [Tool presentation](docs/tool-presentation.md). The Runtime
producer and ACP consumer have service-owned coverage. The
[file-diff deployment profile](../../scripts/acp-files/README.md) also passed 16
Gateway/Runtime scenarios, 16 execution traces and 16 side-effect-free replay
traces. F04 now adds the local `update_plan` tool, standard v1/v2 plan notifications,
atomic persistence, replay/fork and plan context recovery. See
[Structured plans](docs/structured-plan.md) for the service-owned batch and
[deployed plan acceptance](../../scripts/acp-plan/README.md): twelve Gateway
scenarios, four execution traces covering twelve Runs, and eight independent
replay/denial traces passed. F05 now adds organization model selection, Session
mode overrides, full configuration responses/notifications, persistence and
Run-boundary application. See [Session configuration](docs/session-configuration.md).
The F05/F06 Gateway/Runtime/Jaeger integration is complete. F06 adds
bidirectional v1/v2 permission requests, Session-scoped once/always decisions,
durable approval facts, cancellation and client reconnection. Smart Approve
uses explicit rules, non-conflicting platform read-only hints and a bounded
LLM read-only judge for unannotated platform Tools. Uncertain judgments ask the
user; judgments share the Run budget and are never published as chat messages.
The deployed profile passed 26 v1/v2 scenarios with actual Runtime effects and
causal Jaeger validation. Agent UI supports the standard approval interaction
and Session model/mode selection. [Session model selection](docs/session-model-selection.md)
adds provider-grouped choices and capability-driven thinking effort, persisted
per Session and applied to the actual model request.
See [Tool permissions](docs/tool-permissions.md). F07 is deferred pending official
MCP SDK support. F08 provides a registry-backed `/help` command (`/帮助` alias),
standard command notifications and durable replies without calling a model or
Runtime. Its v1 HTTP and v1/v2 WebSocket Gateway deployment, history/isolation
and Jaeger validation passed. See [Slash commands](docs/slash-commands.md).
F09's ACP service batch adds native WAV/MP3 and PDF input, guarded by admitted
model capabilities, with validation and durable replay. Controller model
configuration, revision/admission propagation and capability declarations have
also passed service tests. Console/BFF configuration and projections, plus Agent UI
input/encoding/replay are verified. Gateway v1 HTTP and v1/v2 WebSocket deployment
acceptance, history/isolation, local model mismatch recovery and Jaeger ancestry
also passed with a deterministic Provider. Retained development instances were
not replaced; real recognition quality is not claimed. See
[Multimodal input](docs/multimodal-content.md). F10's ACP consumer implements
returned/estimated USD receipts, durable known-cost projection and standard
v1/v2 usage notifications. Controller price management and shared admission
snapshots, Console/BFF pricing edits and Agent UI usage consumption are now
verified. All three deployed protocol entrances, restart/fork accounting,
identity isolation and Gateway-rooted Jaeger paths also passed with a local
deterministic model. See
[Session cost](docs/session-cost.md) for the contract and accounting boundaries.
See the
[completion plan](docs/protocol-completion-plan.md) for the decision and boundaries.
This method inventory is not a claim of unrestricted protocol completeness.
The authoritative cross-service design is
[`../../docs/stage-2-agent-and-acp.md`](../../docs/stage-2-agent-and-acp.md);
this directory is the only implementation authority for Agent ACP Service.

## Owns

- ACP Sessions, replayable messages, and active connection bindings.
- Session model/mode overrides and their ordered configuration notifications.
- Run intents, immutable Run execution snapshots, and terminal facts.
- Context construction and bounded Session compaction checkpoints.
- Model invocation and the multi-request Tool loop.
- Tool attempts and retained Session MCP revision records.
- Pending Tool permissions and Session-only approval rules; Fork does not inherit them.
- Per-Run calls to the mandatory platform Runtime MCP endpoint.

## Does Not Own

- Agent identity, Agent configuration, Template, Provider catalog, or rebuilds.
- Runtime creation, Docker/Kubernetes resources, network policy, or Tunnel IP.
- Users, organizations, OIDC, SCIM, Channel bindings, or public authorization.
- System Skill package bytes or Skill Registry workflows.
- Another service's database, volume, or bootstrap secret.

## Interfaces

| Interface                        | Direction | Purpose                                                              |
| -------------------------------- | --------- | -------------------------------------------------------------------- |
| ACP v1 over WebSocket `/v1/acp`  | inbound   | Stable ACP Session and prompt protocol                               |
| ACP v1 Streamable HTTP `/v1/acp` | inbound   | Official experimental POST/GET/DELETE transport                      |
| ACP v2 over WebSocket `/v2/acp`  | inbound   | Draft ACP Session and prompt protocol                                |
| `GET /status`                    | inbound   | Liveness/readiness without business mutation                         |
| Execution snapshot RPC           | inbound   | Apply current organization configuration and volatile credentials    |
| Agent settlement RPC             | inbound   | Close execution for Controller lifecycle operations                  |
| Execution state get/watch RPC    | inbound   | Current workspace state without Controller Run state                 |
| Administrative audit RPCs        | inbound   | Organization-scoped retained Run/input/event queries                 |
| MCP `2026-07-28` HTTP            | outbound  | Platform Runtime Tool execution                                      |
| ACP `session/request_permission` | outbound  | User confirmation on the existing ACP connection                     |
| OpenAI-compatible model API      | outbound  | Stage 2 model adapter                                                |
| Private PostgreSQL               | owned     | Sessions, messages, checkpoints, Runs, Tool attempts and permissions |

The [execution configuration contract](../../contracts/agent-acp/execution-api.md)
defines Controller publication into ACP. Normal ACP usage has no reverse
Controller access/admission/credential/finish requests.
See [execution audit](docs/execution-audit.md) for management identity, retained
original input, independent message/permission cursors and tracing behavior.

Both versions retain WebSocket; `/v1/acp` additionally supports the official
experimental Streamable HTTP transport (POST/GET/DELETE). See the
[HTTP transport contract](docs/http-transport.md) for connection ownership,
recovery and Gateway integration. Each endpoint feeds the
matching official SDK surface: the stable package root for v1 and the
batch-capable experimental `WireStream` for v2. ACP success shapes are not
extended with Antnest fields. The unversioned `/acp` is deliberately absent so
protocol selection is never implicit.

### ACP Capability Matrix

| Surface   | Implemented                                                                                                                                                                                                                                                                                                                                                                                   | Not implemented; scope classified separately                                                                                   |
| --------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| v1 stable | `initialize`, `session/new`, `session/load`, `session/list`, `session/resume`, `session/close`, `session/delete`, `session/prompt`, `session/cancel`, `session/set_config_option`, `session/set_mode`, reverse `session/request_permission`, replayable message/thought/Tool/usage/plan updates, command catalog, session-info and config/mode notifications; SDK-experimental `session/fork` | Client filesystem and terminal delegation, authentication, Provider administration, elicitation, NES, document synchronization |
| v2 draft  | `initialize`, `session/new`, `session/list`, `session/resume`, `session/close`, `session/delete`, `session/fork`, `session/prompt`, `session/cancel`, `session/set_config_option`, reverse `session/request_permission`, replayable message/thought/Tool/usage/state/session-info/plan updates, command catalog and config notifications                                                      | Authentication, Provider administration, message-tunneled MCP, elicitation, NES, document synchronization                      |

The executable coverage contract is maintained in
[`docs/protocol-conformance.md`](docs/protocol-conformance.md). Stable ACP v1
requires client stdio MCP support. Antnest deliberately accepts only
`mcpServers: []` on both ACP versions. Every nonempty list (HTTP, stdio, SSE,
MCP-over-ACP) fails explicitly with `client_mcp_not_allowed`; no client MCP
capability is advertised. Only platform Runtime MCP tools are available.
Platform-configured stdio children are hosted inside Runtime, not on the
shared ACP host. See [Runtime context](docs/runtime-context.md).
This restricted profile must not be described as generic full v1 conformance.
Client injection as a whole is deferred from the current closeout. Future
administrator opt-in and the client transport are separate decisions; see
[MCP trust and injection boundary](docs/client-mcp-policy.md).

This matrix describes current behavior, not the final server capability target.
Methods are advertised only when their semantics are implemented. Platform
authentication and Provider authority remain in their owning services; authorized
Session options can be exposed without transferring that authority. Client-owned
filesystem/terminal delegation remains outside the Runtime execution model.
Other stable capabilities require implementation even if today's UI does not
use them; unsupported surfaces are not stubbed with false success responses.

## Runtime Rebuild Integration

Controller owns Runtime lifecycle and publishes only its confirmed current
binding through execution configuration. ACP fixes the Runtime identity in each
accepted Run; it never changes a running Tool loop's endpoint. Configuration
application is distinct from Runtime readiness or Agent settlement.
`POST /rpc/agent-acp/settle-agent` checks the closed lifecycle operation, waits
outside configuration publication and reports local quiescence plus durable
stopping evidence. New prompts cannot reuse a protected Runtime revision.
Controller lifecycle calls and confirmed replacement remain B2/B5 integration.

## Connection Identity

Gateway supplies a trusted organization/principal/Agent tuple in internal headers.
It authenticates external users and must strip spoofed identity headers. ACP
authorizes resource methods against the locally applied current organization
snapshot; no opaque subject or outbound identity lookup remains. It advertises no
ACP `authMethods` because authentication completed at the transport boundary.

## Local Commands

```bash
npm ci
npm run format:check
npm run lint
npm run typecheck
node --import tsx scripts/execution-contract.mjs --check
npm test
npm run test:postgres
```

Run these commands from this service directory. If execution contract definitions
change, regenerate the shared schemas with
`node --import tsx scripts/execution-contract.mjs --write`, then review the diff
and run the check plus contract tests. Schema generation does not replace runtime
authorization or semantic reference validation.

Build the production image from the repository root:

```bash
docker compose --profile stage2 build agent-acp-service
```

The Compose service participates in both `stage2` and `stage3`. The new execution
boundary requires coordinated consumer/configuration-publisher updates before
deployment; the existing Compose stack is not yet this refactor's acceptance.
ACP has no outbound Controller URL. Service-local component tests use synthetic
configuration publication; complete platform evidence follows the later batches.

See [`docs/architecture.md`](docs/architecture.md) for the domain and module
map, and [`docs/operations.md`](docs/operations.md) for configuration,
readiness, telemetry, secrets, and failure recovery.

The [observability implementation](docs/observability.md) documents HTTP/ACP
parentage, safe diagnostic projections and unresolved SDK correlation limits.
Readiness checks local initialization/worker ownership and private PostgreSQL
only; it does not probe Controller or aggregate downstream health.
