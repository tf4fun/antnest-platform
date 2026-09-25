# Historical browser acceptance migration

Superseded on 2026-09-25 by the Node Bridge C4 HTTP/SSE browser profile.
The former `browser-run.mjs` entry now invokes C4; the contract below is
preserved as historical migration evidence.

The former `browser-run.mjs` manual finish loop becomes a repeatable Chromium
profile, `make e2e-workspace-browser`. Preserve the existing manual-control/model
assets until final consumer cleanup. This batch owns acceptance scripts only.
The later [finish-helper retirement](../../../docs/browser-finish-retirement.md)
removes the unused manual-input export while preserving the shared byte/model
assets and their current consumers.

Use current Foundation deployment, Provider connections, stable Model IDs and
immutable Template revisions/images. A vision-capable controlled model validates
the exact old four prompts: bash append, read, text/image attachments and mobile
conversation. Preserve exact workspace bytes and six Provider calls.

Use actual Agent UI controls. Check collapsed Tool activity, expanded output,
attachment previews, unsupported-file feedback, reload with exactly one copy of
history/attachments, and a distinct mobile Session with readable text, 44px
controls and no horizontal overflow. Save private desktop/mobile screenshots
and inspect them. The model peer is the only controlled business dependency;
no SDK-only substitute or mocked ACP/Runtime is allowed.

Record actual Chromium WebSocket handshake Trace IDs and JSON-RPC request IDs,
including fresh load requests. Replay must preserve public Run/event audits and
the model ledger. Validate all four Run snapshots and actual Runtime process
bindings; no-Tool prompts must have no Tool dispatch. Collect full request traces
after browser closure and normal producer flush. Do not invent parents or suppress
strict errors/timing warnings. Explicit Delete and owned-project cleanup follow.

Unit/contract negative fixtures precede implementation; run localhost component,
real Docker/browser, shared-script and existing C4 browser regression serially.
Existing C4 cancellation/rebuild/revocation scope, real-provider development
drivers and historical crash assets remain independent evidence.
