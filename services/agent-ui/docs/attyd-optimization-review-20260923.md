# attyd optimization review for Agent UI

Date: 2026-09-23. Compared with upstream `tf4fun/attyd` `main` at
[`754ac14`](https://github.com/tf4fun/attyd/commit/754ac145ab6d8a3437655e778f7a06fb04aa7239),
verified against the remote branch head on this date.

| Upstream change | Agent UI decision |
| --- | --- |
| Session opening skeleton and process presentation (`754ac14`) | Show an accessible loading status and inert visual placeholders only for an uncached selected Session. Keep the existing composer mounted but disabled, because its draft and attachments belong to the selected Session. A cached transcript remains readable during replay. |
| Lazy completed-turn process and five-minute folded retention (`2d1ed94`) | Avoid constructing process-message DOM for unopened completed turns. Preserve expanded/live process details while reading, then release folded DOM after five minutes. Reopening builds it from the existing Session projection. The prompt, final answer, notices, failure count and disclosure stay visible. |
| Compact HTTP projection and paged process API (`2d1ed94`) | A Node Bridge can build compact views and process pages from existing ACP replay; a new ACP history-page API is not a prerequisite. This needs a new UI HTTP contract and authenticated Gateway routing. The present UI optimization does **not** shrink ACP notifications, client Session data or server memory. See the proposed [full-stack refactor](fullstack-bridge-refactor.md); upstream replay-volume reduction is separate work. |
| HTTP JSON request deadlines (`2d1ed94`) | attyd's HTTP Bridge request/turn contract does not map directly to Agent UI's ACP WebSocket `session/prompt` lifecycle. A generic 30-second timeout could falsely present a still-running Run as failed. Any deadline change needs separate ACP admission and reconciliation semantics. |
| Delivery watermarks and optional history retry ownership (`802c20b`, `0857250`) | These are attyd Rust Bridge ownership changes. Agent UI has no corresponding delivery queue; its current authoritative replay and reconnect contracts remain in place. |

Test-first regressions cover first-load placeholder, disabled draft-preserving
composer, on-demand process mount and five-minute release/reopen. The Agent UI
unit/component suite, typecheck, production build and wire-fixture Chromium
integration pass. The browser profile includes a held `session/load` response
and a mobile-width visual check. This evidence is for the Agent UI service and
its browser integration, not a new deployed Stage 3 acceptance run.
