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

Entering a new-conversation route automatically prepares one empty ACP Session
after connection and execution readiness. Its URL replaces the blank route;
reload loads that Session instead of creating another. Preparation preserves
unsent text and attachments and performs no model call. Provider grouping and
thinking levels come only from ACP `configOptions`; switching models refreshes
the complete option set via the response/`config_option_update`. No UI-owned
provider catalog or credential selection is introduced. The existing create/send
path has no separate settings activation. Pending creation/configuration
disables sending; failures retain the draft and permit explicit retry through
New conversation, never an automatic creation loop. Late responses cannot
override navigation or a replaced connection. The compact composer pickers show
current values directly, with grouped, searchable model choices, keyboard
navigation, selected marks and viewport-bounded popovers, following attyd.

1. `/workspace/` displays the Agent chooser; discovery never implicitly selects
   or connects to the first Agent, including accounts with one Agent.
2. `/workspace/?agent=<id>` opens an accessible Agent and a new-conversation
   view. Once ready, it prepares a Session and replaces the URL with its ID.
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

### Conversation Reading Model

Follow attyd's `timeline-turns`, `turn-presentation` and conversation disclosure
behavior, not just its sidebar. A pure presentation projection groups messages
between user prompts. It never rewrites ACP history, invents Run IDs or stores
disclosure state outside the current page.

- User prompts and replies share a left-aligned reading column without bubbles,
  avatar tiles or per-event sender headers. Each exchange labels the Agent once.
- Live exchanges show messages and compact tool rows in their original order.
  Tool details and reasoning start collapsed. A tool update keeps the user's
  disclosure choice instead of remounting its row.
- Settled exchanges keep the latest answer outside a single collapsed Process
  disclosure; intermediate text, reasoning and tools remain accessible inside.
  A tool after the latest text means that text is still intermediate, not a final
  answer. Tool failures remain signaled on the collapsed summary; absence of an
  answer is not displayed as success. System notices stay outside the disclosure.
- Earlier exchanges settle at the next user prompt. The latest one folds only
  after synchronized history and execution observation establish it is idle.
  A different Session's active work must not keep this Session's history live;
  an offline connection is not completion evidence.
- Auto-folding waits while the reader is scrolled up. Manual disclosure pauses
  auto-follow so expanding a long process does not jump to its bottom. Live
  updates preserve explicit expansion; changing Agent/Session resets page-local
  disclosure state. Reload starts settled history folded without resending input.
- Markdown headings, code, tables and attachments stay within the reading column
  on desktop and mobile. Copying an answer excludes reasoning and tool output.

Verification includes pure grouping tests, component tests for live-to-settled
folding and scroll/disclosure behavior, and deterministic ACP browser fixtures
covering streaming, multiple tools, replay, narrow viewports and complete output.

### Composer And Reading Hierarchy

- Like attyd, the composer groups attachment, server-provided Model/Mode
  selectors, context usage, expand/collapse editing, and Send/Stop in one tool
  surface. Configuration is not a separate full-width strip above the history.
- Selectors keep ACP option groups and values; they never invent modes or model
  choices. A pending configuration change, unsynchronized history, unavailable
  Agent or active execution keeps editing controls disabled. Stop remains tied
  to the existing execution observation and permission checks.
- Usage is a compact disclosure with received context tokens and known cost.
  Missing cost remains unknown; stale or incomplete data remains labeled. Escape
  and outside clicks dismiss the disclosure. Expansion changes textarea space,
  not the draft, attachments, Session or prompt submission.
- Numbered exchange dividers separate user requests, not internal model/tool
  turns. User and Agent names use distinct high-contrast text accents. Messages
  remain flat and left-aligned; process folding is unchanged.
- Desktop and narrow-screen checks cover grouped controls, pending changes,
  disclosure bounds, editor expansion, and Send/Stop visibility.

### Disclosures And Tool Details

The Process entry is a bounded, full-width disclosure control, not another
message or a container card. Its expanded content remains unframed. Individual
tool calls use one card each, with a compact header (tool kind, title, status,
disclosure) and internal Input/Output bands rather than nested cards. Raw output
is selectable, wrapped, scrollable, and never interpreted as HTML or Markdown.
Missing output is labeled explicitly, including while a tool is still running.

Copy controls for prompts, answers and tool payloads share one presentation and
report success/failure without changing disclosure state. All disclosure and
toolbar controls have consistent hover, focus, selected and disabled feedback;
keyboard activation remains native. Input/Output payloads and the existing ACP
projection are unchanged by these presentation refinements.

Thinking disclosures share the tool card's frame, header dimensions, icon box,
chevron and interaction states. Their expanded Markdown uses a padded body with
a top separator, not the old indented quotation rail. Thinking stays collapsed
by default and preserves manual expansion as streamed content changes. Tests
compare the computed tool/Thinking card styles in addition to disclosure behavior.

The existing Gateway execution-state stream is read-only observation for busy,
access and Stop targeting across connections. ACP produces it, not Controller.
It cannot mutate configuration or persist conversations. Consume the current
`configuration_revision` and `unavailable_reason`, not obsolete `agent_revision`.
Bootstrap reports Controller lifecycle, activation and Runtime state, not ACP
execution availability. These management facts remain separate from admission
and never unlock input. Healthy streams are not
polled; reconnect/load never retries prompts.

## Delivery And Acceptance

### Connection, Catalog And Replay

- ACP initialization establishes transport readiness without waiting for
  `session/list`. The directory requests one page at a time, offers Load more
  and a local retry, and never treats a directory failure as a disconnected
  Agent. A selected Session can load and chat while its directory is pending.
  Repeated cursors are rejected without discarding previously loaded pages;
  there is no cumulative page-count cutoff. Search filters loaded conversations.
- Catalog metadata must not overwrite live messages, usage, configuration or a
  newer title/time. Catalog responses belong to one connection; replacing that
  connection invalidates pending UI updates and pagination state.
- A load owns an isolated replay candidate indexed by message/tool ID. Updates
  fold incrementally without copying the full transcript or publishing it for
  every historical notification. Only a successful matching response installs
  the candidate. Failure retains the previous transcript and marks retained
  usage stale; received usage/configuration facts retain their existing rules.
- Connection closure stops new requests. Accepted final notifications and a
  completed prompt response must survive an immediately following close; an
  interrupted prompt is not retried on the closed transport. Recovery opens a
  new authenticated connection and reads history, never resubmits the prompt.
- Regression coverage includes delayed/failed/paginated catalogs, repeated
  cursors, directory responses racing a live conversation, large replay with
  bounded publication count, failed replay, stale connection callbacks and
  final-response/close ordering. These are client tests using the real SDK and
  synthetic transport boundaries, not external Provider evidence.

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
