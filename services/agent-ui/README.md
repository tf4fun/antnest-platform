# Agent UI

Agent UI is the end-user conversation workspace of Antnest Platform, served
behind Edge Gateway at `/workspace/`. It presents Agents, Sessions, messages,
tool activity, permission requests and attachments without owning Agent
execution or exposing internal service credentials to the browser. It is one
TypeScript/Node 24 service: the Node process runs the ACP Bridge, the Workspace
HTTP/SSE API and streaming React SSR.

The browser is an in-memory presentation layer that talks only to its own
origin. It never opens an ACP connection. Node holds the official ACP SDK
connection per authorized owner, independently of browser tabs, and rebuilds
its views from ACP, which remains the authority for Sessions, Runs, history and
permissions.

## Responsibilities

- Page-local navigation, selection, composer, attachment and disclosure state.
- End-user presentation of ACP messages, attachments, tool activity, plans and
  Skill learning notices.
- The Node ACP Bridge: per-owner ACP connections, Session replay, compact
  versioned Views, operation reconciliation and SSE delta streams.
- Session-scoped ACP command discovery, completion and argument hints, and
  deterministic workspace control commands.
- Server-advertised provider-grouped model, thinking effort and mode selection.
- Current context usage and cumulative known Session cost from authorized views.
- Exact Tool approval requests with once/Session decisions, cancellation and
  reissued requests after reconnect.
- Connection, unavailable, cancellation and retry feedback in the browser.
- Account exit, administrator application switching and usable no-Agent states.
- The `Antnest / Workspace` implementation of the shared design language.

## Non-responsibilities

- Users, browser sessions, Agent access policy or credentials (Identity Service
  and Edge Gateway).
- Agent configuration authority, Run admission, Runtime endpoints or MCP
  dispatch (Agent Controller, Agent ACP Service, Runtime).
- ACP Session or message persistence.
- Price calculation or usage persistence.
- Any PostgreSQL schema or browser-side business storage (no localStorage,
  sessionStorage or IndexedDB business state).

## Interfaces

| Direction | Interface | Purpose |
| --- | --- | --- |
| Inbound | `/workspace/*` via Edge Gateway | SSR HTML (with verified identity) and hashed assets (anonymous) |
| Inbound | `/api/app/workspace/v1/*` via Edge Gateway | Workspace HTTP commands, bootstrap and Agent SSE; see the [Workspace API](../../contracts/agent-ui/workspace-api.md) |
| Inbound | `GET /status`, `GET /live` | Readiness (503 while draining) and liveness; neither opens an ACP owner |
| Outbound | Agent ACP Service (official SDK over HTTP, execution-state RPC) | Sessions, prompts, replay, permissions, execution state |
| Outbound | Agent Controller | Principal-scoped Agent directory for bootstrap |

Edge Gateway resolves the browser session through Identity Service, injects the
verified Organization, Principal, User, Membership, administrator flag and
Agent ID headers, and enforces CSRF and Origin rules before forwarding. Node
rejects Bootstrap requests without the `X-Antnest-Administrator` flag. The
Gateway route and trusted-header inventory is in the
[session contract](../../contracts/edge-gateway/session-contract.json). Paths
follow the [navigation contract](../../contracts/agent-ui/workspace-navigation.md).

## Configuration

| Variable | Required | Default | Description |
| --- | --- | --- | --- |
| `ANTNEST_AGENT_ACP_SERVICE_URL` | yes | - | Agent ACP Service origin (HTTP(S), no path, credentials, query or fragment) |
| `ANTNEST_AGENT_CONTROLLER_URL` | for discovery | unset | Agent Controller origin; without it bootstrap returns `503 workspace_unavailable` |
| `ANTNEST_AGENT_UI_BRIDGE_HOST` | no | `0.0.0.0` | Listen host |
| `ANTNEST_AGENT_UI_BRIDGE_PORT` | no | `8080` | Listen port (1-65535) |
| `ANTNEST_AGENT_UI_ACP_MAX_PROMPT_BYTES` | no | `16777216` | Serialized Prompt limit, 1024 to 67108864; must equal ACP's `ANTNEST_ACP_MAX_PROMPT_BYTES` (Compose sets both) |
| `ANTNEST_AGENT_UI_BRIDGE_MAX_OWNERS` | no | `16` | Maximum concurrent owner scopes |
| `ANTNEST_AGENT_UI_BRIDGE_IDLE_MS` | no | `300000` | Per-Session idle lifetime in milliseconds (zero allowed) |
| `ANTNEST_AGENT_UI_BRIDGE_SWEEP_INTERVAL_MS` | no | `30000` | Idle sweep interval in milliseconds (positive) |
| `OTEL_SDK_DISABLED` | no | `false` | `true` or `false`; telemetry exports only when not disabled and an endpoint is set |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | no | unset | OTLP/HTTP base endpoint for traces and metrics |
| `OTEL_SERVICE_NAME` | no | `agent-ui` | Telemetry service name |

