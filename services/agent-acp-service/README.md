# Agent ACP Service

Agent ACP Service is Antnest's replaceable Agent compute service. It exposes
the draft ACP v2 protocol, owns durable conversation and Run execution state,
calls the model, and invokes MCP Tools. It does not construct Agents or
Runtimes.

## Status

The Agent ACP Service implementation is complete and independently testable.
The Stage 2 cross-service path remains pending Agent Controller. The
authoritative cross-service design is
[`../../docs/stage-2-agent-and-acp.md`](../../docs/stage-2-agent-and-acp.md);
this directory is the only implementation authority for Agent ACP Service.

## Owns

- ACP Sessions, replayable messages, and active connection bindings.
- Run intents, immutable Run execution snapshots, and terminal facts.
- Context construction and bounded Session compaction checkpoints.
- Model invocation and the multi-request Tool loop.
- Client-provided HTTP MCP revisions and Tool attempts.
- Per-Run calls to the mandatory platform Runtime MCP endpoint.

## Does Not Own

- Agent identity, Agent configuration, Template, Provider catalog, or rebuilds.
- Runtime creation, Docker/Kubernetes resources, network policy, or Tunnel IP.
- Users, organizations, OIDC, SCIM, Channel bindings, or public authorization.
- System Skill package bytes or Skill Registry workflows.
- Another service's database, volume, or bootstrap secret.

## Interfaces

| Interface                    | Direction | Purpose                                                |
| ---------------------------- | --------- | ------------------------------------------------------ |
| ACP v2 over WebSocket `/acp` | inbound   | Standard Session and prompt protocol                   |
| `GET /status`                | inbound   | Liveness/readiness without business mutation           |
| Agent Controller Run RPC     | outbound  | Resolve access, acquire/finish Run, resolve credential |
| MCP `2026-07-28` HTTP        | outbound  | Platform Runtime and client Tool execution             |
| OpenAI-compatible model API  | outbound  | Stage 2 model adapter                                  |
| Private PostgreSQL           | owned     | Sessions, messages, checkpoints, Runs, Tool attempts   |

The Agent Controller dependency surface is owned by Agent Controller and
consumed here at contract revision 2. Its normative status, method, request,
response, error, and
compatibility rules are [`../../contracts/agent-controller/run-api.md`](../../contracts/agent-controller/run-api.md),
with machine-readable shapes in
[`../../contracts/agent-controller/run-contract.json`](../../contracts/agent-controller/run-contract.json).
New optional response fields are compatible; required fields and existing
semantics cannot change without a coordinated contract revision.

ACP v2 Streamable HTTP is still a draft proposal. The initial remote transport
uses WebSocket as a documented custom transport and feeds the official SDK's
v2 `WireStream`, including JSON-RPC batch messages. The ACP success shapes are
not extended with Antnest fields.

## Connection Identity

The deployment's Edge Gateway eventually authenticates external users and
forwards an opaque authenticated subject during WebSocket upgrade. During
internal development, a trusted client supplies the same subject directly.
Agent ACP Service resolves it through Agent Controller before accepting the
connection. It advertises no ACP `authMethods` because authentication has
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

The Compose service is deliberately in the `stage2` profile. It requires the
future `agent-controller` service at `ANTNEST_AGENT_CONTROLLER_URL`; it is not
silently replaced by a local database or an embedded fake. Unit and PostgreSQL
integration tests remain independently runnable while that dependency is under
construction.

See [`docs/architecture.md`](docs/architecture.md) for the domain and module
map, and [`docs/operations.md`](docs/operations.md) for configuration,
readiness, telemetry, secrets, and failure recovery.
