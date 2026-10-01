# Session Cost

This document describes how Agent ACP Service measures model usage, projects a
known USD cost per Session and exposes it through standard ACP
`usage_update` notifications. Known cost is partial accounting, not an invoice.

## Ownership And Contract

Controller remains the model/configuration authority. Its optional
published model `pricing` is `{currency: "USD", input_per_million,
output_per_million, cache_read_per_million?, cache_write_per_million?}`. Rates are
finite, nonnegative numbers. Both ordinary rates are required; zero is an
explicit free rate, not a missing value. Console supplies builtin draft defaults;
Controller preserves the submitted current prices. ACP freezes selected rates
in its local Run configuration. ACP neither reads a pricing file nor
accepts prices from ACP clients. Old/unknown model snapshots may omit pricing.

The ACP domain uses the same shape in camelCase. Prices travel with the immutable
model snapshot and remain in execution history after restart, without resuming
the old Run. Prices arrive through the current
[execution snapshot publication](execution-configuration.md); Controller
model-profile management supports prices, and Console submits this contract.
There is no separate price revision or billing service.

## Measurement And Projection

1. Normalize OpenAI-compatible usage for JSON and streaming responses through
   one adapter. Normalized input tokens include cache-read/cache-write tokens;
   those are subsets, not additional input tokens. Never double charge them.
   Usage and completion validation are independent. Invalid optional cache
   metadata prevents estimation, not retention of valid reported USD cost.
   Streaming usage is a cumulative snapshot: merge present fields, never add
   repeated counts, and preserve valid usage even in an invalid output chunk.
2. Adopt a finite nonnegative Provider `usage.cost` in USD first. This adapter's
   numeric cost convention is USD unless an explicit `cost_currency`/`currency`
   says otherwise. Non-USD/invalid amounts are not relabeled as USD. When known
   USD prices and token counts exist, they may instead produce an estimate.
3. Estimate `(uncached_input * input_rate + output * output_rate + cache_read *
cache_read_rate + cache_write * cache_write_rate) / 1_000_000`. Missing cache
   rates use the input rate. Missing token usage, inconsistent cache counts or
   absent prices cannot produce a fabricated zero estimate. Zero reported cost
   and explicitly zero configured prices remain valid known amounts.
4. Keep each model call's returned normalized token counts and optional
   `{amount, currency, source, pricing?}` receipt in its existing usage event.
   `source` distinguishes `provider_reported` from `estimated`; estimated receipts
   retain the actual frozen rates. A missing receipt means unpriced, not free.
   A Model error carries already-received usage separately from its failed
   completion; the turn runner and permission judge record it once before
   handling the failure. Failed/cancelled requests without usable returned
   usage are not guessed. Losing execution ownership still forbids new writes.
5. Under the existing Session write lock, append the measurement and its known
   cumulative cost together. Retrying the same event ID with the same measurement
   returns the saved event; conflicting reuse fails. There is no second mutable
   total, attachment table, billing ledger or per-token write.
   An unrepresentable cumulative amount retains the last representable known
   baseline and the new receipt, never silently resetting the next sum to zero.
   As with unpriced calls, the projection is a partial amount, not a bill.
6. Load/replay returns the saved projection, not a fresh sum. Fork copies the
   historical known cost as its branch starting point; subsequent calls add to
   that branch only. This is Session history accounting, never an organization
   invoice obtained by summing forks. Catalog updates never reprice history.
7. v1/v2 `usage_update` exposes only standard `used`, `size` and optional
   `cost: {amount, currency}`. Private measurement/source/rates are not leaked as
   extra ACP fields. Known cost can be partial and is not a reconciled bill.

## Verification

1. ACP: pure pricing and accumulation tests; exact JSON/SSE usage normalization,
   absent/invalid/zero/non-USD/cache cases; saved per-call receipts; PostgreSQL
   concurrency/idempotency, recovery and fork independence; standard v1/v2
   notification and replay schema checks, including permission-judge model calls.
   See the rows `V1-COST-01` and `V2-COST-01` in [protocol conformance](protocol-conformance.md#stable-acp-v1-matrix).
2. Controller: validated optional pricing, admin authority, preservation of
   submitted current values and execution snapshot propagation. See
   [Controller pricing](../../agent-controller/docs/model-pricing.md).
3. Console/BFF: bounded price inputs, clear per-million-token units, unknown vs
   explicit zero, response projections and immutable revision inspection. See
   [Console pricing](../../admin-console/docs/model-pricing.md).
4. Agent UI: optional known-cost presentation without implying complete billing;
   protocol replay rebuilds authoritative usage, without cross-Session leakage
   or duplicate counting; successful unpriced replay resets cost to unknown. See
   [Session usage](../../agent-ui/docs/session-usage.md).
5. Deployed: the [Session cost profile](../../../tests/e2e/acp-cost/README.md)
   (`make e2e-session-cost`) covers Gateway v1 HTTP/v1/v2 WebSocket, model price
   switching, Provider precedence, no-price calls, restored/forked Sessions and
   Jaeger ancestry. Tests use deterministic USD rates; no external Provider
   spend is required.
