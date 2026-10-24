# Session Cost

This document describes how Agent ACP Service measures model usage, projects a
known USD cost per Session and exposes it through standard ACP
`usage_update` notifications. Known cost is partial accounting, not an invoice.
Its floating-point reporting total is not the atomic spending ledger or hard
Run/organization cap enforcement planned under
[model-call policy](../../../contracts/agent-controller/model-call-policy.md).

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
4. Keep each physical model attempt's returned normalized token counts and optional
   `{amount, currency, source, pricing?}` receipt in its existing usage event.
   `source` distinguishes `provider_reported` from `estimated`; estimated receipts
   retain the actual frozen rates. A missing receipt means unpriced, not free.
   A Model error carries already-received usage separately from its failed
   completion. Foreground and permission-judge calls use the same Run attempt
   policy and counter; each attempt records its usage once, including failures
   and cancellation. Missing returned usage is stored as `{}`, not fabricated
   zero token counts or zero cost. Its standard `used: 0` projection does not
   prove that the Provider consumed nothing. Losing execution ownership still
   forbids new writes.
5. Attempt start/finish facts are hidden audit entries, excluded from Session
   replay and model context. Under the existing Session/Run authority boundary,
   one PostgreSQL transaction appends the finish fact, usage measurement and its
   known cumulative cost. The caller does not append usage separately after
   finishing the attempt. Stable Run/ordinal/phase identities make identical
   retries return the saved receipt; conflicting reuse fails. Only the returned
   usage projection is published. Session history is not updated by a second
   per-token write. The independent model budget ledger settles in the same
   transaction as the attempt finish and public usage receipt.
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

## Budget accounting rollout

The budget ledger keeps integer microdollar charges and unresolved reservations
independently of Run or Session deletion. It uses the frozen configured rates
for estimates and valid Provider-reported receipts when available; these system
budget amounts are not a reconciled external invoice. Unknown measurements stay
unknown, and an organization policy controls whether monetary uncertainty can
be admitted. A configured token cap still requires a safe token bound.

Migration 0032 imports original per-call receipts and unmatched hidden starts,
excludes Fork copies and retains a separate coverage boundary for history that
may already have been purged. It never sums cumulative Session display costs.
See [the rollout and coverage rules](operations.md) before deployment. The
Run admission now checks current UTC organization spending and unresolved
reservations against daily/monthly hard thresholds, before accepting the Prompt.
An exhausted threshold rejects the original intent atomically; confirmed
rejection releases its Runtime pin, while unknown commit receipts retain it.
See [model-call admission](model-calls.md) for zero-cap and unknown-history rules.
The ledger and rejection path still need production request
bounds, per-call reservations, excess handling, soft notifications and the
Controller/Console policy consumers still need their business acceptance.

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

The [same-model retry and before-output fallback paths](model-calls.md) also cover
failed-attempt unknown measurements, successful known usage, hidden audit and
unchanged Session replay through real HTTP Provider connections and PostgreSQL.
Each attempt uses its frozen candidate identity and pricing. That component
coverage does not replace final Docker acceptance. Controller's two-retry and
before-output failover defaults are not yet published. Provider circuits skip
unavailable connections without recording synthetic attempts or usage.
Per-call safe spending reservations, the remaining cap enforcement, Console policy
controls and final #52 integration remain pending; the Session display projection
does not implement enforcement.

Prior deployment evidence used the retired Gateway ACP/state routes. That
recorded coverage remains historical. Gateway 24 requires a separate consumer
migration: browser journeys through the retained Agent UI Bridge and protocol
assertions through authenticated private ACP. This ACP owning batch does not
admit that cross-service workflow or its capacity gate.
