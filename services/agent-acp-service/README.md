# Agent ACP Service

Agent ACP Service is Antnest's replaceable Agent compute service. It exposes the
stable ACP v1 protocol and the draft ACP v2 protocol on separate endpoints, owns
durable conversation and Run execution state, calls the model and invokes MCP
Tools on the Agent's Runtime. It is written in TypeScript on Node.js 24 and uses
the official `@agentclientprotocol/sdk` and `@modelcontextprotocol/client`
packages.

Each endpoint fixes its protocol version for the whole connection. Stable v1
and draft v2 are separate adapters over one application core. The unversioned
`/acp` path does not exist, so protocol selection is never implicit. ACP does
not construct Agents or Runtimes; Agent Controller publishes the current
execution configuration into it.

## Responsibilities

- ACP Sessions, replayable messages and active connection bindings.
- Session model and mode overrides and their ordered configuration notifications.
- Run intents, immutable Run execution snapshots and terminal facts.
- Context construction and bounded Session compaction checkpoints.
- Model invocation and the multi-request Tool loop.
- Tool attempts and retained Session MCP revision records.
- Pending Tool permissions and Session-only approval rules. Fork does not
  inherit them.
- Per-Run calls to the mandatory platform Runtime MCP endpoint.
- Runtime Skill commands, the automatic Skill learning worker, and applied
  personal Skill sources with their metadata journal and protected source reads.
- The `find_skill` and `load_skill` platform tools when Skill discovery is
  configured.
- Workspace Bridge extension state: prompt intent receipts, targeted
  cancellation and sequenced replay marks.

## Non-responsibilities

- Agent identity, Agent configuration, Templates, the Provider catalog or
  rebuilds.
- Runtime creation, Docker or Kubernetes resources, network policy or Tunnel IPs.
- Users, organizations, OIDC, SCIM, Channel bindings or public authorization.
- Formal system Skill custody, Registry publication, version lifecycle or
  Template references.
- Client filesystem and terminal delegation, ACP authentication methods and
  Provider administration.
- Client-supplied MCP servers. Every nonempty `mcpServers` list fails with
  `client_mcp_not_allowed`; see [client MCP policy](docs/client-mcp-policy.md).
- Another service's database, volume or bootstrap secret.

## Interfaces

| Direction | Interface                                                                       | Purpose                                                                                |
| --------- | ------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| Inbound   | ACP v1 over WebSocket `/v1/acp`                                                 | Stable ACP Session and prompt protocol                                                 |
| Inbound   | ACP v1 Streamable HTTP `/v1/acp`                                                | SDK experimental POST, GET (SSE) and DELETE transport                                  |
| Inbound   | ACP v2 over WebSocket `/v2/acp`                                                 | Draft ACP Session and prompt protocol                                                  |
| Inbound   | `GET /status`                                                                   | Liveness and readiness without business mutation                                       |
| Inbound   | `POST /rpc/agent-acp/apply-execution-snapshot`                                  | Apply the current organization configuration and volatile credentials                  |
| Inbound   | `POST /rpc/agent-acp/settle-agent`                                              | Close execution for a Controller lifecycle operation                                   |
| Inbound   | Execution state get and watch RPCs                                              | Current workspace state without Controller Run state                                   |
| Inbound   | `GET /rpc/agent-acp/workspace/…` routes                                         | Principal-scoped Bridge recovery receipts, Session watermarks and learning status      |
| Inbound   | Administrative audit RPCs                                                       | Organization-scoped retained Run, input and event queries                              |
| Inbound   | `POST /internal/skill-sources/inspect`, `POST /internal/skill-sources/artifact` | Source reads for authenticated Skill Registry workload                                 |
| Outbound  | MCP `2026-07-28` over HTTP                                                      | Platform Runtime Tool execution and Skill maintenance                                  |
| Outbound  | ACP `session/request_permission`                                                | User confirmation on the existing ACP connection                                       |
| Outbound  | OpenAI-compatible Chat Completions API                                          | Model calls through logical Provider clients                                           |
| Outbound  | Agent Controller learning policy route                                          | Skill learning policy reads, when configured                                           |
| Outbound  | Skill Registry discovery and projection routes                                  | Skill discovery and source metadata delivery, when configured                          |
| Owned     | PostgreSQL                                                                      | Sessions, messages, checkpoints, Runs, Tool attempts, permissions and learning records |

