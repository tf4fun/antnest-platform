# Agent Controller

Runtime-managed stdio MCP configuration is documented in
[Managed MCP](docs/managed-mcp.md), including immutable revision ownership,
create/rebuild/enable forwarding, privacy, and verification boundaries.

Agent Controller is the Agent aggregate and lifecycle authority for Antnest
Platform. It turns an immutable Agent specification into one published
executable Agent by coordinating Runtime Controller and Runtime Egress.

## Status

The Stage 2B service surface is implemented. The runnable slices provide
ModelProfile and Template Catalog RPC plus Agent create, rebuild, disable,
enable, and delete. Create freezes an exact Template/Model graph and publishes only after
validating the active owner binding through Identity Service and proving Runtime
readiness. Rebuild replaces the Runtime behind a durable Egress attachment
barrier. Disable closes the attachment and retains the workspace; Enable creates
a new Execution revision and opens the attachment only after Runtime readiness.
Desired network policy remains owned by Runtime Egress and is never rewritten by
Agent lifecycle operations. Delete removes Runtime compute and workspace, releases
the Egress attachment, deactivates owner access, and retains immutable audit
facts. Agent-wide Run admission resolves access, freezes one immutable execution
snapshot, scopes Provider credential access, and seals terminal Tool-effect
facts. Current Agent projection queries and authoritative event replay/watch
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
- Agent-wide serialized Run admission freezing current model parameters, with independently resolved current connection credentials;
- Agent default authorization and organization-scoped Session model selection;
- Agent access-subject mappings and revisions;
- the ordered Agent domain-event journal.
- the persisted Runtime-observation consumer cursor and its Agent-state
  projection.

The `agents` record is the current global Agent status projection. Immutable
revisions, operations, admissions, and events explain how it reached that
state.

## Does Not Own

- ACP Sessions, messages, context, Turns, model calls, or Tool attempts;
- Docker, Kubernetes, container, Pod, workspace, or physical generation IDs;
- Tunnel allocation, Egress policy, packet flow, or conntrack;
- Runtime MCP execution;
- Identity Service users or organization records;
- Skill packages. Stage 2 emits an empty `skill_instructions` list until Skill
  Registry integration is implemented.

## Internal Interfaces

- scoped current workspace availability and active Session observation: see
  [Workspace state](docs/workspace-state.md). Snapshots reuse Run admission data
  and PostgreSQL notifications without adding normal-Run audit events. Gateway
  and Agent UI subscription consumers remain a separate C4 delivery batch.
- Session model directory and Agent authorization defaults: see
  [Session configuration](docs/session-configuration.md). F05 configuration and
  F06 permissions have passed ACP/UI and deployment integration. Native audio/PDF
  authority and F09 delivery boundaries are documented in
  [Multimodal input](docs/multimodal-input.md). Do not roll a changed producer into
  an old strict ACP decoder.
- lifecycle and management RPC: see
  [`../../contracts/agent-controller/control-api.md`](../../contracts/agent-controller/control-api.md);
- ACP Run admission RPC: see
  [`../../contracts/agent-controller/run-api.md`](../../contracts/agent-controller/run-api.md);
- Runtime lifecycle dependency: Runtime Controller internal control API;
- network lifecycle dependency: Runtime Egress control API.
- organization-scoped network policy read/CAS commands: see
  [Network policy management](docs/network-policy.md). These do not rebuild
  Runtime or change its lifecycle attachment.
- owner-binding dependency: Identity Service `resolve_principal` internal RPC.

All interfaces are trusted internal JSON-over-HTTP RPC. Edge Gateway
authenticates external requests through Identity Service. Organization
ownership, owner-user binding, and Agent access are still enforced here as
domain rules; Gateway authentication does not replace Run admission checks.

## Persistence

Agent Controller owns one PostgreSQL database/schema and its migrations. It
never reads or writes another service's tables and has no cross-service foreign
keys, views, triggers, or transactions.

Identity deactivation is consumed through the private revocation RPC. A durable
owner fence prevents new Run admission and schedules the existing Disable saga.
Identity restoration never automatically enables an Agent. See
[Identity offboarding](docs/identity-offboarding.md) for scope, races, recovery,
and pending-runtime semantics.

## Local Verification

```sh
go test ./services/agent-controller/...
make test-agent-controller-postgres
make lint
```

Docker and Jaeger acceptance commands are documented in
[`docs/operations.md`](docs/operations.md).

## Further Reading

- [Observability guarantees and pending acceptance](docs/observability.md)
- [Architecture](docs/architecture.md)
- [Operations](docs/operations.md)
- [Identity offboarding](docs/identity-offboarding.md)
- [Model pricing and immutable Run snapshots](docs/model-pricing.md)
- [Stage 2 Agent and ACP design](../../docs/stage-2-agent-and-acp.md)

All lifecycle commands, including Identity-triggered disable, use [Temporal workflows](docs/lifecycle-workflows.md). PostgreSQL stores business state and audit history, not retry queues or worker leases.
