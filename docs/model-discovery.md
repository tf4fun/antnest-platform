# Model discovery and explicit selection

This document describes how administrators discover a provider's models in
Console and explicitly choose which ones to save.

## Scope and ownership

The Console owns builtin model defaults and model selection. Agent Controller
owns discovery, credentials and the administrator's saved model configuration. ACP is not
changed by discovery and continues consuming published execution configuration.

1. Enter a provider credential in Console, or select an existing connection.
2. Console requests Controller's model-only discovery. Drafts use the form's
   ephemeral credential without saving it; saved connections open the current
   credential inside Controller. Console never receives a decrypted stored key.
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

Controller revision 38 exposes
`POST /internal/provider-connections/{connection_id}/discover-models` and
`POST /internal/provider-discovery/draft`. Both return model lists only and require
verified Console workload plus signed administrator/Organization CCT. Saved
discovery accepts only Organization scope, reads current credential identity and
ciphertext together, validates the endpoint, and opens the key inside Controller.
Draft discovery forwards the submitted credential once and does not persist it.
The former plaintext `/access` export and its response schema are removed.

Controller discovery and the Console thin proxy are admitted on
`feat/service-authentication`. ACP's independent model-call policy remains a
separate service batch in the [rollout ledger](../contracts/platform/service-authentication-rollout.json).
Complete cross-service acceptance follows all service and deployment batches.

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
credentials. Destination policy denial is `422 provider_endpoint_forbidden`;
DNS failure is retryable `503 provider_endpoint_unavailable`. Existing
scope/disabled errors retain their standard status/code.
The operation does not write any business data or perform a model completion.

The Controller-owned adapter covers DeepSeek and OpenRouter's OpenAI-compatible `/models`
envelope. OpenRouter metadata may prefill limits, image support, and per-token
prices converted to per-million. Discovery uses a bounded request and response,
does not follow redirects with credentials, and uses shared HTTP instrumentation.

API references: [DeepSeek](https://api-docs.deepseek.com/api/list-models/),
[OpenRouter](https://openrouter.ai/docs/api/api-reference/models/list-all-models-and-their-properties).

## Verification

The browser test
[`model-discovery-browser.mjs`](../tests/e2e/admin-console/model-discovery-browser.mjs)
covers read-only discovery without secret exposure, unsaved and unselected
drafts, explicit subset persistence without overwriting existing settings,
saved-model preservation through refresh and an injected discovery 502,
duplicate prevention and mobile layout. It does not perform model completions.

Test coverage by component:

- Controller: organization scope, current credential, disabled references,
  read-only discovery, no exported key, destination denial and DNS/socket pinning.
- Controller provider adapter: list normalization, duplicate IDs, optional metadata,
  unknown pricing, timeout/cancellation, malformed/oversized response, redirect.
- Console: authenticated access, secret-free projection, remote success vs
  empty vs failure, provider-scoped merge/enrichment, explicit selection, existing
  model protection, missing parameters, refresh races, partial save retry.
- Integration: discover against a provider fixture, select and persist a subset;
  repeat discovery without changing saved configuration; exercise static fallback.
- Real provider discovery and desktop/mobile browser checks require no external
  model completions.
