# Agent Controller Lifecycle And Management Contract

> Status: Stage 2B implementation contract<br>
> Revision: 19<br>
> Transport: trusted internal JSON over HTTP<br>
> Owner: Agent Controller

This contract manages ModelProfiles, Templates, Agents, lifecycle operations,
global Agent status projection, and Agent events. It is internal RPC, not a
public OpenAPI. Edge Gateway decides which management operations are
externally available and performs transport authentication.

Lifecycle and catalog mutations carry a stable `request_id`. Reusing a request ID with a
different canonical request returns `request_id_conflict`. Cross-service IDs
are opaque strings and have no database foreign keys.

Catalog request IDs are unique across every Provider connection, credential, ModelProfile and Template command,
not merely within one route. Concurrent retries serialize on that identity. A
revision command compares the head revision it read with the head locked by the
repository; a concurrent successful revision returns `lifecycle_conflict` and
the caller submits a new intent instead of silently rebasing it.

## Workspace State

`GET /internal/workspace/agents/{agent_id}/state` and the corresponding
`/state/watch` endpoint require `organization_id` and `principal_id`. They return
only current availability, access permission, Agent aggregate revision and the
requesting principal's active Session ID. Neither returns an access subject,
Provider credential, prompt, or executable configuration.

Watch emits full `workspace_state` SSE snapshots without event IDs or replay
cursors. It is a current-state observation, separate from the ordered audit
journal. Lost access produces a sanitized terminal snapshot; failed reads or
subscription registration close the stream. A retrying LISTEN connection alone
does not provide a freshness bound. See the service's
[Workspace state contract](../../services/agent-controller/docs/workspace-state.md)
for lifecycle barriers, admission semantics, freshness limits and consumer duties.
Gateway/UI consumption and Docker state integration are implemented; full C4
interactive acceptance remains open in
[single-node closeout](../../docs/docker-single-node-closeout.md).

## Agent Network Policy

`GET /internal/agents/{agent_id}/network-policy?organization_id=org-1`
reads the desired policy and independent Runtime attachment. Organization scope
is mandatory. Unknown, cross-organization and deleting/deleted Agents return
`agent_not_found` before any Egress call. Gateway/Console enforce administrator
authorization on the external management entry; this trusted internal service
does not implement another transport authentication scheme.

```json
{
  "agent_id": "agent-1",
  "policy": {
    "policy_id": "builtin/allow-all", "revision": 1, "resource_version": 3,
    "spec": {"schema_version": 1, "action": "allow_all"},
    "digest": "sha256:..."
  },
  "attachment": {"state": "open", "resource_version": 2}
}
```

The policy spec is read from the assignment's exact immutable revision, not
inferred from its name or replaced with a newer revision. Attachment and policy
are independent observations, not an atomic live-traffic health snapshot.
`open` and `allow_all` describe durable desired state, not proof that a failed
packet cleanup has recovered. Allow-all retains Egress's protected-address
baseline; it is not permission to access deployment control networks.

`PUT /internal/agents/{agent_id}/network-policy`:

```json
{
  "request_id": "request-network-1", "organization_id": "org-1",
  "actor_principal_id": "admin-1", "policy_id": "builtin/deny-all",
  "revision": 1, "expected_resource_version": 3
}
```

Returns the Egress-confirmed assignment with HTTP 200:

```json
{"agent_id":"agent-1","policy_id":"builtin/deny-all","revision":1,"resource_version":4}
```

The caller supplies a positive observed assignment version. `request_id`
correlates the request/log/trace; this operation does not introduce a Controller
idempotency journal. Durable retry identity is Egress's unchanged
`(agent_id, policy_id, revision, expected_resource_version)` tuple. No automatic
retry or silent rebasing is performed. `resource_version_conflict` is 409;
unknown revisions and unallocated networks are 404. Cleanup failure returns
`cleanup_failed` (503). Other unavailable/ambiguous dependency outcomes return
503, malformed dependency responses return 502. A timeout is not proof that
the policy was unchanged, and a successful later GET does not clear that error.

The command never allocates a missing network, changes attachment state,
updates AgentSpec, creates a lifecycle operation or rebuilds Runtime. Disabled
Agents may save a policy for their next lifecycle open. It writes no Controller
table or domain event; Egress owns assignment persistence, and request outcomes
are structured control logs/spans. A successful write returns immediately after
Egress acknowledgement, without a subsequent read that could obscure success.
Controller checks do not lock other services: concurrent lifecycle operations
remain governed by Egress's independent attachment gate and per-Agent barrier.

## Model Configuration Authority

Builtin model defaults belong to Admin Console. Agent Controller has no builtin
model-catalog endpoint and does not infer capabilities or pricing from model IDs.
Create/revision requests must carry complete, valid execution parameters.
Controller persists exactly the confirmed values, including capability overrides,
explicit zero prices and omitted (unknown) pricing. The same rules apply to all
model names; an official name cannot bypass validation.

Stored revisions and Run snapshots remain Controller-owned and independent of
Console releases. Removing a preset does not delete or change organization data.
Provider credential/model lifecycle separation is tracked in
[the implementation plan](../../docs/provider-credentials-and-models.md).

## Provider Connections

`POST /internal/provider-connections` accepts `request_id`, `organization_id`,
`provider_key: "deepseek"`, `display_name`, `base_url`, a typed
`credential: {method: "api_key", api_key: "..."}`, and `models` (an explicit
array, possibly empty). Each initial model supplies `profile_key`,
`display_name` and complete `model` parameters without `base_url`. The entire
connection, one encrypted credential and all initial models commit atomically.
There is no provider-name-based defaulting. OAuth/custom providers are rejected.

