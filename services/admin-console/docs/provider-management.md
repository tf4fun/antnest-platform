# Provider connections and models

This document describes how Admin Console manages Provider connections,
credential rotation, model discovery and model metadata, and the BFF routes
behind those workflows.

Model edits send `expected_version` from the read model's `revision`, alongside
the administrator's input. Console never substitutes a fresh version silently.
On Controller 409 `lifecycle_conflict`, retain the draft, disable saving and offer
an explicit reload. Reload succeeds before replacing the draft; failures keep it
intact. Retrying an uncertain response keeps the original command identity and
version. Display-name validation counts Unicode code points, matching Controller's
200-character model-name limit rather than counting UTF-8 bytes or UTF-16 units.

Models are mutable current configurations, not independently browsable histories.
Agent details retain their build-time snapshot; model links open current settings.
Template history is unchanged. There is no model-history API or route.
Command receipts preserve submitted results on retry but are not model history.

Console owns the builtin catalog; Controller owns saved organization data.
DeepSeek and OpenRouter API-key connections are supported. Custom providers
and subscription login are not exposed. Future catalog entries and credential
flows must be added explicitly.

## Workflows

Discovery belongs to Controller. Console forwards one authenticated request,
with the unchanged signed administrator CCT and its verified Organization scope,
then projects the model-only response. Saved credentials are opened only inside
Controller; Console has no plaintext credential read or Provider HTTP client.
Draft credentials are forwarded once without creating a connection or model.
Candidate state exists only in the open dialog.

Controller validates all resolved destination addresses and pins the socket,
disables redirects and proxies, and bounds the Provider response to 8 MiB. The
[shared destination policy](../../../contracts/platform/provider-destination-policy.md)
defaults to denying private endpoints. Only an operator can enable the exact
private-endpoint option in Controller and ACP; browser input cannot enable it.
Console retains its dependency deadline, response bound and `no-store` policy.
Discovery failures use bounded codes and static messages, never raw upstream
bodies, addresses or credentials. HTTP telemetry is metadata-only.

Candidates merge remote results, builtin defaults, and all saved model pages by
API model ID within the selected connection. Remote values enrich new drafts;
saved values win and remain marked Added, including disabled models. An empty
remote result retains builtin/saved candidates. Provider failure reports an error
and offers those candidates; authorization or inaccessible connections fail
closed. Refresh cannot modify persisted models. Missing required parameters must
be completed explicitly. Partial batch save retains successful additions and
retries only the remaining selection.

1. Open Model providers. List connections, not model revisions disguised as
   providers. Connect DeepSeek or OpenRouter with an API key and an editable endpoint. Select
   models after Controller discovers candidates using the draft key, without saving
   the connection first. No model is selected automatically; choosing none is valid.
2. Expand a connection to inspect its models. Add a listed or unlisted model,
   editing limits, capabilities and rates only when necessary. Adding models
   never asks for credentials. Model detail shows current saved parameters.
3. Publish model metadata changes without changing its API model ID, connection
   or endpoint. Saved values take precedence over newer catalogue defaults.
4. Replace the connection's API key separately. Send the displayed credential
   version as a CAS precondition. A conflict requires refreshing the connection;
   never silently retry with a newer version. Existing model parameters remain
   untouched. Keys are write-only and are not stored in browser persistence.
5. Templates select a stable `model_profile_id`, not a model revision. New model
   metadata keeps the selection intact. Template detail (including historical
   template revisions) resolves the referenced model's current head and labels
   it as Current model. Agent detail separately shows its build snapshot's model
   limits, endpoint, input formats, temperature and rates; its model link opens
   current settings. There is no independent model history page.
   Templates also retain ordered `fallback_model_profile_ids`, one model per
   additional connection. Add/remove/reorder backups explicitly; existing saved
   references survive disabled Providers and partial catalogue reads. Rebuild
   existing Agents to apply a new Template candidate list. ACP selects the first
   available candidate when the preferred connection is disabled, and publishes
   standard configuration notifications. Disabling a referenced Provider is
   permitted and aborts active requests; it does not replay an interrupted Run.
   Model disable still requires removing references. No delete API is exposed.

