# Session Usage And Cost

This document describes how Agent UI projects and displays ACP context usage
and cumulative Session cost. The Node Bridge consumes ACP usage updates and
exposes them through authorized Agent and Session Views (see
[architecture](architecture.md)). Agent UI does not calculate prices, persist
usage or expose a separate usage API.

## Contract

The Bridge consumes the official ACP v1 SDK's standard `usage_update`: `used`
and `size` are current context token counts, not lifetime token consumption;
`cost: {amount, currency}` is an optional cumulative Session amount. No private
receipt, catalog rate, Provider metadata or credential belongs in the view.

1. Keep one optional usage snapshot per Conversation. A valid cost replaces the
   previous cumulative amount; never add snapshots, take their maximum, sum
   different Sessions, or reprice based on the selected model.
2. Missing/null cost does not mean free. A context-only update retains the last
   valid known cost in this projection; without one it remains unknown. Explicit
   zero is known. Malformed context updates are ignored; invalid optional costs
   cannot replace a valid one or enter the DOM. Currency conversion is never
   inferred. Bounded numeric shape is validated at the adapter boundary.
   Context counts are nonnegative safe integers; zero capacity does not discard
   an otherwise valid cost, and usage may exceed capacity.
3. Authoritative `session/load` clears the old usage with the old messages
   before replay. Persisted updates rebuild the snapshot. A reloaded unpriced
   history does not retain a stale price. If replay fails, the previous known
   usage is preserved where replay supplied none, without overwriting valid
   received updates; the existing history error remains visible. Duplicate
   cumulative notifications do not increase cost. Overlapping loads for the
   same Session are coalesced because notifications have no load-request
   identity. Failed replay data is marked as last received on that Conversation
   only; the next valid usage update clears this marker. Unrelated errors do
   not mark it stale.
4. Model/mode changes, prompts, tool updates and permission requests preserve
   the Session's existing cost. Failure/cancellation does not imply no model
   usage. Reconnect uses a new connection and replay, not browser storage.
5. Agent and Session identity together scope view selection. Switching chats
   cannot display another chat's cost; late notifications remain under their
   originating connection and Session. New Sessions start without usage. Forked
   Sessions show their server-supplied baseline independently, not a billable
   sum of parent and child histories.

## Presentation

A compact, wrapping Session usage row stays outside message history. It labels
the context counts and `Known cost`, with `Not reported` for unknown cost and a
short incomplete-accounting qualifier. Before the first usage event it is absent.
Disconnected displays are marked as last received. Positive tiny amounts never
round to zero; JavaScript's shortest round-trip number representation uses
scientific notation for extreme values. The exact received numeric value is
visible text, not hidden behind a hover-only tooltip. No invoice,
remaining balance or billing completeness is implied.

There is no polling, separate fetch, localStorage/sessionStorage or background
timer for usage. The same-origin Gateway transport remains the boundary.

## Testing

- Pure tests (`src/lib/usage.ts`): cumulative replacement/duplicates,
  missing/null/zero, invalid numbers/currency, independent context and cost,
  metadata stripping, model changes, exact replay reset and bounded formatting
  without fake free rates.
- Bridge view and projection tests: live updates, repeated replay, no-price
  reload, separate Sessions and connections, configuration notifications,
  failed prompt recovery and close cleanup.
- Component tests: active-chat selection, no cross-Agent leakage, no cost in
  messages, new/unknown/zero/known/last-received states and accessible labels,
  pending replay at Agent switch, coalesced failure/retry and unrelated chat
  errors.
- `make e2e-session-cost` exercises the deployed pricing chain.

Producer semantics: [Session cost](../../agent-acp-service/docs/session-cost.md).
