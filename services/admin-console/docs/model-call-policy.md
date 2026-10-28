# Organization model budgets and Template model policy (#52)

Admin contract version 58 exposes the organization model-call budget on the
**Model budgets** page (`#model-call-policy`, Organization navigation) and adds
the optional Template model policy to template create and revision dialogs.
This document is operator guidance; wire semantics are in
`contracts/admin-console/model-call-policy.md`.

## Organization budget (Model budgets)

The page reads the current policy and edits a complete replacement:

- **Calls with unknown cost** — `Allow` permits calls whose provider cannot
  report cost, which means no cost cap can be guaranteed for them. `Deny`
  rejects those calls; token bounds can also fail closed for providers that
  cannot prove usage.
- **Per-run caps** — aggregate input/output token limits and an exact USD cost
  limit applied to every future run admission. Blank sets no bound from this
  policy (providers and models may still limit). `0` denies any positive input,
  output or priced consumption.
- **Daily and monthly UTC caps** — a *soft* cap raises a warning; a *hard* cap
  denies further calls for the UTC window. Soft must never exceed hard.

USD fields accept an exact nonnegative decimal with up to six fractional
places (e.g. `0.50`, `.5`, `9007199254.740991`); the maximum is exactly
9007199254.740991 USD and the conversion is integer-exact, never float.

### Saving, conflicts and retry

Saving submits the exact displayed `revision` as the CAS and the signed
account as `expected_principal` (a stale-account guard; the signed context is
the only authority). A `409` keeps your draft visible but disables Save until
you explicitly **Reload policy**, which discards the draft and loads the fresh
revision. Transient failures (503, network, malformed replies) keep the draft
and the stored request identity so resubmitting retries the *same* request;
changing the draft replaces the intent. Saves participate in the normal
publication pending indicator; there is no polling.

## Template model policy

Templates carry three optional policy members:

- `model_retry` — a custom `{max 0–8, base_ms 1–30000, cap_ms ≤30000}`. The
  platform default is 2 retries with a 200–30000 ms delay window; selecting
  Custom with `0` means no retries.
- `failover` — `never` or `before_output`; the default defers to the platform.
- `run_budget` — the same per-run cap shape as the organization policy.

Omitted members mean "platform default" and stay omitted in immutable history
— Console never backfills invented values. A stored policy shows under the
template's **Model call policy** section for both current and historical
revisions; changing it publishes a new revision, which only affects Agents
after an explicit rebuild. Existing runs and recorded attempts are never
rewritten.

Every actual model call still counts toward `max_model_requests`; policy caps
are admission bounds, not a substitute.

## Limitations

Component tests and local evidence cover the Console BFF, contracts and UI;
Controller→ACP/Docker budget enforcement acceptance is tracked separately and
is not claimed here.
