# Provider Management

Controller owns organization connections, current encrypted credentials, and model
parameters. The builtin model catalogue belongs to Admin Console. Controller only
registers supported protocols and authentication methods; it never supplies model
names, context limits, prices, or defaults.

## Management Contract

- `POST /internal/provider-connections`: create a DeepSeek connection, one API key,
  and the explicitly submitted initial models in a single transaction.
- `GET /internal/provider-connections?organization_id=...`: paginated connections.
- `GET /internal/provider-connections/{id}?organization_id=...`: connection metadata.
- `POST /internal/provider-connections/{id}/credentials`: replace the credential,
  using `expected_version` to reject stale concurrent edits.
- `POST /internal/model-profiles`: add a model to an existing connection.
- `POST /internal/model-profiles/{id}/revisions`: edit model parameters without a key.

Model updates require the caller's `expected_version` (the read response's
`revision`). Only the transaction's CAS decides whether it is stale. A conflicting
edit returns the existing 409 `lifecycle_conflict` without a write; replay of a committed command
still returns its original response. All model creation paths and updates validate
nonblank display names of at most 200 Unicode code points.

Connections currently support `provider_key=deepseek`, `credential.method=api_key`,
and the OpenAI Chat Completions request protocol. Other providers and OAuth are
rejected, not silently interpreted as API keys. A connection endpoint is immutable
in this batch; moving to another endpoint means creating another connection.

Model commands reference `provider_connection_id`, never authentication material.
The model's API ID is immutable; another API ID is a new model. It is unique inside
its connection, not globally. Parameters have no endpoint: the connection owns it.
Credentials are write-only, sealed with organization/connection/version as AEAD
context. Rotation writes no model, template, Agent, or Runtime revision.

Request IDs and fingerprints provide command replay; a reused ID with different
input is a conflict. Initial models and credentials either all commit or all roll
back. Reads and mutations are organization-scoped. RPC transport instrumentation
and automatic PostgreSQL driver spans follow the service's
[telemetry policy](observability.md); no per-method repository wrapper is needed.

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
The retired model-history GET endpoint returns 404. Template history is unchanged.
Agent configuration reads its own build-time snapshot; new Runs freeze current
model parameters independently. Model edits that were never consumed do not have
a history browsing or rollback API.

Templates reference stable `model_profile_id`. Agent build snapshots retain that
identity plus the build-time revision/parameters for audit, without credentials.
Both default and explicitly selected Session models resolve the enabled current
revision at admission. Model edits affect new Runs, never an admitted snapshot.
Model and connection availability are checked in the admission transaction.

Run contract revision 13 returns `execution_spec.provider` with connection ID,
provider key, credential method and request protocol. It does not pin a credential
version. `resolve-credential` accepts `admission_id` and `provider_connection_id`,
requires an active, unexpired admission and its live owner/access binding, and
reads that authorized connection's current encrypted credential. Rotation is
visible on the next resolution, including within an existing Run. The response
reports the actual credential version and typed provider binding. No secret is
copied into a model, build spec, or admitted snapshot.

Console's management and template identity consumers are updated. ACP's strict
DTO/authentication consumer remains a separate batch before deployment.
Do not compare the resolved credential version to an
obsolete version pinned by the old ACP consumer. Provider resolution is local
database access, not an external token refresh.

This MVP schema change is accepted against a fresh test database, not by resetting
the running human acceptance instance. Builtin catalogue updates never rewrite
already persisted organization configuration.

Control contract revision 21 removes model-history reads. The existing model
mutation route retains its `/revisions` name, but updates the current row and
counter; it does not create a separately addressable historical resource.
Model edits and credential rotations are ordered under the command receipt lock,
with version CAS in the transaction. An outer read is not a conflict authority:
the same command may have committed between the first receipt check and that read.

Deleting historical secret rows is not a telemetry retention guarantee. With
development RPC payload capture enabled, credential request/response DTOs can
still appear in traces; see the telemetry policy above.
