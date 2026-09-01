# Agent Controller

Agent Controller is the Agent aggregate and lifecycle authority for Antnest
Platform. It turns an immutable Agent specification into one published
executable Agent by coordinating Runtime Controller and Runtime Egress.

## Status

Stage 2B implementation is in progress. The runnable slices provide
ModelProfile and Template Catalog RPC plus Agent create, rebuild, disable, and
enable. Create freezes an exact Template/Model graph and publishes only after
Runtime readiness. Rebuild replaces the Runtime behind a durable network
barrier. Disable retains the workspace and captures the previous Egress policy;
Enable creates a new Execution revision and restores only that captured policy
after Runtime readiness. Delete, Run admission, Agent queries, and event replay
routes remain target contracts until their corresponding slices are completed.

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