## BFF contract

The BFF contract (revision 49) has no model-history reads. Each command scope has one
pending intent: an identical retry reuses its key; changing the payload abandons
that intent. Returning to an earlier payload is a new command, not replay of an
older successful response. Browser storage contains only opaque keys and hashes,
not request bodies or credentials.

All routes require a verified signed administrator CCT. Organization IDs come
from verified claims, never browser payloads. No service database is
accessed by Console. Calls use the existing instrumented upstream client.

| Browser route                                               | Controller route                                           | Purpose                                                      |
| ----------------------------------------------------------- | ---------------------------------------------------------- | ------------------------------------------------------------ |
| GET/POST `/api/admin/provider-connections`                  | GET/POST `/internal/provider-connections`                  | List or create connection with initial models                |
| POST `/api/admin/provider-models/discovery`                 | POST `/internal/provider-discovery/draft`                  | Discover using an unsaved connection draft                   |
| GET `/api/admin/provider-connections/{id}/models/discovery` | POST `/internal/provider-connections/{id}/discover-models` | Discover inside Controller using its current credential      |
| GET `/api/admin/provider-connections/{id}`                  | GET `/internal/provider-connections/{id}`                  | Refresh connection and credential version                    |
| POST `/api/admin/provider-connections/{id}/credentials`     | POST `/internal/provider-connections/{id}/credentials`     | CAS credential rotation                                      |
| POST `/api/admin/model-profiles`                            | POST `/internal/model-profiles`                            | Add a model to a connection                                  |
| POST `/api/admin/model-profiles/{id}/revisions`             | POST `/internal/model-profiles/{id}/revisions`             | Publish metadata without credentials                         |
| POST `/api/admin/templates`                                 | POST `/internal/agent-templates`                           | Create a template referencing `model_profile_id`             |
| POST `/api/admin/templates/{id}/revisions`                  | POST `/internal/agent-templates/{id}/revisions`            | Publish template configuration with a stable model reference |

Connection creation accepts `provider_key`, `display_name`, `base_url`, typed
`credential: {method: api_key, api_key}`, and explicit `models` array. Each initial
model contains `display_name` and `model` parameters. The BFF derives stable
profile keys from the scoped idempotent request and array position. Model
creation accepts `provider_connection_id`, `display_name`, `model`; revisions
accept only the latter two fields. Model parameters exclude `base_url`.

Reads project only public connection metadata plus `credential_version` (an
opaque rotation precondition, not a secret). Model reads include
`provider_connection_id`. Keys/ciphertext and internal organization identities
are never projected. Mutations preserve request identity on ambiguous retry.
Lists preserve owner cursors; incomplete model inventory must not imply absence.
Model choices merge by stable identity. An independently loaded current model
remains selectable even when absent from the first list page; a missing or
disabled model cannot silently select a replacement. The Controller remains
the authority for organization, connection and model availability at write time.
Template writes never resolve a model revision in the BFF and reject the obsolete
`model_profile_revision_id` input. Reference read failures preserve the template
and any publication acknowledgement, with a local retry for transient failures.

## Testing

Go tests cover BFF authority, request shaping, write-only credentials, stable
retries, CAS conflicts, and cursor handling. Component tests cover creation,
independent rotation/model edits, saved metadata, immutable identity,
loading/failure states and responsive presentation.

An opt-in discovery test runs against a local development Gateway and a real
Provider:

```sh
node tests/e2e/admin-console/model-discovery-browser.mjs --confirm-development
```

Run it from the repository root with the development environment and Provider
credentials configured. It discovers OpenRouter models, checks the unsaved-connection flow,
adds one explicitly selected model to an existing enabled OpenRouter connection,
and verifies merged/saved/fallback views on desktop and mobile. It never calls a
completion endpoint or changes credentials. Only final screenshots and a compact
summary are written to the Git-ignored
`artifacts/verification/model-discovery-acceptance/` directory.
