# Provider Credentials and Models

This document describes how Antnest separates Provider connections, credentials
and models. It covers ownership of the builtin catalogue, the persistence model,
the authentication extension contract, and how execution consumes the stored
configuration.

## 1. Scope

The supported flow covers builtin Providers. An administrator creates a
connection, configures and rotates its API key independently, starts from a
prefilled model list, adds and edits models, selects models in templates, and
runs Agents. Admin Console maintains the builtin catalogue. Agent Controller
persists the connections, credentials and model configuration that the
organization confirms. Administrators do not have to fill in every field by
hand, and saving never forces the presets back onto stored data.

The builtin Providers are DeepSeek and OpenRouter. Each connection uses one API
key and the OpenAI Chat Completions request protocol. Templates can list ordered
fallback models; see [Provider failover](provider-failover.md). Console can
discover remote models for a connection; see [Model discovery](model-discovery.md).

Custom Providers, other builtin Providers and Codex subscription authentication
are extensions. The contract defines how they fit and how unsupported
capabilities are rejected. Console shows no Codex login button. No OAuth or
discovery method returns a fake success. There is no separate credential
service and no background refresh scheduler. Unsupported Providers are rejected
at the API, not only hidden in the UI. A synthetic model service used in
protocol tests does not count as a supported product Provider.

## 2. Motivation

A design that stores credentials inside model records has several problems:

- Creating or editing a model requires resubmitting the key and creates a new
  credential record each time.
- A single model revision carries both model data and `credential_ref` /
  `credential_version`.
- The AgentSpec freezes these credential fields, and Run credential resolution
  then requires that exact version. A key rotation breaks existing Agents.
- Context window, output limit and multimodal fields for known models are
  rewritten from a hard-coded canonical spec, so administrator edits are lost.
- The management API has a fixed `api_key` field, and execution understands only
  a bearer string. There is no description of the authentication method.

Fixing this is not a form change in Console. Persistence, domain references,
execution configuration, credential access, the ACP client contract and the UI
all depend on the separation.

## 3. Design Choices

- Authentication is independent of the model. The credential owner handles
  concurrent refresh.
- Builtin data is initial data, not locked configuration. Administrators can
  override builtin models and add models under an existing Provider.
- Subscription authentication needs its own Provider adapter and request
  protocol. A subscription token is not an API key and is not sent as one to the
  Chat Completions endpoint.
- Credential resolution checks expiry first. It refreshes against the external
  service only when needed, under a lock, and re-checks after acquiring the lock.
  Antnest does not use multi-source credential pools or automatic import
  fallbacks.
- Model discovery is separate from complete capability data. A remote model list
  does not provide every parameter. Discovered IDs that match the builtin
  catalogue are enriched from it; unknown IDs are treated as custom models.

Antnest does not adopt local file locks, localhost login callbacks, automatic
scanning of host `auth.json` files, multi-account pools or unbounded refresh
retries. In a platform service, such behavior must respect organization
isolation and the HTTP entry boundary.

## 4. Two-Layer Business Model

### 4.1 Provider Connection and Credential

An organization creates a Provider connection. A connection has a stable ID,
`organization_id`, `provider_key`, display name, API endpoint and authentication
method. It holds one independently maintained credential that all of its models
share. An organization can create several connections for the same Provider, so
`provider_key` is not a globally unique account. The endpoint of a connection is
immutable; a different endpoint requires a new connection.

`builtin/custom` names the source of the initial configuration. It does not name
the authentication type or the request protocol. Whether API keys, OAuth or
other authentication methods are supported depends on the capabilities declared
in the Provider description. Today only `credential.method=api_key` is accepted;
other methods are rejected, not interpreted as API keys.

### 4.2 Provider Model

A model belongs to a Provider connection in the organization. It has a stable ID,
API model ID, display name, context and output limits, multimodal capability,
optional pricing and an enabled state. The unique constraint is
`(provider_connection_id, api_model_id)`. A model record stores no key, refresh token
or credential version. `base_url` comes from the connection, and only the
execution snapshot combines the endpoint with the model parameters. The API model
ID is part of the model identity. Changing it creates a new model instead of
silently replacing an existing reference.

A template references a selected model by its stable ID. The model record already
carries its connection, so persistence does not copy a separate provider/model
pair that could diverge. The UI can group models by Provider. The backend still
checks that the model and its connection belong to the requesting organization
and are enabled.

### 4.3 Presets and Edits

1. Console maintains the builtin catalogue and prefills models. When a connection
   is created, Console submits the model data the administrator confirmed.
   Controller validates it and persists it together with the connection and
   credential in one transaction. Controller does not copy or maintain a second
   builtin catalogue.
