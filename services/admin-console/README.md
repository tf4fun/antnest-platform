# Admin Console

Admin Console is the administrator React application and thin BFF
(backend-for-frontend) of Antnest Platform. It exists so administrators can
manage Identity, Provider, Model, Template, Skill and Agent lifecycle facts
through one interface without the Console becoming a second source of truth.
The BFF is written in Go and embeds the compiled React (Vite, Tailwind, shadcn)
application.

Every write is one command to one owning service, and every read is projected
through an explicit browser DTO allowlist. Organization scope and actor always
come from verified Identity-signed caller context, never from browser input.

## Responsibilities

- React/shadcn administrator UI and page-local state.
- Page-oriented request shaping and response aggregation (Overview,
  inventories, Agent detail).
- Explicit browser DTO allowlists that keep control-plane fields internal.
- Organization scoping from verified Identity-signed caller context.
- Builtin Provider and model catalog defaults (`internal/server/builtin_catalog.go`).
- Provider model discovery against administrator-supplied Provider base URLs.
- Skill inventory, upload, discovery and promotion through Skill Registry.
- Static application delivery and lifecycle event forwarding (SSE).

## Non-responsibilities

- Browser login, external authorization or session cookies (Edge Gateway).
- Identity, Provider connection, Model Profile, Template, Agent, operation,
  event or Runtime records (Identity Service and Agent Controller).
- Execution audit records (Agent ACP Service) and Skill packages (Skill Registry).
- Provider secret storage or retrieval outside a scoped Controller read.
- Durable retries or cross-service workflows.
- Any PostgreSQL schema. The service has no database, migration, backup or
  persistent volume.

## Interfaces

| Direction | Interface | Purpose |
| --- | --- | --- |
| Inbound | `/api/admin/*` via Edge Gateway | Administrator BFF; see the [admin contract](../../contracts/admin-console/admin-contract.json) |
| Inbound | `/api/admin/skill-sources/*` | Skill discovery and promotion; see the [skill discovery contract](../../contracts/admin-console/skill-discovery.md) |
| Inbound | `/` and static assets | Embedded React application |
| Inbound | `GET /status` | Local readiness only |
| Outbound | Identity Service RPC | Directory, OIDC, SCIM credentials, account profile and password |
| Outbound | Agent Controller RPC | Catalog, Templates, Agents, lifecycle, events, network policy, synchronization |
| Outbound | Agent ACP Service RPC | Organization-scoped execution audit |
| Outbound | Skill Registry HTTP (optional) | Skill packages, versions and artifacts |
| Outbound | Provider `GET {base_url}/models` | Model discovery against administrator-supplied URLs |

Edge Gateway is the only supported external caller; do not publish Admin
Console directly.

## Configuration

| Variable | Required | Default | Description |
| --- | --- | --- | --- |
| `ANTNEST_ADMIN_CONSOLE_LISTEN` | no | `:8080` | HTTP listen address; the container health check uses its port |
| `ANTNEST_IDENTITY_SERVICE_URL` | yes | - | Identity Service base URL (absolute HTTP(S), no query or fragment) |
| `ANTNEST_AGENT_CONTROLLER_URL` | yes | - | Agent Controller base URL |
| `ANTNEST_AGENT_ACP_SERVICE_URL` | yes | - | Agent ACP Service base URL for execution audit |
| `ANTNEST_SKILL_REGISTRY_URL` | no | empty | Skill Registry base URL; without it Skill routes return `503 dependency_unavailable` |
| `ANTNEST_SERVICE_AUTH_MODE` | yes | - | Exactly `token` or `mtls`; see the [authentication contract](../../contracts/admin-console/service-authentication.md) |
| `ANTNEST_SERVICE_AUTH_CALLERS_FILE` | token mode | - | Read-only Gateway caller hashes, loaded at startup |
| `ANTNEST_SERVICE_AUTH_TOKEN_DIR` | token mode | - | Per-receiver credentials, validated at startup and read on every new request |
| `ANTNEST_SERVICE_AUTH_ALLOW_INSECURE_TRANSPORT` | no | `false` | Exact `true` only for disposable token-mode development HTTP |
| `ANTNEST_SERVICE_AUTH_TLS_*` | TLS | - | CA, certificate, key and server DNS identity; required in mTLS mode |
| `ANTNEST_ADMIN_DEFAULT_RUNTIME_IMAGE_REF` | no | empty | Default Runtime image reference offered when creating a Template |
| `ANTNEST_ADMIN_DEPENDENCY_TIMEOUT` | no | `15s` | Timeout for non-streaming dependency calls, including Provider discovery |
| `ANTNEST_ADMIN_SHUTDOWN_TIMEOUT` | no | `15s` | Graceful HTTP drain budget |
| `ANTNEST_ENVIRONMENT` | no | empty | Deployment environment resource attribute for telemetry |
| `OTEL_*` | no | - | Standard OpenTelemetry SDK settings (`OTEL_SERVICE_NAME`, `OTEL_SDK_DISABLED`, `OTEL_TRACES_EXPORTER`, `OTEL_EXPORTER_OTLP_ENDPOINT`, `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT`) |

Edge Gateway forwards admin requests with a 10-second
`ANTNEST_EDGE_REQUEST_TIMEOUT`, shorter than the 15-second Console dependency
timeout. OIDC and SCIM setup addresses are derived from the browser's Edge
origin, so there is no Console variable for them. See
[Operations](docs/operations.md) for details.

