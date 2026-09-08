# Agent ACP Service

Agent ACP Service is Antnest's replaceable Agent compute service. It exposes
stable ACP v1 and the draft ACP v2 protocol over separate endpoints, owns
durable conversation and Run execution state, calls the model, and invokes MCP
Tools. It does not construct Agents or Runtimes.

## Status

The Stage 2 ACP core surface is implemented and independently testable. ACP v1
is the compatibility baseline; ACP v2 is an explicitly draft, side-by-side
adapter. Optional editor, authentication, and Provider administration methods
are not claimed as implemented. Stage 3 Docker and Gateway-rooted Jaeger
evidence exists for Session/Tool execution and managed MCP create/chat/rebuild.
It is not unrestricted protocol or recovery acceptance: client MCP injection
is deliberately prohibited. Gateway isolation and selected process-interruption
cases have passed; remaining windows are distinguished in the
[protocol matrix](docs/protocol-conformance.md) and
[single-node closeout](../../docs/docker-single-node-closeout.md).
The authoritative cross-service design is
[`../../docs/stage-2-agent-and-acp.md`](../../docs/stage-2-agent-and-acp.md);
this directory is the only implementation authority for Agent ACP Service.

## Owns

- ACP Sessions, replayable messages, and active connection bindings.
- Run intents, immutable Run execution snapshots, and terminal facts.
- Context construction and bounded Session compaction checkpoints.
- Model invocation and the multi-request Tool loop.
- Tool attempts and retained Session MCP revision records.
- Per-Run calls to the mandatory platform Runtime MCP endpoint.

## Does Not Own

- Agent identity, Agent configuration, Template, Provider catalog, or rebuilds.
- Runtime creation, Docker/Kubernetes resources, network policy, or Tunnel IP.
- Users, organizations, OIDC, SCIM, Channel bindings, or public authorization.
- System Skill package bytes or Skill Registry workflows.
- Another service's database, volume, or bootstrap secret.

## Interfaces

| Interface                       | Direction | Purpose                                                |
| ------------------------------- | --------- | ------------------------------------------------------ |
| ACP v1 over WebSocket `/v1/acp` | inbound   | Stable ACP Session and prompt protocol                 |
| ACP v2 over WebSocket `/v2/acp` | inbound   | Draft ACP Session and prompt protocol                  |
| `GET /status`                   | inbound   | Liveness/readiness without business mutation           |
| Agent Controller Run RPC        | outbound  | Resolve access, acquire/finish Run, resolve credential |
| MCP `2026-07-28` HTTP           | outbound  | Platform Runtime Tool execution                        |
| OpenAI-compatible model API     | outbound  | Stage 2 model adapter                                  |
| Private PostgreSQL              | owned     | Sessions, messages, checkpoints, Runs, Tool attempts   |

The Agent Controller dependency surface is owned by Agent Controller and
consumed here at contract revision 9. Its normative status, method, request,
response, error, and
compatibility rules are [`../../contracts/agent-controller/run-api.md`](../../contracts/agent-controller/run-api.md),
with machine-readable shapes in
[`../../contracts/agent-controller/run-contract.json`](../../contracts/agent-controller/run-contract.json).
New optional response fields are compatible; required fields and existing
semantics cannot change without a coordinated contract revision.

The remote transport is WebSocket for both versions. Each endpoint feeds the
matching official SDK surface: the stable package root for v1 and the
batch-capable experimental `WireStream` for v2. ACP success shapes are not
extended with Antnest fields. The unversioned `/acp` is deliberately absent so
protocol selection is never implicit.

### ACP Capability Matrix

| Surface   | Implemented                                                                                                                                                                                                                          | Deliberately absent                                                                                                                                       |
| --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| v1 stable | `initialize`, `session/new`, `session/load`, `session/list`, `session/resume`, `session/close`, `session/delete`, `session/prompt`, `session/cancel`, replayable message/thought/Tool/usage updates; SDK-experimental `session/fork` | Client filesystem and terminal delegation, Agent modes/configuration, authentication, Provider administration, permissions, NES, document synchronization |
| v2 draft  | `initialize`, `session/new`, `session/list`, `session/resume`, `session/close`, `session/delete`, `session/fork`, `session/prompt`, `session/cancel`, replayable message/thought/Tool/usage/state/session-info updates               | Authentication, Provider administration, Session configuration, message-tunneled MCP, permissions/elicitation, NES, document synchronization              |

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

This matrix distinguishes protocol completeness from optional product scope.
Methods are advertised only when their semantics are implemented. Platform
authentication and Provider selection remain Agent Controller responsibilities;
editor-owned filesystem/terminal APIs are replaced by the platform Runtime MCP;
unsupported surfaces are not stubbed with false success responses.

## Runtime Rebuild Integration

Agent ACP Service intentionally has no inbound `update_runtime` RPC. Agent
Controller calls Runtime Controller's `UpdateRuntime`, waits for readiness, and
atomically publishes a new ExecutionRevision. Every accepted ACP prompt calls
Agent Controller `acquire_run`; that response contains the current Runtime MCP
endpoint and execution identity and is copied into one immutable Run snapshot.
An in-flight Run therefore cannot drift, while the first Run admitted after a
rebuild automatically uses the replacement Runtime.

## Connection Identity

The deployment's Edge Gateway authenticates external users and
forwards an opaque Agent-scoped access subject during WebSocket upgrade. During
internal development, a trusted client supplies the same value directly.
Agent ACP Service resolves it through Agent Controller before accepting the
connection and before Session-management operations. Prompt admission goes
directly through authoritative `acquire_run`, which validates the same frozen
principal, Agent, and access revision without a duplicate Identity lookup. A changed access revision,
principal, Agent, or prompt capability invalidates the binding and requires a
new connection. It advertises no ACP `authMethods` because authentication has
already completed at the transport boundary.

## Local Commands

```bash
npm ci
npm run format:check
npm run lint
npm run typecheck
npm test
npm run test:postgres
```

Build the production image from the repository root:

```bash
docker compose --profile stage2 build agent-acp-service
```

The Compose service is deliberately in the `stage2` profile. It requires Agent
Controller at `ANTNEST_AGENT_CONTROLLER_URL`; that dependency is not silently
replaced by a local database or an embedded fake. Unit and PostgreSQL
integration tests remain independently runnable without starting the complete
Stage 2 stack.

See [`docs/architecture.md`](docs/architecture.md) for the domain and module
map, and [`docs/operations.md`](docs/operations.md) for configuration,
readiness, telemetry, secrets, and failure recovery.
