# Agent UI Architecture

## Purpose

Agent UI converts an authenticated principal's accessible Agents and ACP
Sessions into one conversation workspace. It is a presentation service, not a
browser-hosted Agent Core.

## Module Map

```text
App
  -> presentation state and routing
  -> components (navigation, conversation, activity, composer)
  -> AgentUIClient port
       -> GatewayClient (production bootstrap)
            -> GatewayAgentConnection (official ACP v1 SDK over WebSocket)
            -> EventSource (scoped Gateway state snapshots)
       -> PreviewClient (Vite development only)
```

The presentation model uses browser-safe IDs, labels, statuses, messages, and
tool summaries. ACP wire conversion and bounded Session pagination live in the
production transport adapter. Components do not fetch or open WebSockets
directly.

## Browser State

Session configuration is rendered from ACP `configOptions` on new/load and
`config_option_update`; selections use `session/set_config_option`, with no
optimistic policy change. Choices affect later Runs, not an active Run snapshot.

Session usage is projected from standard `usage_update`, separately from message
history. Context counts are current capacity/use, not cumulative tokens; optional
cost is cumulative known cost, not an invoice. Replay clears the old projection;
failed replay retains last received values with a per-Conversation freshness
marker. Concurrent loads of the same Session share one replay. Agent and Session
IDs together scope selection; no browser storage or local price calculation is
involved. See [Session usage](session-usage.md) for validation and failure rules.

Tool permissions use `session/request_permission`, separate from messages.
The connection owns transient pending requests; the UI offers only the server's
options with exact tool arguments. Always means this Session, never the Agent.
Answering removes that request, not the server's execution lock. Cancellation,
connection close and replacement remove stale buttons. A reload loads the
Session and receives a fresh approval request from the server; browser storage
never persists approval authority. Requests remain visible when switching chats.

```text
bootstrap: loading -> ready | unavailable
connection: connecting -> ready | offline
conversation: idle -> submitting -> streaming -> idle | failed
```

Agent Controller remains authoritative for Run admission. A busy Agent disables
new submission across all of its conversations. Closing or reopening the page
must eventually recover that state from the Gateway rather than trusting local
state.

Draft text, selected attachments, sidebar visibility, expanded tool details,
and the active local route are presentation state. Sessions, messages, Agent
busy state, and tool results are server facts and must not be treated as
durable because they appeared in browser memory.
User and Organization IDs from bootstrap are retained only as the in-memory
identity boundary for cached history. A change discards private presentation
state and replaces ACP; overlapping Agent IDs cannot retain the old identity.

Historical message updates do not carry a standard original message timestamp
in the supported ACP profile. Replay therefore leaves that timestamp unknown
and the UI omits it; the current receipt time is not substituted. Live local
submission and live first-chunk receipt may retain their observed time. Replaying
message or Tool content also preserves the Session's known `updatedAt` rather
than moving old conversations to the top. An explicit ACP Session metadata
timestamp remains authoritative, during both replay and live delivery.

## Production Invariants

1. The application calls same-origin `/api/app/*` routes only.
2. JavaScript never receives `agent_access_subject`, provider credentials,
   internal RPC addresses, Runtime endpoints, or MCP credentials.
3. Edge Gateway authenticates before returning bootstrap data or upgrading an
   ACP WebSocket.
4. ACP v1 is the stable default. Draft ACP v2 may be offered explicitly but
   never silently substituted.
5. A fresh connection obtains authoritative Session and Agent state before
   enabling the composer. Transport loss keeps the thread readable and requires
   bounded read-only recovery or explicit retry; no polling loop invents state.
6. Tool activity is collapsed by default and keeps the complete received audit
   detail available on demand. Expanded output preserves line breaks, wraps long
   tokens and scrolls vertically rather than silently clipping text. The UI does
   not remove output bytes; upstream truncation markers remain visible. The
   summary identifies execution status rather than copying the first output line. Tool text is
   rendered literally, never as executable HTML.
7. Attachments use negotiated standard content: images, WAV/MP3 audio and PDF
   resources; UTF-8 files use embedded text or the baseline plain-text fallback.
   Native audio/PDF and embedded text are limited to 1 MiB, other supported
   browser files to 4 MiB. Unknown binary formats are rejected. See
   [multimodal input](multimodal-input.md) for exact capability and replay rules.
8. A submitted user prompt appears locally before the blocking ACP request
   settles; a failed request triggers authoritative Session replay instead of
   leaving a guessed message behind.
9. A principal with no accessible Agent retains account exit and, for an
   administrator, a path back to Control Center.

## Failure Semantics

### Conversation Recovery And Cancellation

The transport being ready does not mean the selected Session has finished
loading. The composer and Session settings remain closed until that Session's
load succeeds. A failed load keeps the last readable transcript and offers an
explicit retry; late completion of a different Session cannot unlock the view.

Stop targets the Session of the outstanding prompt, or the scoped active Session
from state observation after page re-entry, not the Session currently selected
in the sidebar. Switching conversations is a read operation and must
not replay over a live prompt stream on the same connection. A cancel
notification is not completion: submission stays closed until the prompt settles
and a fresh Gateway state snapshot permits work. A notification is only a request,
not proof of cancellation. Cross-connection termination needs deployed acceptance.
Before the prompt has reached ACP (for example while reading an attachment),
Stop cancels local preparation and prevents the later prompt request entirely.

Refresh workspace reloads accessible Agents, reconnects ACP, and loads the
selected Session. It never sends a prompt. The existing transcript remains
readable during transport loss; inaccessible Agents are removed after the
authoritative refresh. Local completion or error does not assign `ready` to an
Agent. Current-Agent availability comes only from the validated state subscription;
bootstrap summaries cannot overwrite it. Subscription failure marks it unknown
and recovers through authenticated bootstrap with backoff, not periodic polling.
ACP failure has its own bounded reconnect path. See [Workspace state](workspace-state.md).
Revision changes, busy-to-ready transitions and missed-observation recovery
refresh Session list, history and configuration at idle by replacing ACP. The
pending recovery waits for a local prompt to settle; it never replays over it.
Real Docker/browser/Jaeger cross-connection acceptance remains a separate C4 batch.
Starting an explicit refresh immediately disposes the prior connection attempt,
including one whose initialization has not returned. Late callbacks cannot
reopen the composer after a failed refresh or replace the user's newer Session
selection. Cached history is scoped to both Agent and Session IDs; a successful
empty replay still replaces it with an empty transcript.

- `401` redirects to the Edge Gateway login entry.
- `403` shows that no usable Agent is available without leaking policy facts.
- transport loss keeps the current thread readable and disables submission;
- malformed server data fails the affected view instead of guessing defaults;
- automatic read-only reconnect uses a visible 1-30 second bounded backoff,
  not a fixed retry count; manual refresh remains available and neither path
  replays a prompt or polls while the subscription is healthy;
- development preview data cannot be enabled in a production build.

## Extension Rules

- Add protocol behavior behind `AgentUIClient`; do not place fetch calls in
  components.
- Add a visual token to the platform design language before redefining a shared
  color or control state.
- Keep Agent configuration and lifecycle actions in Admin Console.
- Keep Channel-specific affordances in Channel Gateway clients, not this UI.
- Do not add a database, server-side Session cache, or private Agent model here.
