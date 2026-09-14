# Agent Controller Lifecycle And Management Contract

> Status: Stage 2B implementation contract<br>
> Revision: 28<br>
> Transport: trusted internal JSON over HTTP<br>
> Owner: Agent Controller

This contract manages ModelProfiles, Templates, Agents, lifecycle operations,
global Agent status projection, and Agent events. It is internal RPC, not a
public OpenAPI. Edge Gateway decides which management operations are
externally available and performs transport authentication.

## Execution Boundary

`POST /rpc/agent-controller/set-agent-authorization` updates Agent defaults with
owner authorization and a revision CAS. It does not modify Session overrides.
`POST /rpc/agent-controller/list-workspace-agents` lists the authenticated
principal's management projection. Both methods belong to this management
contract, not a Run admission contract.

Controller no longer exposes `resolve-agent-access`, `get-session-configuration`,
`acquire-run`, `resolve-credential` or `finish-run`. ACP consumes the current
configuration publisher and owns protocol authorization, execution and audit.
These removed routes return 404; there is no compatibility switch or proxy.

Workspace items now contain only agent_id/name. The Controller state get/watch
endpoints are removed. Gateway and Console migration remains B3/B4; do not deploy
this intermediate producer independently.

Agent lifecycle is `not_created | created | deleted`. A created Agent has
confirmed `activation_state=enabled|disabled`; its `runtime_state` independently
reports `waiting|available|unhealthy|exited|absent|unknown`, with optional reason,
detail and observation time. Operation remains responsible for progress and
terminal errors. Disable intent blocks new Runs before confirmed stopping;
failed disablement is not a disabled Agent. See
[state semantics](../../services/agent-controller/docs/agent-state.md).

Lifecycle and catalog mutations carry a stable `request_id`. Reusing a request ID with a
different canonical request returns `request_id_conflict`. Cross-service IDs
are opaque strings and have no database foreign keys.

Catalog request IDs are unique across every Provider connection, credential, ModelProfile and Template command,
not merely within one route. Concurrent retries serialize on that identity. A
revision command compares the head revision it read with the head locked by the
repository; a concurrent successful revision returns `lifecycle_conflict` and
the caller submits a new intent instead of silently rebasing it.

## Execution Configuration Synchronization

`GET /internal/execution-synchronization?organization_id=org-1` reads the
Controller's current configuration revision and persisted ACP acknowledgement.
Only one nonempty `organization_id` query parameter is accepted. As with other
management reads, the trusted caller supplies its verified organization scope;
Gateway/Console enforce external administrator access. This method does not
perform another identity lookup or return configuration/credential payloads.

```json
{
  "organization_id": "org-1",
  "synchronization": {
    "revision": 8,
    "applied_revision": 7,
    "updated_at": "2026-09-14T12:00:00Z",
    "applied_at": "2026-09-14T11:59:00Z"
  }
}
```

HTTP 200 with `synchronization: null` means no configuration change has yet
created a synchronization record for this organization. It is not an empty or
already-applied configuration, nor proof the organization exists in Identity.
With a record, `revision` is positive, `0 <= applied_revision <= revision`, and
`applied_at` is null exactly when no revision has been acknowledged. A lower
applied revision means the latest configuration is not yet confirmed. Matching
revisions report a past acknowledgement, not ACP liveness, Agent availability,
an idle Run, or proof that volatile credentials survived a process restart.

This is one read of `agent_controller.execution_configuration_sync`; it does not
advance revisions, trigger publication, enter a workflow, or call ACP/Runtime/
Identity. It uses the common HTTP/RPC and database instrumentation and returns
`Cache-Control: no-store`. Invalid queries return 400; timeout/cancellation
returns 503, other storage errors return the existing generic 500 response.
Failures never become a successful null/zero/synchronized view.

## Workspace Metadata

`POST /rpc/agent-controller/list-workspace-agents` returns agent_id/name items with
a nullable next_cursor. It is scoped by organization, principal, active binding
and owner revocation watermark. Deleted desired state is excluded; ordinary
disablement and Runtime unavailability do not remove authorized metadata.
It contains no execution availability, active Session or opaque access subject.

Controller's former state get/watch endpoints return 404. ACP owns execution
state and subscriptions; Controller's management event journal remains independent.
See the [metadata boundary](../../services/agent-controller/docs/workspace-state.md).
Consumers migrate in B3/B4U before full-stack deployment.

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

Current management records and immutable build revisions remain Controller-owned
and independent of Console releases. ACP owns Run snapshots and execution audit. Removing a preset does not delete or change organization data.
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
later rotations. Connection metadata/endpoint changes and physical deletion
remain outside this batch. Availability has the independent operation below.

See [service-owned Provider management](../../services/agent-controller/docs/provider-management.md).
The configuration publisher sends the connection's current credential to ACP.
There is no per-Run credential resolver. ACP keeps current call credentials in
its logical clients; normal management responses never contain them.

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
Profiles are created enabled. Availability changes never rewrite historical
Agent revisions; physical deletion remains deferred.

## Catalog Availability

