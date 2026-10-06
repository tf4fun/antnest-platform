# Agent Controller

Agent Controller is the Agent aggregate and lifecycle authority for Antnest
Platform. It turns an immutable Agent specification into one published
executable Agent by coordinating Runtime Controller and Runtime Egress. It is
written in Go.

Lifecycle commands are durable Temporal workflows. PostgreSQL stores business
state, immutable revisions and audit history, not retry queues or worker
leases. Resource creation completes separately from executable availability:
an Agent becomes runnable only after independent healthy Runtime observation
publishes its execution binding.


Workload transport and signed CCT verification use the
[shared Go module](../../modules/service-authentication/README.md). Controller
uses the caller-context forwarding policy; Agent authorization, lifecycle
coordination and Runtime authority relay remain Controller-owned.

Startup follows the [development secret policy](../../contracts/platform/development-secrets.md): published PostgreSQL passwords and uniform 32-byte encryption keys are rejected by default. The exact independent `ANTNEST_ALLOW_PUBLIC_DEV_SECRETS=true` opt-in emits variable-only WARNs and never restores the removed Registry bearer.

## Responsibilities

- Agent identity, organization, owner user, desired state and current status.
  The `agents` record is the current global status projection; immutable
  revisions, operations and events explain how it reached that state.
- [Provider connections and model management](docs/provider-management.md),
  with independently versioned encrypted credentials.
- Mutable Template heads and immutable Template revisions that reference stable
  model identities and exact Skill Registry versions.
- Immutable Agent configuration (AgentSpec) and execution revisions.
- The current opaque Runtime binding returned by Runtime Controller.
- Durable Skill preparation intents and their organization-scoped progress view.
- Durable lifecycle operations for create, rebuild, disable, enable and delete.
- Publication of current execution configuration to ACP and Agent-level
  lifecycle settlement.
- Agent default authorization and the organization model catalog.
- Agent ownership and access bindings, and the revisions published to ACP.
- The per-Agent Skill learning policy, with its own SHA-256 revision.
- The ordered Agent domain-event journal.
- The persisted Runtime-observation consumer cursor and its Agent-state
  projection.
- Consumption of Identity Service owner revocations, which close execution
  permission and schedule the Disable workflow.

## Non-responsibilities

- ACP Sessions, Runs, execution audit, messages, context, Turns, model calls,
  Tool attempts and Session model selection.
- Docker, Kubernetes, container, Pod, workspace or physical generation IDs.
- Tunnel allocation, Egress policy, packet flow or conntrack. Desired network
  policy is owned by Runtime Egress and is never rewritten by lifecycle
  operations.
- Runtime MCP execution.
- Identity Service users or organization records.
- Skill package bytes. The execution projection always emits
  `skill_instructions: []`; Runtime reads Skill content on demand.
- The background Skill learner, which runs in ACP.

## Interfaces

All interfaces are authenticated internal JSON-over-HTTP RPC. Controller verifies
each workload and required Identity-signed caller context independently of
Gateway. Signed Organization/actor/Agent scope, ownership and access rules are
enforced here; raw identity hints provide no authority.

| Direction | Interface                                                                                                | Purpose                                                                                                          |
| --------- | -------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| Inbound   | `/internal/provider-connections`, `/internal/model-profiles`, `/internal/agent-templates`                | Provider, model and Template catalog management ([control API](../../contracts/agent-controller/control-api.md)) |
| Inbound   | `POST /internal/agents`, `POST /internal/agents/{agent_id}/{rebuild,disable,enable,delete}`              | Lifecycle commands; return `202` after durable admission                                                         |
| Inbound   | `GET /internal/agents`, `GET /internal/agent-operations/{request_id}`                                    | Agent projections and lifecycle operation status                                                                 |
| Inbound   | `GET /internal/agent-events`, `GET /internal/agents/{agent_id}/events` and their `/watch` routes         | Authoritative event replay and best-effort SSE wake-up                                                           |
| Inbound   | `GET /internal/agent-skill-preparations/{request_id}`                                                    | Skill preparation progress before the Agent row exists                                                           |
| Inbound   | `GET`/`PUT /internal/agents/{agent_id}/network-policy`                                                   | Organization-scoped network policy read and CAS ([network policy](docs/network-policy.md))                       |
| Inbound   | `GET`/`PUT /internal/agents/{agent_id}/skill-learning-policy`                                            | Owner-scoped Skill learning policy ([learning API](../../contracts/skill-learning/learning-api.md))              |
| Inbound   | `GET /internal/execution-synchronization`                                                                | Stored configuration revision and ACP acknowledgement; not a health check                                        |
| Inbound   | `POST /rpc/agent-controller/list-workspace-agents`, `POST /rpc/agent-controller/set-agent-authorization` | [Workspace metadata](docs/workspace-state.md) and [Agent default authorization](docs/agent-configuration.md)     |
| Inbound   | `GET /status`                                                                                            | Readiness probe                                                                                                  |
| Outbound  | Runtime Controller internal control API                                                                  | Runtime lifecycle, inspection, observation, Skill preparation and private current-instance connection resolution |
| Outbound  | Runtime Egress control API                                                                               | Network allocation, attachment open/close and policy reads/CAS                                                   |
| Outbound  | Identity Service internal RPC                                                                            | `resolve_principal`, owner authorization and revocation receipt                                                  |
| Outbound  | Agent ACP Service                                                                                        | [Execution configuration publication](docs/execution-publication.md) and lifecycle settlement                    |
| Outbound  | Skill Registry                                                                                           | Resolve exact Skill versions for Template revisions (optional)                                                   |

