# Session Usage And Cost (F10)

This records the F10 contract and its historical acceptance evidence. The
browser ACP adapter and its tests were removed during the Node Bridge refactor;
current behavior is covered by Bridge view, projection and browser tests. See
the [current architecture](architecture.md).

Status: Agent UI service batch verified (2026-09-10). ACP, Controller and Console
pricing are implemented; deployed Gateway/ACP/Jaeger acceptance remains a separate
batch. This service does not calculate prices, persist usage or expose new APIs.

## Contract

Consume the installed official ACP v1 SDK's standard `usage_update`: `used` and
`size` are current context token counts, not lifetime token consumption;
`cost: {amount, currency}` is an optional cumulative Session amount. No private
receipt, catalog rate, Provider metadata or credential belongs in the view.

1. Keep one optional usage snapshot per Conversation. A valid cost replaces the
   previous cumulative amount; never add snapshots, take their maximum, sum
   different Sessions, or reprice based on the selected model.
2. Missing/null cost does not mean free. A context-only update retains the last
   valid known cost in this projection; without one it remains unknown. Explicit
   zero is known. Malformed context updates are ignored; invalid optional costs
   cannot replace a valid one or enter the DOM. Do not infer conversion between
   currencies. Validate bounded numeric shape at this adapter boundary.
   Context counts are nonnegative safe integers; zero capacity does not discard
   an otherwise valid cost, and usage may exceed capacity.
3. Authoritative `session/load` clears the old usage with the old messages
   before replay. Persisted updates rebuild the snapshot. A reloaded unpriced
   history must not retain a stale price. If replay fails, preserve the previous
   known usage where replay supplied none, without overwriting valid received
   updates; the existing history error remains visible. Duplicate cumulative
   notifications do not increase cost. Coalesce overlapping loads for the same
   Session because notifications have no load-request identity.
   Mark failed replay data as last received on that Conversation only; the next
   valid usage update clears this marker. Unrelated errors do not mark it stale.
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

No polling, new fetch, localStorage/sessionStorage or background timer is added.
The existing same-origin Gateway transport and official SDK remain the boundary.

## Verification

- Pure tests: cumulative replacement/duplicates, missing/null/zero, invalid
  numbers/currency, independent context and cost, metadata stripping, model
  changes, exact replay reset and bounded formatting without fake free rates.
- Official-SDK connection integration over in-memory streams: live updates,
  repeated replay, no-price reload, separate Sessions and connections,
  configuration notifications, failed prompt recovery and close cleanup.
  This is not a deployed WebSocket or external Provider test.
- App/component tests: active-chat selection, no cross-Agent leakage, no cost
  in messages, new/unknown/zero/known/last-received states and accessible labels.
- Serial full Agent UI tests, typecheck/build and repository fmt/lint; browser
  desktop/mobile inspection with synthetic data. Deployment tests follow this
  producer/consumer service sequence, not the browser fixture.

Producer semantics: [Session cost](../../agent-acp-service/docs/session-cost.md).

Final service results (2026-09-10):

- `npm test`: 56 tests passed, 36 pure and 20 component/SDK integration tests.
  F10 adds 19 tests: 5 pure, 12 real-SDK connection/App and 2 presentation tests.
  The SDK boundary uses synthetic in-memory WebSockets, not a mocked SDK.
- Node's built-in coverage for `src/lib/usage.ts`: 100% lines, branches and
  functions. This is coverage of that utility, not whole-service coverage.
- `npm run build` and repository `make -j1 fmt-check lint`: passed. Existing
  dependency annotation and bundled-chunk size warnings remain nonfatal; no
  threshold changes or suppression were added.
- Chrome: 1440x1000 and 320x760 synthetic preview; page width equals viewport,
  metrics wrap without clipping. Switching to unknown cost shows `Not reported`;
  a new chat has no usage row. Extreme-value and disconnected/replay states are
  covered by reusable component and connection tests.
- Two read-only reviews: zero-capacity cost, visible exact amount and scoped
  freshness fixes were re-reviewed without further concrete findings. Added
  tests cover pending replay at Agent switch, coalesced failure/retry and
  unrelated chat errors. Reviewers were closed; verification ran serially.

No deployed pricing chain, external Provider or Jaeger claim is made by this
batch. Those remain the F10 integration acceptance boundary.