`PUT /internal/provider-connections/{connection_id}/availability`,
`PUT /internal/model-profiles/{model_profile_id}/availability`, and
`PUT /internal/agent-templates/{template_id}/availability` accept
`request_id`, `organization_id`, `expected_enabled`, and `enabled` (both explicit
booleans). They return 200 with `resource_id`, `enabled`, and `updated_at`.
The expected flag detects conflicting state edits; it is not a credential or
model version. Credentials, model parameters and Template revisions are unchanged.
An identical committed request replays its saved response, even after a later
opposite transition. A no-op records its receipt without updating timestamps or
execution revision. An uncommitted conflict records no receipt.

Disabling a Provider or Model with live references returns 409 `resource_in_use`
and `references`: ordered `{kind, resource_id, agent_id?, operation_id?}` entries
for enabled Template heads, current non-deleted Agents and running lifecycle
targets. At most 100 references are returned, with `references_truncated=true`
when more exist. Historical revisions and idle Session model choices are not
permanent blockers. All reference checks and writes share the organization
transaction lock. Agent create/rebuild revalidates its recorded Template and
Model before registering a new target; prior application reads are insufficient.

Disabling a Template only prevents new derivations. Existing Agents and already
registered targets are unchanged. Revising a disabled Template does not re-enable
it. Enabling a Template requires its current Model and Provider to be enabled in
the same organization; enabling a Model requires its Provider. A disabled
Provider does not rewrite each Model's own flag. Template changes do not create
an execution revision unless an actual Agent execution input changes.

These are Controller-local management operations, not ACP Session controls or
Provider workflows. Gateway/Console consumption is the later B3/B4 batch.

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

Create, rebuild and enable complete after Runtime resource creation and network
attachment opening, independently of MCP readiness. A completed operation may
have a `created/enabled` Agent with `runtime_state=unknown` and no executable binding. `agent_created`,
`agent_rebuilt` and `agent_enabled` record that completion; independent healthy
observation publishes an ExecutionRevision and emits `agent_ready`. Only an
enabled, available Agent with a complete execution binding admits Runs. A
configured Agent that has never become ready still supports management actions.

Delete persists desired state `deleted`, retaining confirmed lifecycle, before
draining Run occupancy. It then fences and resets Egress, removes Runtime
compute and workspace behind the frozen Runtime revision, releases the network
attachment into quarantine, deactivates Agent access, and publishes `deleted`.
An absent Runtime or network is an idempotent success only when the owning
service returns its stable not-found code. Ambiguous effects keep the same
operation non-terminal. Immutable revisions, events, terminal operations, and
management snapshots remain available for retention and audit. ACP retains its own
Session/Run history; Controller does not preserve an execution copy.

`GET /internal/agents` is the global current-state projection. Deleted Agents
are excluded unless `include_deleted=true`. `GET /internal/agents/{agent_id}`
returns the current projection, active immutable revision identifiers, and an
optional safe `configuration` lineage for the configured AgentSpec. That
detail-only lineage identifies the exact Template and Model Profile revisions,
their current display labels, frozen model limits/execution policy, and Runtime
input. It never returns credential references, credential versions, Runtime
execution identity, or the internal MCP endpoint. A created but never-ready Agent exposes
`configuration` once its resource-creation operation commits the configured
AgentSpec, even before its first healthy execution; list items stay lightweight
and omit it.

The list route accepts optional `organization_id`, `owner_user_id`, and
`lifecycle_state`, `activation_state`, and `runtime_state` filters. `owner_user_id` is the immutable Identity Service
user identity frozen at Agent creation; Agent Controller neither copies user
profiles nor joins the Identity Service database. Results are ordered by the
immutable `(created_at, agent_id)` pair. `cursor` is an opaque, versioned
continuation token for that pair, and `limit` is bounded to 1–200 (default 100).
Clients must continue with the same filter set; changing filters starts a new
query. Present-but-empty, duplicate, malformed, and unknown query parameters
are rejected rather than interpreted as a broader query.
An explicit `lifecycle_state=deleted` filter does not override deletion
visibility: callers must also set `include_deleted=true`. Explicit get remains
available for deleted Agents so audit and administrator workflows can resolve a
known identity.

Every Agent response includes `aggregate_sequence`, its concurrency revision.
Domain transitions and observation fences advance it. Events carry the revision
they published, but not every increment creates an event. It is neither an event
count nor a journal cursor; ordered change consumption uses the journal's global
sequence, not this field or query pagination.

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

`execution_configuration_capacity_exceeded` uses HTTP 409 with `retryable=false`.
It means the proposed configuration, including capacity reserved for closure
and already registered Runtime targets, cannot be published within the
deployment budget. The resource mutation, command receipt and configuration
revision are rolled back together. Reduce the proposed configuration or review
the shared deployment limit; blind retries cannot resolve the rejection.
The guard and production publisher are connected in B2. Consumer migration and
cross-service deployment remain pending; local contracts are not E2E evidence.

The machine-readable route catalog is in
[`control-contract.json`](control-contract.json), and message definitions are
in [`control-api.schema.json`](control-api.schema.json). It includes the retained
Agent-default and workspace-list RPCs; there is no Controller Run admission API.