Telemetry exports HTTP request spans plus `antnest.ui.http.requests` and
`antnest.ui.http.duration` metrics, aggregate Bridge gauges (owners, observer
leases, held work, retained history bytes, subscribers, journal bytes,
replays, Node heap/RSS) with no Agent, Session or principal labels.
Exporters have a 5-second timeout and are flushed after Bridge drain. A valid
W3C `traceparent` from Gateway parents each HTTP span. Capacity and lifetime
semantics are described in [Architecture](docs/architecture.md#bridge-capacity-and-lifetimes).

## Dependencies

- Edge Gateway: the only supported caller; supplies verified identity.
- Organization display: Gateway revision 14 supplies verified slug/name as
  canonical UTF-8 Base64URL headers. Node decodes and validates the same
  principal for bootstrap and SSR; both frontend bootstrap mappings require
  these labels. The chooser and account footer render the real name with the
  existing styles. A reload or re-bootstrap reads current Identity metadata,
  without changing ID-based authorization or clearing a same-identity Session.
  See the [shared projection contract](../../contracts/agent-ui/organization-projection.md).
- Agent ACP Service: required for all conversation and execution-state work.
- Agent Controller: required for Agent discovery at bootstrap; the
  authenticated shell remains usable while discovery is temporarily unavailable.
- OTLP collector: optional.

Deployment is single-replica. Multi-replica ownership would need a separate
lease and fencing design.

## Build and test

Commands run from the repository root unless stated.

```sh
npm --prefix services/agent-ui/web ci
npm --prefix services/agent-ui/web run typecheck
npm --prefix services/agent-ui/web test          # server, unit and component tests
npm --prefix services/agent-ui/web run build
npm --prefix services/agent-ui/web run test:browser   # Playwright + axe, deterministic HTTP/SSE fixtures

# Bridge integration, memory and soak tests
npm --prefix services/agent-ui/web run test:bridge:integration
npm --prefix services/agent-ui/web run test:bridge:memory
npm --prefix services/agent-ui/web run test:bridge:runtime-memory
npm --prefix services/agent-ui/web run test:bridge:soak            # about four minutes

# Docker image (build context is the repository root)
docker build -f services/agent-ui/Dockerfile -t antnest/agent-ui:local .

# Production-image and full-stack Docker tests
npm --prefix services/agent-ui/web run test:bridge:docker
npm --prefix services/agent-ui/web run test:bridge:docker:soak     # about seven minutes
npm --prefix services/agent-ui/web run test:controls:docker
node --test tests/e2e/agent-ui/fullstack-current.test.mjs
node --test tests/e2e/agent-ui/fullstack-history.test.mjs
```

For local development, run Node directly; it serves SSR, assets, the Workspace
API and SSE on port 8080. Open the workspace through Edge Gateway so Node
receives verified identity headers; a direct unauthenticated `/workspace/`
request returns 401. Restart the command after source changes.

```sh
cd services/agent-ui/web
ANTNEST_AGENT_ACP_SERVICE_URL=http://127.0.0.1:8081 \
ANTNEST_AGENT_CONTROLLER_URL=http://127.0.0.1:8082 \
npm run dev
```

Test-only variables: `ANTNEST_UI_SSE_SOAK` (enables the extended SSE soak) and
`ANTNEST_UI_DOCKER_SOAK` (enables the Docker soak); the npm scripts set them.

Unit and component tests live in `web/src/` and `web/server/test/`; browser and
HTTP/SSE integration sources in
[`tests/integration/agent-ui`](../../tests/integration/agent-ui); Docker
tests in [`tests/e2e/agent-ui`](../../tests/e2e/agent-ui). Root targets:
`make test-node` runs `npm test`, `make node-lint` type-checks,
`make test-integration-node` runs `test:browser`, `make docker-build-agent-ui`
builds the image, and `make e2e-workspace-browser`,
`make e2e-skill-learning-browser`, `make e2e-tool-permissions`,
`make e2e-multimodal` and `make e2e-session-cost` exercise the full stack.

## Documentation

- [Architecture](docs/architecture.md) - Bridge ownership, request flow, recovery, history, capacity and testing.
- [UI design rules](docs/ui-design.md) - visual, interaction, navigation and accessibility rules.
- [Workspace state](docs/workspace-state.md) - management and execution state observation and recovery.
- [Multimodal input](docs/multimodal-input.md) - attachment formats, limits and preview lifecycle.
- [Session usage](docs/session-usage.md) - context usage and cumulative cost presentation.
- [Workspace API](../../contracts/agent-ui/workspace-api.md), [workspace commands](../../contracts/agent-ui/workspace-commands.md), [navigation](../../contracts/agent-ui/workspace-navigation.md).
- [Skill command contract](../../contracts/agent-acp/skill-commands.md).
- [Platform design language](../../docs/design-language.md) and [product surfaces](../../docs/product-surfaces.md).