2. A custom connection, when supported, starts with an empty model list.
3. After saving, the organization's model records are authoritative.
   Administrators can add, edit or disable models under a builtin connection.
4. Software upgrades do not rewrite saved data, do not delete models, and do not
   re-enable models an administrator disabled.
5. Model discovery returns a candidate list. The administrator explicitly selects
   which new candidates to import. Discovery never silently overwrites existing
   models.
6. Unknown pricing stays unknown and is never treated as free. Unknown
   capabilities are never reported as known. Creating an executable model
   requires all mandatory fields to pass validation. A discovery failure does not
   clear the existing list, and execution never depends on live discovery.

Models are prefilled and then persisted. There is no runtime engine that layers
configuration overrides. An edit updates only the current model parameters, the
configuration stamp and the concurrency version. It keeps no separate model
history and never changes the credential. Agent builds and new Runs each keep a
snapshot of the parameters they actually use, which provides execution
traceability.

## 5. Authentication Extension Contract

### 5.1 Three Independent Dimensions

| Dimension | Supported today | Future extension examples |
| --- | --- | --- |
| Provider definition | `deepseek`, `openrouter` | Other builtin Providers, custom Providers |
| Credential method | `api_key` | `oauth` |
| Model request protocol adapter | `openai_chat_completions` | Provider-specific Responses or other protocols |

The server validates which Provider, credential method and request protocol
combinations are executable. Clients do not declare their own capabilities. This
support set is separate from the Console model catalog, which only supplies
editable initial parameters. Agent Controller registers `deepseek` and
`openrouter`, both with `api_key` and `openai_chat_completions`. It rejects an
unknown Provider, credential method or request protocol explicitly and never
falls back to DeepSeek. Supporting a new Provider requires credential resolution,
a request adapter and matching tests. Adding a model catalog entry alone does not
make a Provider supported.

### 5.2 Minimal Interface Boundaries

The table below is a responsibility contract. It does not require empty
implementations for OAuth, which is not implemented.

| Interface | Input and output | Owner |
| --- | --- | --- |
| BuiltinProviderCatalog | `provider_key`, default endpoint, preset models and the source of their metadata. Used only for prefill; it is not the execution authority. | Admin Console |
| ProviderSupport | `provider_key`, implemented credential method, request adapter identifier. Rejects unimplemented combinations. Contains no model names, prices or context-window catalog. | Agent Controller |
| CredentialResolver | Organization and connection context plus the current sealed credential record -> the authentication material a call needs and the credential revision. Future methods may also produce validity periods and updates. | Agent Controller |
| ModelDiscovery | An unsaved connection draft, or a saved connection plus the credential that Controller resolves for it -> a list of model candidates. Partial metadata is allowed. | Admin Console, using Controller credential resolution for saved connections |
| ModelTransport | Resolved model parameters and authentication material -> model requests and streaming events | Agent ACP Service |

These registries are internal extension points of each service. They do not
support dynamic plugin upload, arbitrary authentication callback URLs or
arbitrary reflective loading. A Provider adapter consumes only a valid
organization connection. A credential is never shared across connections or
organizations because two models have the same name.

### 5.3 Management Input and Storage

A create request is a connection command, not a "model + api_key" pair. For
example:

```json
{
  "provider_key": "deepseek",
  "display_name": "DeepSeek",
  "base_url": "https://api.deepseek.com",
  "credential": {
    "method": "api_key",
    "api_key": "<write-only>"
  }
}
```

`api_key` is a field of the credential method. It is not a top-level field that
every Provider management command must carry. Model edit commands accept no
credential fields. Credential rotation commands accept no model list. The example
shows only connection and credential fields. On create, Console attaches the
initial model list that the administrator confirmed. Controller never fills in
model parameters from `provider_key` on its own.

A future OAuth credential holds an access token, a refresh token, an expiry time
and any required account binding. The credential adapter produces it and stores
it encrypted as a whole. The frontend never asks the user to paste a token as if
it were an API key. The management API returns configuration status and
implemented credential methods, never tokens. An OAuth login transaction will use
Begin/Get/Complete steps, as the grant type requires, and binds the organization,
connection, initiator, state/PKCE and expiry time. Public routes are defined
when a Provider that needs them is implemented. The platform does not expose
endpoints without an implementation.

The credential that Controller publishes to Agent ACP Service is typed. Each
enabled Provider in the execution snapshot carries `credential_revision` and a
`credential` object with `method` and `secret`; today `method` is always
`api_key`. The request authentication material describes what a call needs, not
how the credential was obtained. A future OAuth method extends this typed
contract so it can carry a short-lived access token and required Provider
account attributes. The refresh token never reaches ACP. The database does not
gain a set of nullable columns for each Provider. Extended credential payloads
use an encrypted structure with typed validation, not unconstrained JSON as the
domain model.