## Dependencies

- Edge Gateway: the only external caller; forwards signed caller context; Console verifies it.
- Identity Service: required for Directory, Provisioning and account pages.
- Agent Controller: required for catalog, Template and Agent pages. Agent
  inventory is the only required Overview section; other sections degrade.
- Agent ACP Service: required for execution audit, which does not depend on
  Controller availability.
- Skill Registry: optional; only Skill pages depend on it.
- Outbound network access to Provider endpoints for model discovery. The base
  URL is administrator-supplied and not restricted to an allowlist of hosts.
- OTLP collector: optional, when trace export is configured.

`GET /status` never probes a dependency; failures are reported by the affected
business request.

## Build and test

Commands run from the repository root unless stated.

```sh
# Go unit and component tests (from services/admin-console)
GOWORK=off go test ./...

# Web unit and component tests, type checking and production build
npm --prefix services/admin-console/web test
npm --prefix services/admin-console/web run typecheck
npm --prefix services/admin-console/web run build

# Browser tests (Playwright + Chromium, synthetic API responses; run after build)
npm --prefix services/admin-console/web run test:browser:catalog
npm --prefix services/admin-console/web run test:browser:audit
npm --prefix services/admin-console/web run test:browser:skills
npm --prefix services/admin-console/web run test:browser:template-skills

# HTTP startup and shutdown integration tests
node tests/integration/go/run.mjs admin-console

# Docker image (build context is the repository root)
docker build -f services/admin-console/Dockerfile -t antnest/admin-console:local .

# Authenticated owning-service Docker acceptance
node tests/e2e/service-authentication/console/run.mjs

# Docker signal regression
node tests/e2e/admin-console/shutdown-docker.mjs
```

Install Chromium for Playwright with
`npm --prefix services/admin-console/web exec -- playwright install chromium`
if it is absent. `npm test` runs pure-function tests (`node --test`) followed by
Vitest/Testing Library component tests that use the real API parser with
HTTP-shaped synthetic responses; they need no Provider or Docker.

Go integration sources live in
[`tests/integration/go/admin-console`](../../tests/integration/go/admin-console);
browser test sources in
[`tests/integration/admin-console`](../../tests/integration/admin-console);
Docker tests in [`tests/e2e/admin-console`](../../tests/e2e/admin-console).
`tests/e2e/admin-console/model-discovery-browser.mjs` is an opt-in test against
a real Provider; see [Provider management](docs/provider-management.md).

Root targets: `make test-go-unit`, `make test-go` and `make test-integration-go`
run the Go tests; `make test-node` runs the web tests; `make node-lint` type-checks
the web application; `make test-integration-node` runs the browser tests;
`make e2e-stage3` exercises the Console through the full Docker stack.

## Documentation

- [Architecture](docs/architecture.md) - modules, projection boundary, page behavior and failure semantics.
- [Operations](docs/operations.md) - configuration, outbound network access, shutdown and recovery.
- [Observability](docs/observability.md) - tracing scope, content policy and limits.
- [Provider management](docs/provider-management.md) - connections, credential rotation, discovery and BFF routes.
- [Model pricing](docs/model-pricing.md) - pricing contract, editing rules and builtin estimates.
- [Native model inputs](docs/multimodal-models.md) - Image, Audio and PDF capability flags.
- [Catalog availability](docs/catalog-availability.md) - enable/disable commands and configuration delivery status.
- [Managed MCP](docs/managed-mcp.md) - Template-managed stdio MCP servers.
- [Skills](docs/skills.md) - Skill Registry inventory, publication, discovery and promotion.
- [Agent state](docs/agent-state.md) - lifecycle, activation and Runtime condition presentation.
- [Network policy](docs/network-policy.md) - Agent public-network policy and recovery.
- [Execution audit](docs/execution-audit.md) - ACP audit reads and synchronization status.
- [Agent workspace navigation](docs/agent-workspace-navigation.md) - links into Agent UI.
- [Admin contract](../../contracts/admin-console/README.md) and [skill discovery contract](../../contracts/admin-console/skill-discovery.md).
- [Stage 3 admin control plane](../../docs/stage-3-admin-control-plane.md), [model discovery](../../docs/model-discovery.md), [Provider credentials and models](../../docs/provider-credentials-and-models.md), [product surfaces](../../docs/product-surfaces.md).

## Authentication rollout

The [Console authentication contract](../../contracts/admin-console/service-authentication.md)
requires workload identity on application and API routes. Only Gateway may call
these routes; unknown API registrations remain denied. Administrative requests
also require a signed CCT. The signing keys are fetched only from authenticated
Identity and cached for 30 seconds, with one unknown-key refresh per five seconds.
Expired cache or unavailable Identity fails closed. JSON request bodies reject
non-UTF-8 charsets, duplicate members, case aliases and extra documents.

Dependency origins must identify distinct services. Registry shares this policy;
its previous `ANTNEST_SKILL_REGISTRY_API_TOKEN` configuration is removed. External
Provider discovery uses a separate client without workload or CCT credentials.
Identity and Gateway must deploy before Console. Controller, ACP and Registry
consumption, deployment provisioning and complete cross-service Docker acceptance
remain separate batches on `feat/service-authentication`.