`GET /internal/provider-connections` lists organization-scoped connections with
`after_id`/`limit` pagination. `GET /internal/provider-connections/{connection_id}`
requires `organization_id`. Responses include credential method/version and the
implemented `request_protocol`, never the key or encrypted bytes.

`POST /internal/provider-connections/{connection_id}/credentials` takes
`request_id`, `organization_id`, `expected_version`, and the same typed credential.
It advances only the connection credential, using version CAS. A stale edit is
409; an identical committed request replays its original version even after
later rotations. Connection metadata/endpoint changes and disable/delete remain
outside this batch.

See [service-owned Provider management](../../services/agent-controller/docs/provider-management.md).
The Controller Run contract resolves the authorized connection's current bearer
material; the pending ACP consumer update is a separate batch.

## Model Profiles

`POST /internal/model-profiles` creates a current model configuration,
referencing an existing enabled `provider_connection_id` in the request organization.
`POST /internal/model-profiles/{model_profile_id}/revisions` edits the selected
profile's model parameters and display name. Neither command accepts a credential
or model endpoint. Revision input cannot move a model to another connection or
change its API model ID. The same API model ID is allowed on distinct connections.

Model edits require `expected_version`, the integer `revision` read by the caller.
The transaction compares this version with the current row and returns 409
`lifecycle_conflict` for a stale edit, without changing model data. An identical
committed request replays its original response before version comparison.
Model display names, including initial models submitted with a connection, must
be nonblank and at most 200 Unicode code points; values are not silently truncated.

Profiles persist current model parameters and display name, not credentials or
endpoint copies. Execution projections combine the connection with the model.
Management responses expose the connection ID and resolved model configuration,
but no credential reference or credential version.
Stage 2 creates profiles as enabled. Profile disable/delete management is
deferred; historical Agent revisions are never rewritten.

`GET /internal/model-profiles/{model_profile_id}` returns the current head and
requires its owning `organization_id`. Revision commands carry the same
organization authority and fail closed when the opaque ID belongs elsewhere.
There is no model-history resource or `GET /internal/model-profile-revisions/{revision_id}`
endpoint. `revision` is the current update counter; `revision_id` remains an opaque
configuration stamp for existing execution diagnostics, not a historical address.
Updates replace the current row. Model command receipts freeze the original
non-secret response; replay does not return or overwrite a newer configuration.
Agent build and Run snapshots retain consumed parameters without a model-history table.
The endpoint comes from its connection (immutable in this batch).
`GET /internal/model-profiles` requires `organization_id` and uses stable
`after_id` plus bounded `limit` pagination. It never returns encrypted
credential bytes or plaintext secrets.

## Templates

`POST /internal/agent-templates` creates a Template and immutable revision.
`POST /internal/agent-templates/{template_id}/revisions` creates another
revision. Create/revise/read use `model_profile_id`, the stable identity of one
enabled model on an enabled connection, not `model_profile_revision_id`. It contains
Runtime image/resource inputs. Skill references are absent until Skill Registry
exists; the effective list is empty.

`runtime.image_ref` preserves the submitted image reference: a name/tag, image
ID, or digest-pinned reference. Catalog performs syntax and organization/model
checks only. Save, revise, replay and read never call Runtime Controller or
Docker. A syntactically invalid reference returns `400 runtime_image_invalid`;
a valid but currently unavailable image can be saved. No `image_source` is
derived. Revision immutability applies to configuration, not mutable tag content.

Agent creation/rebuild forwards the original reference to Runtime Controller.
`latest` remains `latest` on every new build; runtime revisions or observed image
IDs must not replace this input. A moved tag can produce different containers
from the same Template. Existing containers are not automatically updated, and
an idempotent replay is not a new build. Current Docker deployments use locally
installed images; automatic registry pulling is a separate deployment policy.

Template get/revise/list are organization scoped. The ordinary get and list
return current heads. `GET
/internal/agent-templates/{template_id}/revisions/{revision}` returns one
immutable historical configuration while retaining the current Template name
as a display label. Get requires `organization_id`; revise carries it in the request. List requires `organization_id`
and uses the same `after_id`/`limit` pagination. Agent creation resolves the
explicit `(template_id, template_revision)` pair rather than silently using a
newer head.

## Agents

`POST /internal/agents` freezes a Template revision and starts a durable create
operation. Before persisting a new intent, Agent Controller resolves
`(owner_user_id, organization_id)` through Identity Service and requires an
active organization membership. A system administrator without an active
membership in that organization is not a valid Agent owner. Persisting the
create intent freezes that authorization decision. Every exact replay of that
intent, whether running, failed, or completed, continues or returns the same
durable operation without reinterpreting historical ownership under current
Identity state.

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
returns the current projection, active immutable revision identifiers, and an
optional safe `configuration` lineage for the executable AgentSpec. That
detail-only lineage identifies the exact Template and Model Profile revisions,
their current display labels, frozen model limits/execution policy, and Runtime
input. It never returns credential references, credential versions, Runtime
execution identity, or the internal MCP endpoint. A provisioning Agent has no
`configuration` until its first ExecutionRevision is published; list items stay
lightweight and omit it.

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
failure. A bounded lifecycle request returns retryable `lifecycle_timeout`
with HTTP 504; replay uses the original request ID. SQL, secrets, Provider
responses, and platform stderr are never returned.

The machine-readable route catalog is in
[`control-contract.json`](control-contract.json), and message definitions are
in [`control-api.schema.json`](control-api.schema.json). Run admission remains
a separate consumer-specific contract in [`run-contract.json`](run-contract.json).
