# Model Pricing (F10)

Status: original F10 batch verified on 2026-09-09. Catalogue ownership changed
on 2026-09-11; historical evidence below does not validate that later change. Controller and ACP
pricing are ready; Agent UI and deployed cross-service acceptance remain
separate batches. Shared Console contract revision: 35.

## Contract And Ownership

The existing create/revise model commands forward optional `model.pricing` to
Controller unchanged. Its contract is USD per million tokens: required
`input_per_million` and `output_per_million`, optional `cache_read_per_million`
and `cache_write_per_million`, finite and nonnegative. Omitted prices are unknown, including for builtin models. Explicit zero is free.
Builtin defaults live in Console's `internal/server/builtin_catalog.go` and are
served locally by `GET /api/admin/model-catalog`; no downstream call or database
is involved. DeepSeek and OpenRouter are listed in the current release. Organization model
configuration and encrypted credentials remain Controller-owned.

BFF projects only these price fields on Model Profile list/current/
write responses, Overview and Agent configuration. Incomplete or
invalid upstream prices must not become a zero quote. Organization and
administrator checks are unchanged; Provider credentials, private rate metadata
and internal IDs remain excluded. Controller owns request validation, current-model updates and the immutable
admission snapshot. Console defaults are not runtime authority.

OpenRouter defaults were checked against its public [model catalogue](https://openrouter.ai/api/v1/models)
on 2026-09-15. `openai/gpt-4o-mini` uses a 128,000-token context, 16,384 output limit,
and USD 0.15/0.60 per million input/output tokens (cache read 0.075).
`qwen/qwen3-coder` uses 262,144/65,536 tokens and USD 0.30/1.00 (cache read 0.10).
These are editable estimates, not guarantees of routed-provider pricing.

## Editing And Reading

1. New model drafts prefill Console's catalogue estimate and submit explicit
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
   it never requests hidden catalogue fallback. Existing Agent build and Run
   snapshots remain unchanged. Price-only edits update model metadata without credentials;
   keys are rotated through the independent Provider connection action.
4. Selecting a different new model resets unrelated rate drafts. Existing API
   model identity and connection endpoint are not editable in model revisions. A failed publication
   preserves the draft and its existing stable retry identity, including a
   malformed successful response whose commit is uncertain; changing rates
   is a new intent. Pending publication disables controls. Closing an abandoned
   form discards its draft. Rate and credential values are not persisted in
   browser storage by this feature.
5. Detail shows saved current rates. No model history route exists. Historical
   execution prices remain in the Agent build and Run admission snapshots. Absent cache rates
   show the stored ordinary input-rate fallback; absent prices show unknown.
   Estimates are not invoices and do not include negotiated/time-based billing.

## Acceptance

- BFF: every nested projection, omission/zero/cache precision, private-field
  stripping, invalid owner-response handling, create/revise forwarding and
  owner rejection, administrator isolation.
- Pure frontend: form parsing, required/optional/zero/nonfinite cases, exact
  rates, model identity and catalog defaults, display without rounding to free.
- Components with the real API wrapper: create with default/custom/no price;
  revision preservation/reset; errors/retry/pending; model and endpoint switching;
  abandoned draft disposal; saved current parameters independent of catalog.
- Full Go/race and Console frontend tests/build; repository fmt/lint gates.
- Browser desktop/mobile acceptance of rendered form, zero and unknown labels,
  error recovery and saved revision, using synthetic responses. Actual
  Gateway/Controller/ACP/Jaeger acceptance follows the Agent UI batch; the
  completed F10 deployment result is recorded in
  [ACP conformance](../../agent-acp-service/docs/protocol-conformance.md).

## Builtin Snapshot

Defaults moved unchanged from the previously maintained snapshot (2026-09-09).
They are editable estimates, not current billing guarantees. Updating this file
or Console code never rewrites organization configuration.

| DeepSeek model | Input | Cached input | Output |
| --- | ---: | ---: | ---: |
| deepseek-v4-flash | 0.44 | 0.014 | 1.32 |
| deepseek-v4-pro | 1.32 | 0.044 | 3.96 |
| deepseek-v4-flash-vision-exp | 0.44 | 0.014 | 1.32 |

Units are USD per million tokens. The snapshot uses a fixed peak-rate estimate,
not a clock-dependent invoice calculation. Each preset has a 1,000,000-token
context and 384,000 maximum output; only the vision preset defaults to image
input. Source: [DeepSeek model and pricing documentation](https://api-docs.deepseek.com/quick_start/pricing/).
New defaults require source review and tests in Console; no Controller catalogue
or matching logic may be added.

See [Controller pricing](../../agent-controller/docs/model-pricing.md) for
validation, organization storage and immutable snapshots.

## Verification

- `npm --prefix services/admin-console/web test`: 245 passed (88 pure helper
  tests and 157 component tests across 14 files), no skips or failures. New F10
  coverage includes 6 pure tests and 12 component cases; existing capability,
  session and lifecycle tests remain enabled.
- Full Console `go test -p=1 -race -coverprofile=... ./services/admin-console/...
  -count=1`: five tested packages passed, no race reports. Overall statement
  coverage 67.3%; server 79.0%; new pricing decoder 90.0% and numeric projection
  helper 100.0%. This is service-test coverage, not whole-platform coverage.
- Production frontend build, `make -j1 fmt-check lint`, and `git diff --check`
  passed. Go standard lint reported zero issues; Rust Clippy and all Node
  lint/typechecks passed without threshold or baseline changes.
- Independent read-only review identified uncertain-response retry identity
  and numeric underflow; both were fixed and regression-tested. Reviewers were
  closed. Testing/build/lint ran serially under the coordinator.
- Chrome verified the built frontend with synthetic in-memory responses:
  1440x1000 catalog form and 320x760 editable form; narrow page width 320 and
  dialog client/scroll widths both 286. Scrolling reaches the submit controls.
  Underflow rejection focuses the field; zero-price creation succeeds; a new
  catalog-priced revision leaves the old zero-price revision read-only and
  unchanged. This is browser acceptance, not a deployed BFF/Controller/ACP test.

No database, container or external Provider was needed for this batch. Temporary
coverage output is removed after recording these compact metrics. Deployment,
cost notification display in Agent UI and Jaeger ancestry remain unverified for
F10 and must be covered by the subsequent consumer/integration batches.
