# Model Pricing

This document describes how Admin Console edits, projects and displays optional
model pricing, and lists the builtin pricing estimates shipped with the Console
catalog.

## Contract And Ownership

The existing create/revise model commands forward optional `model.pricing` to
Controller unchanged. Its contract is USD per million tokens: required
`input_per_million` and `output_per_million`, optional `cache_read_per_million`
and `cache_write_per_million`, finite and nonnegative. Omitted prices are
unknown, including for builtin models. Explicit zero is free.
Builtin defaults live in Console's `internal/server/builtin_catalog.go` and are
served locally by `GET /api/admin/model-catalog`; no downstream call or database
is involved. DeepSeek and OpenRouter presets are included. Organization model
configuration and encrypted credentials remain Controller-owned.

BFF projects only these price fields on Model Profile list/current/
write responses, Overview and Agent configuration. Incomplete or
invalid upstream prices never become a zero quote. Organization and
administrator checks are unchanged; Provider credentials, private rate metadata
and internal IDs remain excluded. Controller owns request validation,
current-model updates and the immutable admission snapshot. Console defaults
are not runtime authority.

## Editing And Reading

1. New model drafts prefill Console's catalog estimate and submit explicit
   pricing, or show `Not configured` when no estimate is known. Controller never
   supplies a missing default. Values can be edited before submission.
2. `Set rates` enables ordinary input/output fields and optional cache fields.
   All units are visibly USD per 1M tokens. Empty ordinary inputs, negative,
   nonnumeric and nonfinite values fail locally. Optional blank cache fields
   are omitted, never zero-filled. Tiny positive rates are never displayed as
   zero; nonzero underflow is rejected, and stored precision is not rounded when
   publishing. Representable subnormal rates remain valid.
3. Editing the same model starts from its saved current prices, not today's
   catalog. Disabling `Set rates` explicitly removes current pricing;
   it never requests hidden catalog fallback. Existing Agent build and Run
   snapshots remain unchanged. Price-only edits update model metadata without
   credentials; keys are rotated through the independent Provider connection
   action.
4. Selecting a different new model resets unrelated rate drafts. Existing API
   model identity and connection endpoint are not editable in model revisions.
   A failed publication preserves the draft and its existing stable retry
   identity, including a malformed successful response whose commit is
   uncertain; changing rates is a new intent. Pending publication disables
   controls. Closing an abandoned form discards its draft. Rate and credential
   values are not persisted in browser storage.
5. Detail shows saved current rates. No model history route exists. Historical
   execution prices remain in the Agent build and Run admission snapshots.
   Absent cache rates show the stored ordinary input-rate fallback; absent
   prices show unknown. Estimates are not invoices and do not include
   negotiated or time-based billing.

## Builtin Estimates

Builtin prices are editable estimates, not billing guarantees. Updating this
file or Console code never rewrites organization configuration. Units are USD
per million tokens.

| DeepSeek model | Input | Cached input | Output |
| --- | ---: | ---: | ---: |
| deepseek-v4-flash | 0.44 | 0.014 | 1.32 |
| deepseek-v4-pro | 1.32 | 0.044 | 3.96 |
| deepseek-v4-flash-vision-exp | 0.44 | 0.014 | 1.32 |

The DeepSeek presets use a fixed peak-rate estimate, not a clock-dependent
invoice calculation. Each has a 1,000,000-token context and 384,000 maximum
output; only the vision preset defaults to image input. Source:
[DeepSeek model and pricing documentation](https://api-docs.deepseek.com/quick_start/pricing/).

| OpenRouter model | Context | Max output | Input | Cached input | Output |
| --- | ---: | ---: | ---: | ---: | ---: |
| openai/gpt-4o-mini | 128,000 | 16,384 | 0.15 | 0.075 | 0.60 |
| qwen/qwen3-coder | 262,144 | 65,536 | 0.30 | 0.10 | 1.00 |

OpenRouter values come from its public
[model catalog](https://openrouter.ai/api/v1/models). They are estimates, not
guarantees of routed-provider pricing.

New defaults require source review and tests in Console; no Controller catalog
or matching logic may be added. See
[Controller pricing](../../agent-controller/docs/model-pricing.md) for
validation, organization storage and immutable snapshots.

## Testing

- BFF tests: every nested projection, omission/zero/cache precision,
  private-field stripping, invalid owner-response handling, create/revise
  forwarding and owner rejection, administrator isolation.
- Pure frontend tests: form parsing, required/optional/zero/nonfinite cases,
  exact rates, model identity and catalog defaults, display without rounding to
  free.
- Component tests with the real API wrapper: create with default/custom/no
  price; revision preservation/reset; errors/retry/pending; model and endpoint
  switching; abandoned draft disposal; saved current parameters independent of
  the catalog.
- Browser tests (`npm --prefix services/admin-console/web run test:browser:catalog`)
  render the form at desktop and mobile widths with synthetic responses,
  including zero and unknown labels, underflow rejection, error recovery and
  saved revisions.

No database, container or external Provider is needed for these tests.
