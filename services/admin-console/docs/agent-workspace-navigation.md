# Agent Workspace Navigation

Console manages Agents; the independently deployed Agent UI presents ACP
Sessions. Both are hosted through Edge Gateway and share browser authentication.

An Agent detail page links to `/workspace/<encoded-agent-id>/` in a new tab.
Retained/deleted Agents do not advertise this action. The link conveys selection,
not authorization: Agent discovery and ACP still enforce the authenticated
principal's access. It never impersonates the owner or passes credentials.

Agent UI uses `/workspace/<encoded-agent-id>/sessions/<encoded-session-id>`
for Session navigation. After local login, Console accepts the directory,
Agent and Session paths in the [shared navigation contract](../../../contracts/agent-ui/workspace-navigation.md).
External origins, unknown path shapes, query values, fragments, dot segments and
control characters are rejected. Each ID is decoded and encoded as one segment;
encoded separators cannot change the route hierarchy. The URL is not a
persistence layer for chats or execution state.

This batch changes only Console presentation/navigation. Existing Gateway
Node hosting and ACP transport routes are reused; no Controller/ACP management
or execution method is added. Unit tests cover safe login destinations and a
component test asserts the per-Agent link without starting a lifecycle operation.
