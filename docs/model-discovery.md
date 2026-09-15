# Model discovery and explicit selection

## Scope and ownership

The Console owns builtin model defaults and model selection. Agent Controller
owns credentials and the administrator's saved model configuration. ACP is not
changed by discovery and continues consuming published execution configuration.

1. Enter a provider credential in Console, or select an existing connection.
2. Console requests the provider's model list. New connections use the form's
   credential without saving it; existing connections resolve only their current
   credential through Controller's organization-scoped internal access endpoint.
3. Console merges remote candidates, its builtin directory, and saved models by
   API model ID within that connection. Remote metadata fills the candidate draft;
   missing fields use builtin defaults. Saved records retain their own parameters.
   No model is preselected. Successful empty discovery still offers builtin models.
4. If discovery fails, Console explicitly reports the failure and retains builtin
   and saved models. Authorization/not-found/disabled errors are not discovery failures.
5. The administrator searches, selects, optionally edits parameters, and saves.
   Only selected models are persisted through existing model creation commands.
   Already saved models are not overwritten, removed, or enabled by a refresh.

No new database tables, model revisions, scheduled refresh, or inventory journal
are introduced. Candidate state is temporary UI state. Partial batch saves retain
successful additions and identify the remaining selection for retry.

## Contract

Controller exposes only
`GET /internal/provider-connections/{connection_id}/access?organization_id=...`.
It returns current connection configuration and its credential to trusted services,
with metadata-only telemetry and no caching. It never contacts providers or knows
about model discovery. This endpoint is not exposed through Gateway.

Console exposes `GET /api/admin/provider-connections/{connection_id}/models/discovery`
for saved connections, and `POST /api/admin/provider-models/discovery` for drafts
(`provider_key`, `base_url`, `credential`). Both require an administrator. Console
derives organization scope from the principal and never returns credentials.

Success: `{ "models": [{ "model_id": "...", "display_name": "..." }] }`.
Optional fields: `context_window`, `max_output_tokens`, `supports_images`,
`pricing` (existing USD-per-million schema). Omission means unknown, not zero or
free. Missing required execution parameters must be supplied before model save.

Provider timeout, invalid response, and non-2xx status return
`502 provider_discovery_failed`; the response never includes upstream bodies or
credentials. Existing scope/disabled errors retain their standard status/code.
The operation does not write any business data or perform a model completion.

The Console-owned adapter covers DeepSeek and OpenRouter's OpenAI-compatible `/models`
envelope. OpenRouter metadata may prefill limits, image support, and per-token
prices converted to per-million. Discovery uses a bounded request and response,
does not follow redirects with credentials, and uses shared HTTP instrumentation.

API references: [DeepSeek](https://api-docs.deepseek.com/api/list-models/),
[OpenRouter](https://openrouter.ai/docs/api/api-reference/models/list-all-models-and-their-properties).
UI reference: local Cherry Studio's provider model management and explicit add flow.

## Verification

- Controller: organization scope, current credential, disabled references,
  read-only access, absence of provider discovery responsibilities.
- Console provider adapter: list normalization, duplicate IDs, optional metadata,
  unknown pricing, timeout/cancellation, malformed/oversized response, redirect.
- Console: authenticated access, secret-free projection, remote success vs
  empty vs failure, provider-scoped merge/enrichment, explicit selection, existing
  model protection, missing parameters, refresh races, partial save retry.
- Integration: discover against a provider fixture, select and persist a subset;
  repeat discovery without changing saved configuration; exercise static fallback.
- Real provider discovery and desktop/mobile browser checks are coordinator-owned;
  no external model completions are required for this feature.
