# Workspace Metadata

Controller owns Agent management metadata, not execution availability or active Sessions.

## Contract

`POST /rpc/agent-controller/list-workspace-agents` accepts request_id, organization_id,
principal_id and optional limit/cursor. It returns agents containing only agent_id
and name, plus a nullable next_cursor. Empty results use an empty array.

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

Revision 26 is the Controller producer contract. Gateway and Agent UI must adopt
the metadata shape and ACP observation in B3/B4U before deployment. No fallback,
per-Agent status fan-out or Controller execution proxy is provided.

Controller regressions cover exact JSON fields, no-store, empty results, keyset
pagination, organization/principal/binding/revocation scope, desired deletion,
discovery after Runtime loss, retired routes and listing without the old Run table.
Existing management event and default-authorization revocation tests remain.
Cross-service cancellation, reconnect and Jaeger checks belong to B5.