### 5.4 Rotation and Validity

- Credentials are independent of model parameters and AgentSpec. Rotation does
  not change Templates, Agent lifecycle or Runtime generation.
- Execution binds a Provider connection and a specific model. It does not treat
  a long-lived fixed token as configuration.
- Authentication material is resolved before model calls. Reading and reusing
  material that is still valid does not trigger an external refresh on every
  call.
- Future OAuth refresh is serialized per connection. Inside the lock, the
  refresher re-reads the version and expiry, then saves the new access and
  refresh tokens atomically. A concurrent refresh never overwrites a newer
  refresh token, and no cross-service transaction is held for a long time.
- When refresh fails, the result distinguishes "temporarily unavailable" from
  "re-authorization required". The platform does not retry forever and never
  turns a failure into an empty key.
- Rotating a local key cannot recall an HTTP request that is already in flight.
  Later requests use the rotated credential. Audit records may store the
  credential revision that was used, never the secret. Model prices, capability
  snapshots and credential rotation are managed separately.

## 6. Data, Execution and Service Boundaries

Agent Controller's own PostgreSQL database stores organization configuration,
credentials and models. Business data is limited to `provider_connections` (the
connection and its current encrypted credential) and `model_profiles` (the model
and its current parameters). There is no separate credential history table or
model revision table. Credential rotation atomically replaces the current
ciphertext and version. A model edit updates parameters and the concurrency
control version in place. Audit snapshots contain no secrets. A command receipt
stores the non-secret snapshot needed for its response. A retry after a later
update still returns the original response; the receipt is never rebuilt from
current values or from historical secrets. Global presets live in Console source
code and need no database table. A model does not need its own credential
record. A Console upgrade affects only later prefill and never writes back to
organization configuration.

Console serves presets through its own catalog interface and reads and writes
persisted configuration through the Controller contract. It never touches
Controller database tables. Console fills in default metadata; Controller does
not silently change values based on model names. For model discovery on a saved
connection, Console calls `GET /internal/provider-connections/{connection_id}/access`
and Controller returns the current credential for that enabled connection.

Agent ACP Service does not read the Controller database. Controller decrypts the
current credential of each enabled connection and publishes it as part of the
organization execution snapshot through
`POST /rpc/agent-acp/apply-execution-snapshot`. ACP persists only the non-secret
part of the snapshot and keeps secrets in memory. There is no per-Run credential
lookup. ACP never refreshes OAuth credentials that Controller owns. Platform
OIDC login belongs to Identity Service. Provider subscription authorization
belongs to Provider management, and the two are separate. Runtime Controller,
Runtime and Egress take no part in Provider credential or model management.

At execution time, the Run uses the current parameters of the selected model
from the applied snapshot and freezes the parameters it uses. A Template keeps
selecting the same model identity, so a model list update never switches it to
a different model. A running Run does not change parameters when the model is
edited. New Runs read the updated parameters. Price and capability snapshots of
recorded Runs are never rewritten.

A Template stores `model_profile_id`. An Agent stores the same stable model ID.
The model revision and parameters captured at build time are kept only as a
build audit snapshot, not as the configuration authority for later Runs. When
Controller builds an Agent, it reads the current model revision. Session defaults and candidate capabilities
also come from the currently enabled models. Model revisions, AgentSpec and Run
configuration digests contain no credential version. A model uses only the
credential of its own connection in the snapshot. Secrets are never stored in
Runs. Model updates and credential rotation do not change
Runtime or Agent lifecycle. Disabling or removing a Provider connection revokes
existing clients for that connection and aborts their requests. A contract
change here requires matching updates to Console Template selection and the ACP
DTOs. A new Controller image must not be deployed alone against consumers that
still use the old contract.

A model revision identifier in an existing execution snapshot remains only as a
diagnostic identifier. It is no longer a historical resource address or foreign
key. There is no model history detail endpoint. Console shows the current model,
and Agent build details show the parameters stored on that Agent. Admitted Runs
keep their complete execution snapshot. Model edits that no build or execution
has consumed have no separate history view, old-version selection or rollback.
Template version history is unaffected.

Credential access is independent of physical storage. Public connection
projections never contain ciphertext, nonces or secrets. Execution components
receive current credentials only through the Controller-published execution
snapshot. Future OAuth uses a typed encrypted payload, connection-level refresh
coordination and compare-and-swap updates. "Needs refresh" never means "needs a
historical secret store". OAuth is not implemented.

