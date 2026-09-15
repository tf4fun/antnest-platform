# Workspace Metadata

Controller owns Agent management metadata, not execution availability or active Sessions.

## Contract

`POST /rpc/agent-controller/list-workspace-agents` accepts request_id, organization_id,
principal_id and optional limit/cursor. Each Agent contains agent_id, name,
lifecycle_state, activation_state and runtime_state, plus a nullable page
next_cursor. Empty results use an empty array.

activation_state is present only for lifecycle_state=created, matching the
existing management Agent contract; an uncreated Agent has no confirmed activation.
These are the existing management facts from the Agent row, returned by the
same scoped list query. Lifecycle is not_created/created/deleted; activation is
enabled/disabled; Runtime is unknown/waiting/available/unhealthy/exited/absent.
They describe the last observed deployment state, not ACP busy/idle, transport
connectivity or permission to submit a prompt. No Runtime or ACP request is made
to populate the list. Runtime available must never unlock chat input by itself.

Queries require the requested organization and principal, an active access binding,
and a non-revoked owner authorization watermark. Deleted desired state is excluded
immediately, including pending or failed deletion. Disabled, starting and unavailable
Agents remain discoverable while the caller retains access. The list is not permission
to execute. Database pagination uses created_at and agent_id; opaque cursors preserve
that ordering. HTTP responses carry Cache-Control: no-store.

## Execution State Is Owned By ACP

The old Controller state and state/watch endpoints return 404. Availability,
active Session, execution revision and cancellation observation come from ACP's
[execution-state contract](../../../contracts/agent-acp/execution-api.md).
No Controller Run table or notification is read to assemble this list, and no
default ready value substitutes for missing ACP state.

Agent management journal get/watch and its shared PostgreSQL notifier remain.
Only the Run occupancy notification function and triggers are removed; management
commits must still wake their subscribers.

## Delivery And Verification

Revision 29 adds management state to the existing discovery projection. Gateway
and Agent UI must consume these fields before the coordinated deployment. No
fallback, per-Agent status fan-out or Controller execution proxy is provided.

Controller regressions cover exact JSON fields, no-store, empty results, keyset
pagination, organization/principal/binding/revocation scope, desired deletion,
discovery after Runtime loss, retired routes and listing without the old Run table.
Existing management event and default-authorization revocation tests remain.
Cross-service cancellation, reconnect and Jaeger checks belong to B5.
