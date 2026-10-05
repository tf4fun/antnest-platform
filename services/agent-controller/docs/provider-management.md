# Provider Management

This document describes how Agent Controller stores Provider connections,
encrypted credentials and model parameters, how availability and references are
enforced, and where the execution boundary lies.

Model discovery runs inside Controller, next to its encrypted credentials.
`POST /internal/provider-connections/{connection_id}/discover-models` takes only
`organization_id`; `POST /internal/provider-discovery/draft` accepts Organization,
Provider, endpoint and an ephemeral API-key credential. Both return only
`{models:[...]}` with `Cache-Control: no-store`. The former `/access` credential
export route is removed and returns 404 after workload admission. No discovery
reply or schema includes a credential.

The dedicated `ProviderAccessReader` reads current credential identity and
ciphertext in one database snapshot. Saved discovery checks scope, availability
and destination before opening the key, then sends it only to the checked Provider.
It performs no writes or credential caching; rotation is visible on the next
discovery. Draft discovery neither reads nor stores a credential. Normal
connection reads select metadata only. Model response normalization is the former
Console discovery adapter, including optional context/pricing metadata; builtin
candidate defaults and user selection remain Console responsibilities.

Creation and each discovery apply the shared
[Provider destination policy](../../../contracts/platform/provider-destination-policy.md).
Defaults deny loopback, private, CGNAT, link-local/metadata and reserved addresses.
All A/AAAA answers are checked; mixed results fail. Actual sockets dial verified
literal IPs and retain original TLS hostname/SNI and HTTP Host. Provider transport
has no workload credentials, environment proxy or redirects. Calls retain the
configured dependency deadline and discovery's 8 MiB cap. Creation resolves only:
it sends no HTTP request or credential, and committed command replay is independent
of later DNS availability. Unconfigured policy fails closed.

Only the operator's exact `ANTNEST_PROVIDER_ALLOW_PRIVATE_ENDPOINTS=true` permits
local/private model servers; absent or exact false means deny. Present empty,
padded or other values fail startup. This unsafe option also permits metadata
addresses in private ranges and should not be enabled for multi-tenant deployment.
Reserved/scoped/multicast addresses remain denied. Browser and Template input
cannot enable the option. Policy denial is `422 provider_endpoint_forbidden`;
DNS failure is retryable `503 provider_endpoint_unavailable`; bounded transport,
status or body failure is retryable `502 provider_discovery_failed`. Responses,
logs and spans never include the key, complete URL or upstream error body.

This is the Controller producer batch for #28. Console's thin-proxy adoption and
ACP's independent actual-model transport guard remain separate owning-service
batches; the browser flow and final cross-service E2E are pending in the
[rollout ledger](../../../contracts/platform/service-authentication-rollout.json).
See the planned [discovery flow](../../../docs/model-discovery.md).

Provider creation, credential rotation and both discovery routes are metadata-only HTTP boundaries,
including validation and dependency failures. Even when development RPC content
capture is enabled, their request and response DTOs are not serialized to spans.
The common HTTP boundary still records method, route, status and typed errors.
Other non-secret catalog requests retain normal RPC diagnostics. This is a
route contract, not a recursive field-redaction scheme in business handlers.

Controller owns organization connections, current encrypted credentials, and model
parameters. The builtin model catalogue belongs to Admin Console. Controller only
registers supported protocols and authentication methods; it never supplies model
names, context limits, prices, or defaults.

## Management Contract

- `POST /internal/provider-connections/{id}/discover-models`: saved model discovery.
- `POST /internal/provider-discovery/draft`: ephemeral draft model discovery.
- `POST /internal/provider-connections`: create a DeepSeek or OpenRouter connection, one API key,
  and the explicitly submitted initial models in a single transaction.
- `GET /internal/provider-connections?organization_id=...`: paginated connections.
- `GET /internal/provider-connections/{id}?organization_id=...`: connection metadata.
- `POST /internal/provider-connections/{id}/credentials`: replace the credential,
  using `expected_version` to reject stale concurrent edits.
- `POST /internal/model-profiles`: add a model to an existing connection.
- `POST /internal/model-profiles/{id}/revisions`: edit model parameters without a key.
- `PUT /internal/provider-connections/{id}/availability`: enable or disable a connection.
- `PUT /internal/model-profiles/{id}/availability`: enable or disable a model.
- `PUT /internal/agent-templates/{id}/availability`: enable or disable a template.

Model updates require the caller's `expected_version` (the read response's
`revision`). Only the transaction's CAS decides whether it is stale. A conflicting
edit returns the existing 409 `lifecycle_conflict` without a write; replay of a committed command
still returns its original response. All model creation paths and updates validate
nonblank display names of at most 200 Unicode code points.

Connections currently support `provider_key=deepseek|openrouter`, `credential.method=api_key`,
and the OpenAI Chat Completions request protocol. Other providers and OAuth are
rejected, not silently interpreted as API keys. A connection endpoint is
immutable; moving to another endpoint means creating another connection.

Model commands reference `provider_connection_id`, never authentication material.
The model's API ID is immutable; another API ID is a new model. It is unique inside
its connection, not globally. Parameters have no endpoint: the connection owns it.
Credentials are write-only to browser clients, sealed with organization/connection/version as AEAD
context. Rotation writes no model, template, Agent, or Runtime revision.