Resource identifiers follow the
[platform resource ID contract](../../contracts/resource-identifiers.md). Create
and Rebuild generate `agentspec_` IDs, execution revisions use `execution_`,
and lifecycle, Runtime observation and owner-revocation events use `event_`.

## Configuration

| Variable                                                                                          | Required                   | Default             | Description                                                                                                 |
| ------------------------------------------------------------------------------------------------- | -------------------------- | ------------------- | ----------------------------------------------------------------------------------------------------------- |
| `ANTNEST_AGENT_CONTROLLER_DATABASE_URL`                                                           | Yes                        | -                   | PostgreSQL connection URL for the service-owned database.                                                   |
| `ANTNEST_AGENT_CONTROLLER_ENCRYPTION_KEY`                                                         | Single-key mode            | -                   | Canonical Base64 for 32 bytes, mapped to `local-v1`; mutually exclusive with the key ring.                   |
| `ANTNEST_AGENT_CONTROLLER_ENCRYPTION_KEYS`                                                        | Ring mode                  | -                   | Exact comma-separated `kid:base64key` entries; active and decrypt-only keys.                                 |
| `ANTNEST_AGENT_CONTROLLER_ENCRYPTION_ACTIVE_KID`                                                  | Ring mode                  | -                   | Exact ID of the ring entry used for new envelopes.                                                         |
| `ANTNEST_AGENT_ACP_CONTROL_URL`                                                                   | Yes                        | -                   | ACP's dedicated Controller-only HTTP(S) control origin; distinct from the workspace listener.               |
| `ANTNEST_RUNTIME_CONTROLLER_URL`                                                                  | Yes                        | -                   | Runtime Controller base URL.                                                                                |
| `ANTNEST_RUNTIME_EGRESS_URL`                                                                      | Yes                        | -                   | Runtime Egress base URL.                                                                                    |
| `ANTNEST_IDENTITY_SERVICE_URL`                                                                    | Yes                        | -                   | Identity Service base URL.                                                                                  |
| `ANTNEST_SKILL_REGISTRY_URL`                                                                      | No                         | -                   | Optional pinned Registry origin; requires its own outgoing service credential when enabled.                 |
| `ANTNEST_SERVICE_AUTH_MODE`                                                                       | Yes                        | -                   | Exact `token` or `mtls`; no fallback or whitespace trimming.                                                |
| `ANTNEST_SERVICE_AUTH_CALLERS_FILE`                                                               | In token mode              | -                   | Private JSON caller-to-SHA256 map, loaded once at startup.                                                  |
| `ANTNEST_SERVICE_AUTH_TOKEN_DIR`                                                                  | In token mode              | -                   | Private receiver-named token files, checked at startup and reread for every outgoing request.               |
| `ANTNEST_SERVICE_AUTH_ALLOW_INSECURE_TRANSPORT`                                                   | No                         | `false` when absent | Exact Boolean; `true` is an explicit development-only token/HTTP opt-in.                                    |
| `ANTNEST_TLS_CA_FILE`, `ANTNEST_TLS_CERT_FILE`, `ANTNEST_TLS_KEY_FILE`, `ANTNEST_TLS_SERVER_NAME` | Except insecure token/HTTP | -                   | TLS 1.3 chain, DNS name and exact workload URI validation.                                                  |
| `ANTNEST_AGENT_CONTROLLER_LISTEN`                                                                 | No                         | `:8080`             | Listen address; `--healthcheck` follows the configured host and port. Missing/wildcard hosts use `127.0.0.1`. |
| `ANTNEST_TEMPORAL_ADDRESS`                                                                        | No                         | `127.0.0.1:7233`    | Temporal frontend address.                                                                                  |
| `ANTNEST_AGENT_CONTROLLER_DEPENDENCY_TIMEOUT`                                                     | No                         | `150s`              | Timeout for dependency RPC clients and the HTTP write timeout.                                              |
| `ANTNEST_AGENT_CONTROLLER_DRAIN_TIMEOUT`                                                          | No                         | `5m`                | Lifecycle drain timeout.                                                                                    |
| `ANTNEST_AGENT_CONTROLLER_SHUTDOWN_TIMEOUT`                                                       | No                         | `15s`               | Graceful shutdown timeout for the server and Temporal worker.                                               |
| `ANTNEST_AGENT_CONTROLLER_RUNTIME_OBSERVATION_POLL_INTERVAL`                                      | No                         | `2s`                | Runtime Controller observation journal poll interval.                                                       |
| `ANTNEST_AGENT_CONTROLLER_IDENTITY_REVOCATION_POLL_INTERVAL`                                      | No                         | `2s`                | Identity Service revocation poll interval.                                                                  |
| `ANTNEST_ACP_MAX_CONFIGURATION_BYTES`                                                             | No                         | `16777216`          | Maximum published configuration size, between `1024` and `67108864`.                                        |
| `ANTNEST_AGENT_CONTROLLER_EXECUTION_RESYNC_INTERVAL`                                              | No                         | `30s`               | Periodic configuration resynchronization interval.                                                          |
| `ANTNEST_AGENT_CONTROLLER_EXECUTION_RETRY_INTERVAL`                                               | No                         | `1s`                | Initial publication retry interval.                                                                         |
| `ANTNEST_AGENT_CONTROLLER_EXECUTION_MAX_RETRY_INTERVAL`                                           | No                         | `30s`               | Maximum publication retry interval; must not be lower than the initial interval.                            |
| `ANTNEST_AGENT_CONTROLLER_EXECUTION_REQUEST_TIMEOUT`                                              | No                         | `15s`               | Timeout for one publication request to ACP.                                                                 |
| `ANTNEST_ENVIRONMENT`                                                                             | No                         | -                   | Deployment environment recorded in telemetry resource attributes.                                           |
| `ANTNEST_TELEMETRY_CAPTURE_RPC_CONTENT`                                                           | No                         | `false`             | `true` or `false`; development-only RPC payload capture. Provider and credential routes stay metadata-only. |
| `OTEL_SDK_DISABLED`                                                                               | No                         | -                   | `true` disables all OpenTelemetry export.                                                                   |
| `OTEL_SERVICE_NAME`                                                                               | No                         | `agent-controller`  | Telemetry service name.                                                                                     |
| `OTEL_EXPORTER_OTLP_ENDPOINT`, `OTEL_EXPORTER_OTLP_{TRACES,METRICS,LOGS}_ENDPOINT`                | No                         | -                   | OTLP endpoints. A signal exports only when an endpoint is set or its exporter is `otlp`.                    |
| `OTEL_{TRACES,METRICS,LOGS}_EXPORTER`                                                             | No                         | -                   | `otlp` or `none` per signal.                                                                                |
| `OTEL_EXPORTER_OTLP_PROTOCOL`, `OTEL_EXPORTER_OTLP_{TRACES,METRICS,LOGS}_PROTOCOL`                | No                         | `http/protobuf`     | Only `http/protobuf` is supported.                                                                          |