## 7. Service Ownership

Each service owns one part of the Provider, credential and model design. A
contract is complete only when both its producer and its consumers implement it.

| Service | Role | Owns |
| --- | --- | --- |
| Admin Console | Management consumer and builtin catalogue owner | The builtin model catalogue, Provider connection management, separate credential editing, the per-connection model list and model editor, template model selection, and model discovery |
| Agent Controller | Storage authority and execution configuration producer | Supported Provider and authentication method registration, connections with their current credential, models, templates and Agents, organization isolation, idempotent commands, and publication of current configuration to ACP |
| Agent ACP Service | Execution consumer | Session model selection, Run admission, logical Provider clients, the request adapter, and reporting of model call failures |
| Edge Gateway | Transport | Forwards the existing `/api/admin/*` routes without a Provider-specific branch |

### Admin Console

- Console serves the builtin catalogue from `/api/admin/model-catalog` inside
  its own process. A catalogue read does not call Agent Controller or an external
  provider, and it still requires an administrator.
- Creation pre-fills catalogue parameters and lets the administrator change
  them. Console then submits explicit model parameters. Revision forms start from
  the saved parameters, so saved configuration always takes precedence over a
  preset. Prices are submitted explicitly; an unset price stays unknown. A
  disabled capability or a zero price is never restored from the preset. A new
  catalogue version never rewrites existing organization configuration.
- The Provider list is grouped by connection; expanding a connection shows its
  models. Creating a connection asks for the key once and lets the
  administrator pick initial models from the catalogue. The initial model list
  may be empty, and there is no invalid default model option.
- Adding or editing a model never asks for the key. The API model ID, owning
  connection and endpoint of a saved model cannot be changed in the revision
  form. Model limits are collapsed by default; capabilities, limits and prices
  are editable.
- The key is rotated separately with a CAS on the connection version. On a
  conflict, the administrator must refresh and confirm again. A retry after a
  lost response reuses the original version and idempotent request, so another
  administrator's update is never silently overwritten. The dialog cannot be
  closed while a submission is in progress.
- A model edit sends the `revision` it read as `expected_version`. After a
  conflict, Console keeps the parameter, capability and price draft and blocks
  further saves. The form is replaced only when the administrator explicitly
  reloads; a failed reload keeps the draft. A retry of the original request after
  a lost response keeps the same version and idempotency key.
- The BFF takes the organization from the Gateway principal. Management reads
  return only the opaque version needed for rotation, never the key or
  encrypted material.
- Templates are created, revised, listed and read with `model_profile_id`. The
  BFF does not look up or pin a model revision, and it rejects the old template
  revision field as invalid input. Model metadata edits and paginated merging
  do not change the template's selected identity, and the same model never
  appears twice. The current reference is read on its own and does not have to
  be on the first page. A missing or disabled reference requires an explicit
  choice of an available replacement.
- A historical template revision shows its own immutable configuration and
  displays the "Current model" through its model identity. Agent build audit
  shows the Agent's own snapshot (endpoint, capabilities, limits, temperature
  and price); its model link opens the current configuration. Current model
  parameters are never presented as a historical snapshot. There is no model
  history page.

See [Admin Console provider management](../services/admin-console/docs/provider-management.md)
and [model discovery](model-discovery.md).

### Agent Controller

- Controller has no builtin model catalogue and no `/internal/model-catalog`
  route. It never overrides context, capabilities or price by model name. It
  validates and stores the parameters Console submits.
- Controller registers supported protocols separately from the Console
  catalogue. Unimplemented OAuth and custom authentication are rejected.
- A connection and its initial models are created atomically, and one
  credential is shared by all models of that connection. Model commands do not
  accept a key or endpoint. A model revision never writes a credential. The API
  model ID is unique within a connection and cannot be changed in place.
- Rotation uses an `expected_version` CAS. Concurrent identical creation
  commands replay; conflicting input is rejected. The original creation and
  rotation results do not drift after later rotations. A failed transaction
  leaves no partial connection, credential, model or command receipt.
- Management responses never return the key, and model responses never return
  a credential identifier. RPC and storage observability use the shared
  wrappers, including parent span and error propagation.
- Templates, Agents and execution configuration reference the stable
  `model_profile_id`. An Agent keeps that identity plus a build-time model audit
  snapshot. Model revisions, AgentSpec and execution summaries carry no
  credential version.
- The Session default model, model catalogue and input capabilities follow the
  currently available connections and models. Controller never claims a model
  supports an input capability based on a historical Agent build snapshot.

#### Current-Value Storage

