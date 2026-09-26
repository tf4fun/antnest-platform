# Agent Controller

## Dependency baseline (2026-09-26)

Go 1.27.1, Temporal SDK 1.49.0 / API 1.63.6, pgx 5.11.0, and
OpenTelemetry 1.46.0 / log 0.22.0 are the current baseline. The service-local
race, contract, build, and lint gates precede database and Temporal workflow
regression on the refreshed platform images. See the
[dependency refresh record](../../docs/dependency-refresh-20260926.md).

Runtime-managed stdio MCP configuration is documented in
[Managed MCP](docs/managed-mcp.md), including immutable revision ownership,
create/rebuild/enable forwarding, privacy, and verification boundaries.

Agent Controller is the Agent aggregate and lifecycle authority for Antnest
Platform. It turns an immutable Agent specification into one published
executable Agent by coordinating Runtime Controller and Runtime Egress.

## Resource identifiers

The [platform resource ID contract](../../contracts/resource-identifiers.md)
separates resource kind from retry purpose. Create and Rebuild both generate
`agentspec_` IDs; execution revisions use `execution_`, and all lifecycle,
Runtime observation and owner-revocation events use `event_`. Stable namespaces
retain retry deduplication, and Agent ID derivation is byte-for-byte unchanged.
Existing records, client request keys, content digests and Runtime incarnation
tokens are unchanged. Identity and ACP own their respective resource generators.

## Status