Duration values use Go duration syntax and must be positive.

`--healthcheck` probes the configured IPv4/IPv6 `/status` directly, bypassing
environment proxies and refusing redirects while preserving TLS service identity.
An empty TLS CA setting does not switch opted-in token/HTTP development probes
to HTTPS. See the
[purpose-listener deployment contract](../../contracts/platform/service-authentication.md#5-networkdeployment-batch).

The [authentication contract](../../contracts/agent-controller/service-authentication.md)
defines route callers, signed user scope, strict JSON and private client forwarding.
All configured dependency origins must be distinct; redirects and environment proxies
are disabled. A nonempty legacy `ANTNEST_AGENT_ACP_SERVICE_URL` or
`ANTNEST_SKILL_REGISTRY_API_TOKEN` now fails startup. Controller discovery and creation enforce the shared Provider destination policy
and no longer export keys through `/access`. The publisher now verifies and
privately relays RC-issued instance authority for accepting Agents; closed
Agents carry only execution fences and do not require resolution. Tokens are
never persisted in Controller or exposed through its management projection.
See [execution publication](docs/execution-publication.md#private-runtime-authority).
Instance issuer, receiver and client service batches have passed their own gates;
coordinated deployment and final token-profile business E2E are admitted in the
[rollout ledger](../../contracts/platform/service-authentication-rollout.json).

## Dependencies

- PostgreSQL: one service-owned database and schema with its own migrations.
  The service never reads or writes another service's tables and has no
  cross-service foreign keys, views, triggers or transactions. Required at
  startup.
- Temporal: runs all lifecycle workflows through an embedded SDK worker.
- Runtime Controller and Runtime Egress: required for lifecycle progress. Outages
  leave operations retryable at their current phase.
- Identity Service: owner resolution at create and enable, and the revocation
  feed. See [Identity offboarding](docs/identity-offboarding.md).
- Agent ACP Service: receives published configuration. A background publisher
  retries failed publication with bounded backoff; lifecycle drain waits for ACP
  to confirm the closed configuration and settlement.
- Skill Registry: optional. Without it, the catalog has no Skill version
  resolver and cannot freeze Template Skill references.

## Build and test

Run these commands serially from the repository root unless stated otherwise.

```sh
(cd services/agent-controller && GOWORK=off go test ./...)
node tests/integration/go/run.mjs agent-controller
make test-agent-controller-postgres
node tests/e2e/service-authentication/controller/run.mjs
make go-lint
docker compose --profile stage3 build agent-controller
```

- `GOWORK=off go test ./...` runs unit and isolated component tests from the
  service directory.
- Real PostgreSQL, Temporal and HTTP-with-PostgreSQL test sources live in
  [`tests/integration/go/agent-controller`](../../tests/integration/go/agent-controller).
  The root Go runner overlays them into their owning packages, so they keep
  access to private implementation without duplicating test sources. To run
  only the Temporal package, use
  `node tests/integration/go/run.mjs agent-controller --package internal/orchestration -- -count=1`.
- `make test-agent-controller-postgres` starts disposable PostgreSQL and
  Temporal dependencies and runs the full integration set.
- The image builds from `services/agent-controller/Dockerfile` with the
  repository root as build context.
- Root targets `make test-go`, `make test-go-unit`, `make lint` and
  `make docker-build-stage3` include this service.

Test-only variables:

- `ANTNEST_TEMPORAL_TEST_ADDRESS`: Temporal address for workflow integration tests.
- `ANTNEST_AGENT_CONTROLLER_TEST_DATABASE_URL`: disposable database for the
  commit-before-acknowledgement recovery test.

Docker and Jaeger verification procedures are described in
[Operations](docs/operations.md).

## Documentation

- [Architecture](docs/architecture.md) - aggregate model, lifecycle sagas, persistence and extension rules
- [Operations](docs/operations.md) - startup, migrations, recovery and verification procedures
- [Lifecycle workflows](docs/lifecycle-workflows.md) - Temporal workflow and activity design
- [Runtime availability](docs/runtime-availability.md) - creation versus executable availability
- [Agent state](docs/agent-state.md) - lifecycle, activation and Runtime state hierarchy
- [Execution publication](docs/execution-publication.md) - configuration publication to ACP and lifecycle settlement
- [Agent configuration](docs/agent-configuration.md) - owner-managed Agent default authorization
- [Session configuration](docs/session-configuration.md) - Agent defaults versus ACP Session settings
- [Provider management](docs/provider-management.md) - Provider connections, credentials and models
- [Model pricing](docs/model-pricing.md) - model pricing and immutable Run snapshots
- [Multimodal input](docs/multimodal-input.md) - model input capabilities
- [Managed MCP](docs/managed-mcp.md) - Runtime-managed stdio MCP configuration
- [Network policy](docs/network-policy.md) - network policy management through Runtime Egress
- [Identity offboarding](docs/identity-offboarding.md) - owner revocation handling
- [Workspace metadata](docs/workspace-state.md) - workspace Agent list
- [Observability](docs/observability.md) - tracing, metrics and logging guarantees
- [Workflow span lifecycle](docs/workflow-span-lifecycle.md) - workflow spans during graceful worker shutdown
- [Control API contract](../../contracts/agent-controller/control-api.md)
- [Skill learning contract](../../contracts/skill-learning/learning-api.md)
- [Platform resource identifiers](../../contracts/resource-identifiers.md)
- [Skill Registry design](../../docs/skill-registry-minimal-design.md)
- [Agent lifecycle state model](../../docs/agent-lifecycle-state-model.md)
- [Docker single-node operations](../../docs/docker-single-node-operations.md)

Provider endpoints default to public unicast only. The exact operator option
`ANTNEST_PROVIDER_ALLOW_PRIVATE_ENDPOINTS=true` enables private/local LLM endpoints
and is unsafe for multi-tenant use; empty, padded or other values fail startup.
See [Provider management](docs/provider-management.md) for DNS pinning, error
classes and model-only saved/draft discovery. Consumer and final integration
admission are recorded in the rollout ledger.
