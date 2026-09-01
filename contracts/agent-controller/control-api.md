# Agent Controller Lifecycle And Management Contract

> Status: Stage 2B implementation contract<br>
> Transport: trusted internal JSON over HTTP<br>
> Owner: Agent Controller

This contract manages ModelProfiles, Templates, Agents, lifecycle operations,
global Agent status projection, and Agent events. It is internal RPC, not a
public OpenAPI. The future Edge Gateway decides which management operations are
externally available and performs transport authentication.

All mutating requests carry a stable `request_id`. Reusing a request ID with a
different canonical request returns `request_id_conflict`. Cross-service IDs
are opaque strings and have no database foreign keys.

Catalog request IDs are unique across every ModelProfile and Template command,
not merely within one route. Concurrent retries serialize on that identity. A
revision command compares the head revision it read with the head locked by the
repository; a concurrent successful revision returns `lifecycle_conflict` and
the caller submits a new intent instead of silently rebasing it.

## Model Profiles

`POST /internal/model-profiles` creates a profile and first immutable revision.
`POST /internal/model-profiles/{model_profile_id}/revisions` creates a new
revision. Provider bearer credentials are accepted only on this trusted
management boundary, encrypted at rest, and returned only through the
admission-scoped Run contract.

Profile revision contains endpoint/model metadata and a credential reference.
Stage 2 creates profiles as enabled. Profile disable/delete management is
deferred; historical Agent revisions are never rewritten.

`GET /internal/model-profiles/{model_profile_id}` returns the current head.
`GET /internal/model-profiles` requires `organization_id` and uses stable
`after_id` plus bounded `limit` pagination. It never returns encrypted
credential bytes or plaintext secrets.

## Templates

`POST /internal/agent-templates` creates a Template and immutable revision.
`POST /internal/agent-templates/{template_id}/revisions` creates another
revision. The request references one enabled ModelProfile revision and contains
Runtime image/resource inputs. Skill references are absent until Skill Registry
exists; the effective list is empty.

Template get/list return current heads only. List requires `organization_id`
and uses the same `after_id`/`limit` pagination. Agent creation resolves the
explicit `(template_id, template_revision)` pair rather than silently using a
newer head.

## Agents

`POST /internal/agents` freezes a Template revision and starts a durable create
operation. It returns the Agent projection, access subject, and operation.

`POST /internal/agents/{agent_id}/rebuild` freezes a target Template revision.
`disable`, `enable`, and `delete` express explicit desired-state transitions.
Lifecycle methods return the durable operation; callers inspect by request ID
after any timeout.

Delete persists desired state `deleted` and lifecycle state `deleting` before
draining Run occupancy. It then fences and resets Egress, removes Runtime
compute and workspace behind the frozen Runtime revision, releases the network
attachment into quarantine, deactivates Agent access, and publishes `deleted`.
An absent Runtime or network is an idempotent success only when the owning
service returns its stable not-found code. Ambiguous effects keep the same
operation non-terminal. Immutable revisions, events, terminal operations, and
Run admissions remain available for retention and audit.

`GET /internal/agents` is the global current-state projection. Deleted Agents
are excluded unless `include_deleted=true`. `GET /internal/agents/{agent_id}`
returns the current projection and active immutable revision identifiers.

## Operations And Events

`GET /internal/agent-operations/{request_id}` returns one durable Saga state.
`GET /internal/agent-events?after_sequence=N` is authoritative global ordered
replay. `GET /internal/agents/{agent_id}/events` filters that journal by Agent.
The corresponding `/watch` routes are best-effort SSE; disconnect and resume
from the last global sequence. Each event also carries a per-Agent aggregate
sequence for local ordering and optimistic projection checks.

## Errors

All errors use:

```json
{
  "code": "agent_not_ready",
  "message": "agent is not ready",
  "retryable": true
}
```

Stable classes distinguish invalid input, missing/disabled references,
idempotency conflicts, lifecycle conflicts, dependency failure, and internal
failure. SQL, secrets, Provider responses, and platform stderr are never
returned.

The machine-readable route catalog and message definitions are in
[`control-contract.json`](control-contract.json). Run admission remains a
separate consumer-specific contract in [`run-contract.json`](run-contract.json).
