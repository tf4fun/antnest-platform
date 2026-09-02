# Agent Controller

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
routes are runnable. Lifecycle HTTP commands atomically persist intent and
return `202`; a supervised PostgreSQL-leased worker is the sole phase executor
and can claim fresh due operations immediately. It fences overlapping attempts,
isolates malformed operations, and emits a new trace linked to the original
request and previous worker attempt. A separate bounded observation consumer
reads Runtime Controller's ordered journal. A same-revision process restart
invalidates the executable binding, marks the Agent unavailable, and requires
an explicit rebuild instead of silently using a stale execution identity. Full
Stage 2 integrated Docker and Jaeger acceptance is tracked separately from this
service-local implementation status.

## Owns

- Agent identity, organization, owner user, desired state, and current status;
- Model profiles and encrypted Provider credentials used by Agent execution;
- mutable Template heads and immutable Template revisions;
- immutable Agent configuration and execution revisions;
- the current opaque Runtime binding returned by Runtime Controller;
- durable lifecycle operations for create, rebuild, disable, enable, and delete;
- Agent-wide serialized Run admission and admission-scoped credential access;
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

- lifecycle and management RPC: see
  [`../../contracts/agent-controller/control-api.md`](../../contracts/agent-controller/control-api.md);
- ACP Run admission RPC: see
  [`../../contracts/agent-controller/run-api.md`](../../contracts/agent-controller/run-api.md);
- Runtime lifecycle dependency: Runtime Controller internal control API;
- network lifecycle dependency: Runtime Egress control API.
- owner-binding dependency: Identity Service `resolve_principal` internal RPC.

All interfaces are trusted internal JSON-over-HTTP RPC. Authentication belongs
to the future Edge Gateway. Organization ownership, owner-user binding, and
Agent access are still enforced as domain rules.

## Persistence

Agent Controller owns one PostgreSQL database/schema and its migrations. It
never reads or writes another service's tables and has no cross-service foreign
keys, views, triggers, or transactions.

## Local Verification

```sh
go test ./services/agent-controller/...
make test-agent-controller-postgres
make lint
```

Docker and Jaeger acceptance commands are documented in
[`docs/operations.md`](docs/operations.md).

## Further Reading

- [Architecture](docs/architecture.md)
- [Operations](docs/operations.md)
- [Stage 2 Agent and ACP design](../../docs/stage-2-agent-and-acp.md)
