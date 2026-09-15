# Session Workspace Refactor

## Boundary

Agent UI remains an independently built static service hosted at `/workspace/`
behind Edge Gateway. It has no database, Agent configuration authority, Provider
credentials, Runtime endpoint or direct Controller/ACP service address.

Navigation is Agent -> ACP Session. There are no projects or user-selectable
working directories. ACP new/load always send `cwd: "/workspace"` and
`mcpServers: []`. Controller owns configuration, lifecycle and ownership;
ACP owns admission, Session persistence, execution, permissions and updates.

## Navigation Contract

1. `/workspace/` displays the Agent chooser; discovery never implicitly selects
   or connects to the first Agent, including accounts with one Agent.
2. `/workspace/?agent=<id>` opens an accessible Agent and a new-conversation
   view. It creates no Session until the user creates one or sends input.
3. `/workspace/?agent=<id>&session=<id>` loads that ACP Session. Failed load
   keeps the route and shows an error, never a different Session.
4. Refresh and Back/Forward restore selection only, never resend a prompt.
   URLs contain identifiers, not credentials or message contents.
5. Console links to the same Agent URL. Login preserves a validated Workspace
   return path and rejects arbitrary external return destinations.

Discovery checks Agent selection; ACP independently authorizes Agent and
Session access. A URL grants no authority. Cached history and drafts are scoped
by identity, Agent and Session. Closing a connection never cancels server work.

## ACP Presentation

Use the official SDK adapter and stable `/v1/acp` route. Preserve streaming text,
thought disclosures, ordered tool activity, plans, server configuration, usage
and permissions. No private conversation CRUD API or visible Run identifiers.

Borrow attyd's searchable Session history, readable message width, compact
controls, collapsed tool details, copy and follow-output scrolling. Do not copy
its project browser, process management or client MCP configuration.

The existing Gateway execution-state stream is read-only observation for busy,
access and Stop targeting across connections. ACP produces it, not Controller.
It cannot mutate configuration or persist conversations. Consume the current
`configuration_revision` and `unavailable_reason`, not obsolete `agent_revision`.
Metadata-only bootstrap does not report availability. Healthy streams are not
polled; reconnect/load never retries prompts.

## Delivery And Acceptance

1. Agent UI-owned batch: contracts, chooser/routes, Session presentation, ACP
   projection and unit/component tests. Check unknown/deleted Agents, failed
   Session load, reconnect, cross-Agent draft isolation and late callbacks.
2. Console-owned batch: per-Agent link and safe login return with route and
   component tests. Controller/ACP implementations remain unchanged.
3. Integration batch: current Gateway contract, official SDK interaction and
   desktop/mobile browser checks. Preview is not deployed execution evidence.

Input requires synchronized history and execution state. Cancel is not treated
as completion; page re-entry can stop an existing owned operation. No project
hierarchy or Runtime configuration is exposed. All tool details start collapsed;
new output must not interrupt a user reading earlier content.

Report completion from actual checks, not this checklist alone. This work does
not reopen Controller/ACP refactoring or change `OBS-ACP-CLOCK` acceptance.