Request IDs and fingerprints provide command replay; a reused ID with different
input is a conflict. Initial models and credentials either all commit or all roll
back. Reads and mutations are organization-scoped. RPC transport instrumentation
and automatic PostgreSQL driver spans follow the service's
[telemetry policy](observability.md); no per-method repository wrapper is needed.

## Availability And References

The control contract defines three availability commands. They require
`request_id`, `organization_id`, `expected_enabled` and `enabled`. Both booleans
must be explicit. A successful response contains `resource_id`, `enabled` and
`updated_at`. A state conflict returns 409; it is independent of credential,
model-parameter and template-revision counters. Metadata edits and credential
rotation preserve the stored availability, including in the returned result.

Provider disable is immediate operational intent and is permitted with references.
It preserves Templates, Agents and Model enabled flags; ACP revokes that client's
execution and resolves subsequent Runs using the configured fallback order.
No Agent lifecycle operation or Runtime rebuild is initiated by this toggle.

Disabling a Model still returns 409 `resource_in_use` while referenced by any
default or fallback candidate in:

- an enabled template's current head;
- a non-deleted Agent's current configuration, even if execution is unavailable;
- a running lifecycle operation's registered target configuration.

The response lists up to 100 ordered references with resource kind/ID and, for
active operations, Agent and operation IDs. `references_truncated=true` signals
additional references. Historical template revisions, superseded Agent specs,
completed abandoned targets and deleted Agents are not permanent blockers.
Reference registration and retirement use the same organization transaction lock.
Dependency checks occur under that lock, not just at the application's earlier read.

A disabled template retains its history and does not stop derived Agents. Already
existing history GET requests remain available to the owning organization; read
methods do not decide whether a template can be used for new derivation. Already
registered targets can finish, but new create/rebuild targets cannot use a disabled
template, including its historical revisions. Enabling an existing Agent reuses
its configuration and checks Model validity without requiring the Provider or
source template to be enabled. Editing a disabled template never enables it;
explicit enablement checks its current Model again. A temporarily disabled
Provider is a valid persisted dependency, not a missing reference.

Failed rebuild/disable clears execution and Runtime bindings, not the committed
current spec. Selecting last-successful or first-version history after such a
failure would accidentally restore a retired model; those records remain audit
history, not a replacement for current configuration.

An identical request replays its recorded response, even after a later opposite
toggle. No-op commands keep the original timestamp and execution revision.
Rejected commands leave no receipt and may be retried after references are removed.
Provider disable preserves each model's own enabled flag. Only effective Provider
or Model changes advance execution configuration; template-only toggles do not.
There is no physical deletion, new retirement table, automatic template rewriting
or Provider lifecycle workflow. Console provides the availability controls, and
Gateway and ACP consume the resulting configuration. Provider fallback behavior
is described in [Provider failover](../../../docs/provider-failover.md).

## Persistence And Execution Boundary

All tables are in this service's `agent_controller` schema:

- `provider_connections`: stable identity, organization, provider, endpoint and
  the current encrypted credential, replaced atomically with its version.
- `model_profiles`: stable model identity, connection reference, current parameters
  and update version. No credentials or endpoint copies.
- `catalog_requests`: non-secret replay receipts for committed commands. Model
  replies carry a response snapshot so replay never reads newer model parameters.

There is no historical credential or model revision table. A model configuration
ID is an opaque diagnostic stamp in existing snapshots, not a queryable historical
resource. The update counter provides optimistic concurrency, not version storage.
There is no model-history read route. Template revision history remains readable.
Agent configuration reads its own build-time snapshot; new Runs freeze current
model parameters independently. Model edits that were never consumed do not have
a history browsing or rollback API.

Templates reference stable `model_profile_id` and ordered
`fallback_model_profile_ids` (at most 31 additional candidates). Every candidate
must belong to the same organization and a different Provider connection. Their
order survives persistence and is copied into the Agent's configuration; the
Controller does not choose a fallback for an individual Session or Run.
Agent build snapshots retain that
identity plus the build-time revision/parameters for audit, without credentials.
The [execution publication boundary](execution-publication.md) sends current
organization configuration to ACP. ACP owns Session model selection, local Run
admission and logical Provider clients; credential rotation is not a per-Run
Controller call. No secret is copied into an Agent build spec or Run audit snapshot.

`accepting_runs` publishes lifecycle readiness, not default-model availability.
ACP owns effective model selection and the no-available-model error. This permits
session configuration/history access even when every Provider is disabled.
See [the cross-service delivery contract](../../../docs/provider-failover.md).

Controller publication and catalog components are wired into production
composition. Controller has no execution RPCs, Run application, Port,
repository or admission storage.

The connection/credential/model schema has no in-place upgrade from an earlier
schema; see [Operations](operations.md#configuration). Builtin catalogue updates
never rewrite already persisted organization configuration.

The model mutation route keeps its `/revisions` name, but updates the current row and
counter; it does not create a separately addressable historical resource.
Model edits and credential rotations are ordered under the command receipt lock,
with version CAS in the transaction. An outer read is not a conflict authority:
the same command may have committed between the first receipt check and that read.

Deleting secret rows does not remove data that was already exported to
telemetry. Provider creation, credential rotation and both discovery routes
are metadata-only, so their credential DTOs are not captured even when
development RPC payload capture is enabled. Other catalog routes follow the
normal capture policy; see the telemetry policy above.