The Controller/ACP execution-boundary refactor was closed by the user's scoped
acceptance decision on 2026-09-15. Configuration publication
and lifecycle settlement are wired in the main process; the five old execution
RPCs, their RunService injection, workspace execution queries and occupancy
notifications, Run application/storage/schema and Session override merging have been removed.
Service-local gates, including the management synchronization read follow-up,
have passed. Gateway and Console have switched and passed the scoped integration.
Agent UI was excluded from that refactor's gate; its subsequent workspace and
browser batches are tracked in [current status](../../docs/current-status.md).
It remains an ACP client, not a management authority. Nine Controller/ACP Docker and protocol-client scenarios and trace
topology checks passed. Jaeger clock warnings are deferred as OBS-ACP-CLOCK;
the strict script still reports failure and its result is not rewritten. See the
[final results and explicit exception](../../docs/controller-acp-execution-boundary-plan.md#103-可执行的小步交付).

The Stage 2B service surface is implemented. The runnable slices provide
ModelProfile and Template Catalog RPC plus Agent create, rebuild, disable,
enable, and delete. Create validates the active owner through Identity Service
and freezes an exact Template/Model graph. Create, rebuild and enable complete
after platform creation and Egress attachment opening, without waiting for
Runtime health. The Agent is `created/enabled` and cannot Run until independent
healthy observation publishes its execution binding. Rebuild uses the existing
attachment barrier; disable retains the workspace. Never-ready Agents still
support rebuild, disable, enable and delete. See
[creation versus availability](docs/runtime-availability.md).
Desired network policy remains owned by Runtime Egress and is never rewritten by
Agent lifecycle operations. Delete removes Runtime compute and workspace, releases
the Egress attachment, deactivates owner access, and retains immutable audit
facts. Controller publishes current non-secret configuration and current Provider
credentials to ACP. ACP owns Run admission, execution and terminal audit.
Current Agent projection queries and authoritative event replay/watch
routes are runnable. Lifecycle HTTP commands return `202` after durable admission.
[All lifecycle operations use Temporal](docs/lifecycle-workflows.md), with an
embedded SDK Worker and automatic workflow/activity tracing. Identity-triggered
Disable uses the same executor. PostgreSQL retains business state, not a second
scheduler. Every workflow preserves the original business trace. A separate bounded observation consumer
reads Runtime Controller's ordered journal. A same-revision process restart
invalidates the executable binding, marks the Agent unavailable, and requires
an explicit rebuild instead of silently using a stale execution identity.
Stage 3 Docker and Jaeger evidence covers the administrator lifecycle and
managed MCP create/chat/rebuild path. Broader restart, Identity integration,
and operational acceptance remains tracked in the
[single-node closeout](../../docs/docker-single-node-closeout.md).

## Owns

- Agent identity, organization, owner user, desired state, and current status;
- [Provider connections and model management](docs/provider-management.md), with independent encrypted credential versions;
- mutable Template heads and immutable Template revisions referencing stable model identities;
- immutable Agent configuration and execution revisions;
- the current opaque Runtime binding returned by Runtime Controller;
- durable lifecycle operations for create, rebuild, disable, enable, and delete;
- current execution configuration publication and Agent-level lifecycle settlement;
- Agent default authorization and the organization model catalog (Session selection belongs to ACP);
- Agent ownership/access bindings and revisions published to ACP;
- the ordered Agent domain-event journal.
- the persisted Runtime-observation consumer cursor and its Agent-state
  projection.

The `agents` record is the current global Agent status projection. Immutable
revisions, operations and management events explain how it reached that
state.

## Does Not Own

- ACP Sessions, Runs, execution audit, messages, context, Turns, model calls, or Tool attempts;
- Docker, Kubernetes, container, Pod, workspace, or physical generation IDs;
- Tunnel allocation, Egress policy, packet flow, or conntrack;
- Runtime MCP execution;
- Identity Service users or organization records;
- Skill packages. Stage 2 emits an empty `skill_instructions` list until Skill
  Registry integration is implemented.

## Internal Interfaces

- authorized workspace Agent IDs/names and lifecycle/activation/Runtime metadata:
  see [Workspace metadata](docs/workspace-state.md). ACP owns execution state and
  active Session observation; these management fields never grant admission.
- Agent default authorization: see [Agent configuration](docs/agent-configuration.md).
  Session model selection and per-Session authorization overrides belong to ACP.
- current configuration publishing and lifecycle settlement: see
  [Execution publication](docs/execution-publication.md).
- stored configuration revision and ACP acknowledgement:
  `GET /internal/execution-synchronization?organization_id=...` returns this
  service's synchronization record, or null if none exists. It is not an ACP
  health, Agent readiness or Run occupancy check.
- lifecycle and management RPC: see
  [`../../contracts/agent-controller/control-api.md`](../../contracts/agent-controller/control-api.md);
- Runtime lifecycle dependency: Runtime Controller internal control API;
- network lifecycle dependency: Runtime Egress control API.
- organization-scoped network policy read/CAS commands: see
  [Network policy management](docs/network-policy.md). These do not rebuild
  Runtime or change its lifecycle attachment.
- owner-binding dependency: Identity Service `resolve_principal` internal RPC.

All interfaces are trusted internal JSON-over-HTTP RPC. Edge Gateway
authenticates external requests through Identity Service. Organization
ownership, owner-user binding, and Agent access are still enforced here as
domain rules; Gateway authentication does not replace management authorization.
ACP independently checks synchronized resource authorization at its protocol boundary.

## Persistence

Agent Controller owns one PostgreSQL database/schema and its migrations. It
never reads or writes another service's tables and has no cross-service foreign
keys, views, triggers, or transactions.

Identity deactivation is consumed through the private revocation RPC. A durable
owner fence closes the published execution permission and schedules the existing Disable saga.
Identity restoration never automatically enables an Agent. See
[Identity offboarding](docs/identity-offboarding.md) for scope, races, recovery,
and pending-runtime semantics.

## Local Verification

Run these commands serially from the repository root:

```sh
go test ./services/agent-controller/...
make test-agent-controller-postgres
make lint
```

Unit and isolated component tests remain alongside the service packages.
Real PostgreSQL, Temporal and HTTP-with-PostgreSQL test sources live in
[`tests/integration/go/agent-controller`](../../tests/integration/go/agent-controller).
The root Go runner overlays these tests into their owning packages, preserving
private implementation access without duplicating the test sources.

To run the Temporal integration package, set `ANTNEST_TEMPORAL_TEST_ADDRESS`
and use:

```sh
node tests/integration/go/run.mjs agent-controller --package internal/orchestration -- -count=1
```

The repository's commit-before-acknowledgement recovery test additionally needs
`ANTNEST_AGENT_CONTROLLER_TEST_DATABASE_URL` for a disposable database. With both
dependencies configured, the root runner can run the complete service integration
set by omitting `--package`.

Docker and Jaeger acceptance commands are documented in
[`docs/operations.md`](docs/operations.md).

## Further Reading

- [Execution configuration publication: B2 in progress](docs/execution-publication.md)
- [Owner-managed Agent default authorization](docs/agent-configuration.md)
- [Observability guarantees and pending acceptance](docs/observability.md)
- [Workflow span lifetime during graceful worker shutdown](docs/workflow-span-lifecycle.md)
- [Architecture](docs/architecture.md)
- [Operations](docs/operations.md)
- [Identity offboarding](docs/identity-offboarding.md)
- [Model pricing and immutable Run snapshots](docs/model-pricing.md)
- [Stage 2 Agent and ACP design](../../docs/stage-2-agent-and-acp.md)

All lifecycle commands, including Identity-triggered disable, use [Temporal workflows](docs/lifecycle-workflows.md). PostgreSQL stores business state and audit history, not retry queues or worker leases.
