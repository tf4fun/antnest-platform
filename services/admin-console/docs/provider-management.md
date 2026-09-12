# Provider connections and models

Console owns the builtin catalogue; Controller owns saved organization data.
Only DeepSeek API-key connections are currently supported. Custom providers,
subscription login and remote catalogue discovery are not exposed as working
features. Add future catalogue entries and credential flows explicitly.

## Workflows

1. Open Model providers. List connections, not model revisions disguised as
   providers. Connect DeepSeek with an API key and an editable endpoint. Select
   initial models from Console defaults (including selecting none).
2. Expand a connection to inspect its models. Add a listed or unlisted model,
   editing limits, capabilities and rates only when necessary. Adding models
   never asks for credentials. Model detail retains historical revision links.
3. Publish model metadata changes without changing its API model ID, connection
   or endpoint. Saved values take precedence over newer catalogue defaults.
4. Replace the connection's API key separately. Send the displayed credential
   version as a CAS precondition. A conflict requires refreshing the connection;
   never silently retry with a newer version. Existing model revisions remain
   untouched. Keys are write-only and are not stored in browser persistence.
5. Templates select a stable `model_profile_id`, not a model revision. New model
   metadata keeps the selection intact. Template detail (including historical
   template revisions) resolves the referenced model's current head and labels
   it as Current model. This is not the historical execution snapshot: Model
   revision pages and Agent build lineage retain their revision-qualified reads.
   ACP execution changes remain a separate delivery batch.

## BFF contract

All routes require the existing administrator principal. Organization IDs come
from trusted gateway context, never browser payloads. No service database is
accessed by Console. Calls use the existing instrumented upstream client.

| Browser route | Controller route | Purpose |
| --- | --- | --- |
| GET/POST `/api/admin/provider-connections` | GET/POST `/internal/provider-connections` | List or create connection with initial models |
| GET `/api/admin/provider-connections/{id}` | GET `/internal/provider-connections/{id}` | Refresh connection and credential version |
| POST `/api/admin/provider-connections/{id}/credentials` | POST `/internal/provider-connections/{id}/credentials` | CAS credential rotation |
| POST `/api/admin/model-profiles` | POST `/internal/model-profiles` | Add a model to a connection |
| POST `/api/admin/model-profiles/{id}/revisions` | POST `/internal/model-profiles/{id}/revisions` | Publish metadata without credentials |
| POST `/api/admin/templates` | POST `/internal/agent-templates` | Create a template referencing `model_profile_id` |
| POST `/api/admin/templates/{id}/revisions` | POST `/internal/agent-templates/{id}/revisions` | Publish template configuration with a stable model reference |

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

## Verification

Cover BFF authority, request shaping, write-only credentials, stable retries,
CAS conflicts, and cursor handling. Component tests cover creation, independent
rotation/model edits, saved metadata, immutable identity, loading/failure states
and responsive presentation. Run Go tests, frontend tests/build and admission
gates serially. Browser inspection supplements these reusable tests.
