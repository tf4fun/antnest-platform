# Agent Workspace Navigation

Console manages Agents; the independently deployed Agent UI presents ACP
Sessions. Both are hosted through Edge Gateway and share browser authentication.

An Agent detail page links to `/workspace/?agent=<encoded-id>` in a new tab.
Retained/deleted Agents do not advertise this action. The link conveys selection,
not authorization: Agent discovery and ACP still enforce the authenticated
principal's access. It never impersonates the owner or passes credentials.

Agent UI adds `&session=<id>` for Session navigation. After local login, Console
accepts only `/workspace/` with optional single `agent`/`session` query values.
External origins, other paths, duplicate parameters and control characters are
rejected. The URL is not a persistence layer for chats or execution state.

This batch changes only Console presentation/navigation. Existing Gateway
static hosting and ACP transport routes are reused; no Controller/ACP management
or execution method is added. Unit tests cover safe login destinations and a
component test asserts the per-Agent link without starting a lifecycle operation.