- `provider_connections` stores the connection and its current encrypted
  credential inline. `model_profiles` references the connection and stores the
  current parameters, an update counter and a configuration stamp. There are no
  separate credential or model history tables and no model history GET route or
  page. The model update POST path remains, but it no longer creates a queryable
  historical resource. Template history is unchanged.
- Creating one connection with three initial models inserts exactly five rows:
  one connection, three models and one command receipt. Credential rotation
  replaces the credential in place, and a model edit updates the row in place.
- Idempotency receipts keep the original non-secret response. They are not an
  audit snapshot of consumed configuration and offer no history browsing or
  rollback.
- Agent build snapshots and execution snapshots keep the parameters that were
  actually used. Concurrent rotations with the same credential do not report a
  false conflict.
- Old development databases are not migrated; the current schema requires a
  fresh instance. Deleting historical credential rows does not remove data that
  telemetry has already exported.

#### Model Edit Consistency

- A model edit must carry the `revision` it read as `expected_version`. The BFF
  forwards it unchanged, and Controller never replaces it with a freshly read
  version. The transaction CAS rejects a stale form with 409
  `lifecycle_conflict`. There is no history table, lock table or retry loop for
  this.
- A committed request always replays its original receipt first, even if the
  receipt was not yet committed when it was first checked, or if another request
  has since updated the model. When different requests edit the same version
  concurrently, only one commits. A failed transaction keeps no receipt.
- Standalone creation, edits and initial batch creation under a Provider all
  require a nonblank name of at most 200 Unicode code points. Names are not
  truncated by UTF-8 bytes or UTF-16 units.

See [Agent Controller provider management](../services/agent-controller/docs/provider-management.md)
and the [control contract](../contracts/agent-controller/control-api.md).

### Agent ACP Service

- ACP consumes the Controller execution configuration DTO and owns model and
  authentication resolution at call time.
- The request adapter is the OpenAI Chat Completions adapter; the contract keeps
  room to select other adapters later. Unknown protocols are rejected.
- After credential rotation, existing Agents make subsequent model calls with
  the new credential without a Runtime rebuild.
- Model call failures are reported normally. Provider fallback is described in
  [Provider failover](provider-failover.md).

### Edge Gateway

Edge Gateway forwards the existing `/api/admin/*` routes and has no Provider
business branch. If a contract ever requires a new entry point, that is a
separate Gateway change and does not widen another service's write scope.

## 8. Correctness Requirements

1. An administrator does not need to enter model metadata for a builtin
   Provider. Console pre-fills and submits explicit data; Controller validates
   and stores it. One credential is shared by several models. Catalogue reads do
   not call Controller or an external provider.
2. Replaying the same creation command does not create duplicate connections,
   models or credentials. Concurrent identical commands produce the same result,
   and conflicting input is rejected.
3. Context, capabilities and price of builtin models are editable. A disabled
   capability or an explicit zero price is never overwritten by a default. An
   unknown price is not treated as zero.
4. Models can be added under a builtin Provider. The same name is allowed
   across connections; a duplicate API model ID within one connection is
   rejected.
5. Editing a model does not increment the credential version. Rotating a
   credential does not increment the model, template, Agent spec or Runtime
   generation.
6. Reads and edits of Providers, models and credentials are isolated by
   organization. A forged external identity header cannot cross the Gateway
   boundary.
7. Unsupported Providers, the `oauth` authentication method, unknown request
   adapters and unsupported operations are rejected explicitly and leave no
   partial writes.
8. Model parameters and audit snapshots stay stable once a Run is admitted. A
   model edit affects later Runs, not a Run in progress.
9. After credential rotation, existing Agents make later model calls without a
   rebuild. Credential access is restricted by organization and connection
   authorization.
10. Management APIs and the browser never echo secrets. Under the telemetry
    policy, only RPC boundaries capture bodies; plain HTTP does not record them
    again. Provider creation, credential rotation and credential access are
    metadata-only routes.
11. Even with full RPC capture enabled in development, traces must not be
    described as redacted unless they are. Raw traces, credentials and process
    logs are never committed to the repository.
12. Connection creation, model editing, credential rotation, template creation,
    Agent creation and model invocation each produce a trace whose parent-child
    relationships and errors can be checked in Jaeger.

Before a Codex adapter is enabled, additional cases are required: authorization
success, cancellation and timeout; state and organization binding; no refresh
while the token is valid; a single refresh under concurrency; refresh token
replacement; reauthorization after failure; account identity propagation; and
the dedicated model protocol. Until then, only rejection of the unimplemented
capability is tested, and no test double stands in for a finished Codex
integration.
