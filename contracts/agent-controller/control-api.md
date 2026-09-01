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

The list route accepts optional `organization_id`, `owner_user_id`, and
`lifecycle_state` filters. `owner_user_id` is the immutable Identity Service
user identity frozen at Agent creation; Agent Controller neither copies user
profiles nor joins the Identity Service database. Results are ordered by the
immutable `(created_at, agent_id)` pair. `cursor` is an opaque, versioned
continuation token for that pair, and `limit` is bounded to 1–200 (default 100).
Clients must continue with the same filter set; changing filters starts a new
query. Present-but-empty, duplicate, malformed, and unknown query parameters
are rejected rather than interpreted as a broader query.
An explicit `lifecycle_state=deleting|deleted` filter does not override deletion
visibility: callers must also set `include_deleted=true`. Explicit get remains
available for deleted Agents so audit and administrator workflows can resolve a
known identity.

Every Agent response includes `aggregate_sequence`. It is the sequence of the
last event already reflected by the current projection, allowing callers to
correlate query state with the event journal without treating query pagination
as an event stream.

## Operations And Events

`GET /internal/agent-operations/{request_id}` returns one durable Saga state.
`GET /internal/agent-events?after_sequence=N` is authoritative global ordered
replay. `GET /internal/agents/{agent_id}/events` filters that journal by Agent.
The corresponding `/watch` routes are best-effort SSE; disconnect and resume
from the last global sequence. Each event also carries a per-Agent aggregate
sequence for local ordering and optimistic projection checks.

`after_sequence` is an exclusive global cursor and defaults to zero. List
limits are bounded to 1–500 (default 100). `next_sequence` is the last returned
global sequence, or the caller's unchanged cursor when no event is available.
Per-Agent routes return `agent_not_found` for an unknown Agent, including an
Agent with no events yet. Query parameters use the same fail-closed rules as
Agent projection queries.

Watch first replays every event after the requested sequence and then waits for
new commits. SSE `id` is the global sequence and `event` is `agent_event`.
Callers may resume with `after_sequence` or `Last-Event-ID`. When EventSource
automatically reconnects with both, `Last-Event-ID` takes precedence over the
original URL query. Watch is only a wake-up/streaming convenience: after disconnect,
consumers resume through authoritative List. Each consumer persists the last
fully applied global sequence in its own service database and applies events
idempotently by `event_id`; Agent Controller does not own consumer offsets or
delivery acknowledgements.

Global sequences are allocated by one transaction-locked journal cursor. Event
transactions therefore commit in global-sequence order; a consumer that has
persisted sequence `N` cannot later observe a newly committed sequence below
`N`. PostgreSQL notifications are process-local wake-up hints delivered through
one dedicated listener connection and never define replay order.

The stable consumer contract is the event envelope and enumerated `event_type`.
`data` is versioned audit detail, not a projection patch. A consumer that needs
current Agent state treats the event as an invalidation signal and reads the
Agent projection; it must not reconstruct business state from undocumented
payload keys.

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

The machine-readable route catalog is in
[`control-contract.json`](control-contract.json), and message definitions are
in [`control-api.schema.json`](control-api.schema.json). Run admission remains
a separate consumer-specific contract in [`run-contract.json`](run-contract.json).