Gateway and Agent UI supply an unchanged Identity-signed CCT plus their own
verified workload credentials. ACP derives organization, principal and Agent
from signed claims, ignores unsigned identity hints, and authorizes each resource
method against the locally applied snapshot. It advertises no ACP `authMethods`.
Controller publication and settlement use a separate control listener; see the
[authentication contract](../../contracts/agent-acp/service-authentication.md).

The [execution configuration contract](../../contracts/agent-acp/execution-api.md)
defines how Controller publishes into ACP. Normal ACP operation makes no
reverse access, admission, credential or finish requests to Controller. The
[workspace Bridge extension](../../contracts/agent-acp/workspace-bridge.md) is
negotiated through `_meta["antnest.dev/bridge"]`; clients that do not negotiate
it keep standard ACP wire behavior.

## Configuration

The maintenance signing key ID follows the shared
[RuntimeSpec grammar](../../contracts/runtime/runtime-spec.schema.json#/$defs/maintenanceKid)
and [fixtures](../../contracts/runtime/maintenance-kid-fixtures.json).
It is matched exactly against the Runtime's trusted verifier IDs; startup
rejects invalid IDs without trimming whitespace.

| Variable                                                                                          | Required | Default             | Description                                                                                                    |
| ------------------------------------------------------------------------------------------------- | -------- | ------------------- | -------------------------------------------------------------------------------------------------------------- |
| `ANTNEST_ACP_DATABASE_URL`                                                                        | yes      | -                   | `postgres://` or `postgresql://` URL of the service-owned database                                             |
| `ANTNEST_ACP_CLIENT_MCP_KEY`                                                                      | yes      | -                   | Canonical base64 encoding of a random 32-byte encryption key for retained MCP revision records                 |
| `ANTNEST_ACP_LISTEN`                                                                              | no       | `:8080`             | Listen address: `:port`, `host:port` or `[ipv6]:port`                                                          |
| `ANTNEST_ACP_CONTROL_LISTEN`                                                                      | no       | `:8081`             | Separate Controller-only publication/settlement listener; bind to its caller network                           |
| `ANTNEST_ACP_IDENTITY_URL`                                                                        | yes      | -                   | Fixed authenticated Identity origin for public JWKS                                                            |
| `ANTNEST_SERVICE_AUTH_MODE`                                                                       | yes      | -                   | Exact `token` or `mtls`; no default or fallback                                                                |
| `ANTNEST_SERVICE_AUTH_ALLOW_INSECURE_TRANSPORT`                                                   | no       | `false`             | Exact boolean; token HTTP only with explicit disposable development opt-in                                     |
| `ANTNEST_SERVICE_AUTH_CALLERS_FILE`                                                               | token    | -                   | Read-only receiver JSON containing per-caller hashes, loaded once at startup                                   |
| `ANTNEST_SERVICE_AUTH_TOKEN_DIR`                                                                  | token    | -                   | Read-only per-receiver secret files; configured dependencies validated at startup, reread per request          |
| `ANTNEST_TLS_CA_FILE`, `ANTNEST_TLS_CERT_FILE`, `ANTNEST_TLS_KEY_FILE`, `ANTNEST_TLS_SERVER_NAME` | TLS      | -                   | Complete trust, service identity and DNS configuration; TLS 1.3, no partial configuration                      |
| `ANTNEST_ACP_DATABASE_TIMEOUT`                                                                    | no       | `10s`               | Connection, statement and read timeout for PostgreSQL                                                          |
| `ANTNEST_ACP_STATE_DELIVERY_TIMEOUT`                                                              | no       | `10000ms`           | Bound for delivering execution state to watchers                                                               |
| `ANTNEST_PROVIDER_ALLOW_PRIVATE_ENDPOINTS`                                                        | no       | `false`             | Exact operator-only boolean; unsafe private/local LLM and metadata access; malformed values fail startup       |
| `ANTNEST_ACP_RUN_TIMEOUT`                                                                         | no       | `30m`               | Maximum Run duration                                                                                           |
| `ANTNEST_ACP_MAX_PROMPT_BYTES`                                                                    | no       | `16777216`          | Maximum WebSocket and prompt payload size (1024 to 67108864)                                                   |
| `ANTNEST_ACP_MAX_CONFIGURATION_BYTES`                                                             | no       | `16777216`          | Maximum execution snapshot body size (1024 to 67108864)                                                        |
| `ANTNEST_ACP_SHUTDOWN_TIMEOUT`                                                                    | no       | `15s`               | Graceful shutdown deadline                                                                                     |
| `ANTNEST_ACP_SKILL_MAINTENANCE_SIGNING_KID`                                                       | paired   | unset               | Key ID of the Ed25519 Runtime Skill maintenance signing key; set together with the key                         |
| `ANTNEST_ACP_SKILL_MAINTENANCE_SIGNING_KEY`                                                       | paired   | unset               | Canonical base64 Ed25519 PKCS8 DER private key                                                                 |
| `ANTNEST_ACP_SKILL_LEARNING_CONTROLLER_URL`                                                       | no       | unset               | Agent Controller origin for learning policy reads. Learning starts only when this and the signing pair are set |
| `ANTNEST_ACP_ALLOW_DEVELOPMENT_SETTINGS`                                                          | no       | `false`             | Accepts exactly `true` or `false`; explicitly permits development-only settings                                |
| `ANTNEST_ACP_SKILL_LEARNING_DEBUG_AGENT_ID`                                                       | no       | unset               | Development only. Requires the gate; forces review for one Agent and warns at startup; never use in production |
| `ANTNEST_ACP_SKILL_REGISTRY_URL`                                                                  | no       | unset               | Fixed Registry origin; discovery requires the maintenance signing pair and service credentials                 |
| `ANTNEST_TELEMETRY_CAPTURE_RPC_CONTENT`                                                           | no       | `false`             | Record bounded RPC content in spans for diagnosis                                                              |
| `OTEL_EXPORTER_OTLP_ENDPOINT`                                                                     | no       | unset               | OTLP HTTP endpoint. Traces and metrics export by default when set                                              |
| `OTEL_TRACES_EXPORTER`, `OTEL_METRICS_EXPORTER`                                                   | no       | derived             | Enable or disable individual signals                                                                           |
| `OTEL_SERVICE_NAME`                                                                               | no       | `agent-acp-service` | Service name in telemetry                                                                                      |
| `OTEL_SDK_DISABLED`                                                                               | no       | `false`             | Disable the OpenTelemetry SDK                                                                                  |

The debug Agent ID retains the existing `optional()` normalization: leading and
trailing whitespace is removed; empty or whitespace-only values mean unset.
`ANTNEST_ACP_ALLOW_DEVELOPMENT_SETTINGS` is parsed without trimming or case
conversion: `"true"` is valid, but `" true "` and `"TRUE"` fail configuration.

Durations accept a positive integer followed by `ms`, `s` or `m`. Invalid
values fail startup before the database or network is used. The all-zero key
in the repository's `.env.example` is for disposable local data only. See
[operations](docs/operations.md) for key handling and failure behavior.

## Dependencies

- PostgreSQL: a private database owned by this service. Readiness fails when it
  is unreachable. Migrations in `migrations/` run at startup.
- Agent Controller publishes execution snapshots. Until a current snapshot is
  applied, resource methods return an ACP error.
- The Agent's Runtime MCP endpoint is required for every Run.
- A model Provider reachable through published connections and the shared
  destination policy. ACP checks all DNS answers and pins the socket; private
  endpoints require explicit operator opt-in. See [operations](docs/operations.md#provider-model-egress).
- Optional: Agent Controller for learning policy and Skill Registry for
  discovery. Their outages pause learning or discovery and never fail a
  completed Run.
- Readiness checks only local initialization, worker ownership and PostgreSQL.
  It does not probe Controller or aggregate downstream health.

## Build and test

Run package commands from `services/agent-acp-service`:

```bash
npm ci
npm run format:check
npm run lint
npm run typecheck
node --import tsx scripts/execution-contract.mjs --check
npm test
npm run test:integration
npm run test:postgres
```

Unit tests live in `test/`. PostgreSQL and protocol integration tests live in
[`tests/integration/agent-acp-service`](../../tests/integration/agent-acp-service),
and Docker end-to-end tests live in
[`tests/e2e/agent-acp-service`](../../tests/e2e/agent-acp-service) and the
`tests/e2e/acp-*` directories. These runners reuse this package's locked
dependencies. `test:integration` runs official ACP and MCP protocol peers,
HTTP, WebSocket and SSE boundaries and trace propagation. `test:postgres`
selects the real PostgreSQL cases.

Test-only variables:

- `test:audit:v1` runs the opt-in SDK method audit. It needs its own disposable
  database whose name ends in `_audit`. The per-method inventory is in
  [`docs/acp-v1-sdk-audit.json`](docs/acp-v1-sdk-audit.json).

When execution contract definitions change, regenerate the shared schemas with
`node --import tsx scripts/execution-contract.mjs --write`, review the diff and
run the check and contract tests.

Build the image from the repository root:

```bash
docker build -f services/agent-acp-service/Dockerfile -t antnest/agent-acp-service:local .
```

The root `make test-node` target and the `agent-acp-service` CI workflow run the
package checks.

## Documentation

- [Architecture](docs/architecture.md): domain model, Tool loop, persistence,
  recovery and invariants.
- [Operations](docs/operations.md): startup, configuration, telemetry and
  failure handling.
- [Protocol conformance](docs/protocol-conformance.md): v1 and v2 coverage
  matrices and unadvertised surfaces.
- [Skills](docs/skills.md): Runtime Skill commands, learning, sources and
  discovery tools.
- [HTTP transport](docs/http-transport.md): Streamable HTTP connection
  ownership and recovery.
- [Execution configuration](docs/execution-configuration.md) and
  [execution boundary E2E](docs/execution-boundary-e2e.md): Controller
  publication and settlement.
- [Execution audit](docs/execution-audit.md): administrative audit queries.
- [Runtime context](docs/runtime-context.md) and
  [client MCP policy](docs/client-mcp-policy.md): Runtime MCP and the client
  MCP boundary.
- [Session configuration](docs/session-configuration.md) and
  [model selection](docs/session-model-selection.md): Session options and
  thinking effort.
- [Tool permissions](docs/tool-permissions.md),
  [Tool progress](docs/tool-progress.md) and
  [Tool presentation](docs/tool-presentation.md).
- [Structured plans](docs/structured-plan.md),
  [slash commands](docs/slash-commands.md),
  [multimodal input](docs/multimodal-content.md) and
  [Session cost](docs/session-cost.md).
- [Model reasoning history](docs/model-reasoning-history.md).
- [Observability](docs/observability.md): trace parentage and diagnostic
  projections.
- Contracts: [execution API](../../contracts/agent-acp/execution-api.md),
  [workspace Bridge](../../contracts/agent-acp/workspace-bridge.md),
  [Skill commands](../../contracts/agent-acp/skill-commands.md),
  [Skill discovery tools](../../contracts/agent-acp/skill-discovery-tools.md),
  [resource identifiers](../../contracts/resource-identifiers.md).
