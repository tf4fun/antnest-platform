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
       -> PreviewClient (Vite development only)
```

The presentation model uses browser-safe IDs, labels, statuses, messages, and
tool summaries. ACP wire conversion and bounded Session pagination live in the
production transport adapter. Components do not fetch or open WebSockets
directly.

## Browser State

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
   an explicit page retry; no hidden polling loop invents state.
6. Tool activity is collapsed by default and keeps audit detail available on
   demand.
7. Images use ACP image blocks when advertised. Text files become bounded text
   blocks; other files require the advertised embedded-context capability. A
   browser attachment is limited to 4 MB.
8. A submitted user prompt appears locally before the blocking ACP request
   settles; a failed request triggers authoritative Session replay instead of
   leaving a guessed message behind.
9. A principal with no accessible Agent retains account exit and, for an
   administrator, a path back to Control Center.

## Failure Semantics

- `401` redirects to the Edge Gateway login entry.
- `403` shows that no usable Agent is available without leaking policy facts.
- transport loss keeps the current thread readable and disables submission;
- malformed server data fails the affected view instead of guessing defaults;
- reconnect is bounded and visible, then requires an authoritative refresh;
- development preview data cannot be enabled in a production build.

## Extension Rules

- Add protocol behavior behind `AgentUIClient`; do not place fetch calls in
  components.
- Add a visual token to the platform design language before redefining a shared
  color or control state.
- Keep Agent configuration and lifecycle actions in Admin Console.
- Keep Channel-specific affordances in Channel Gateway clients, not this UI.
- Do not add a database, server-side Session cache, or private Agent model here.
