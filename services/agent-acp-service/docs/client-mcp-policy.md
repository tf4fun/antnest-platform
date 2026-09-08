# MCP Trust And Injection Boundary

Status: client injection deferred from current closeout. Platform Runtime MCP
remains supported. This decision supersedes the proposed HTTP-only opt-in batch.

## Two Trust Sources

**Server-injected MCP** is chosen and configured by system administrators.
Antnest treats it as trusted platform configuration and reaches it through
Runtime, including Runtime-managed stdio children. Administrators own package,
command, endpoint, credential and data-access review. Trusted configuration is
not a technical claim that every MCP implementation is harmless.

**Client-injected MCP** is an additional untrusted tool source. Accepting client
commands or packages for server-side installation/execution could introduce
malicious code. Even a remotely hosted server with no locally installed code
can use tool descriptions, results or elicited actions to solicit sensitive
data or influence model behavior. HTTP does not remove this trust distinction.

Runtime isolation and network controls remain useful, but do not make client
tools trustworthy or eliminate prompt-injection/data-exfiltration risk. Do not
silently promote client Session input to platform Runtime configuration.

## Current Contract

- Only platform Runtime MCP tools are available to the Agent.
- Both ACP versions accept only an empty `mcpServers` list.
- Any nonempty HTTP/stdio/SSE/MCP-over-ACP list fails explicitly before Session
  writes, activation or replay; no client endpoint is contacted or command run.
- A retained client revision cannot be reused for a new Prompt or tool
  discovery/dispatch. Loading/resuming with `[]` clears the Session's active
  source reference without rewriting historical revisions or Run records.
- No client MCP capability or administrator enable switch is advertised.
- No HTTP-specific policy field, private RPC extension or transport proxy is
  introduced. Controller, Console and Runtime contracts remain unchanged.
- Stable ACP v1's client-stdio requirement remains a documented compatibility
  deviation, not a mandatory implementation acceptance item in this closeout.

## Future Direction

Administrators must explicitly authorize client tool injection under a defined
risk policy before it can be enabled. The business permission should govern
client injection, not an HTTP-only exception. Scope, revocation and feedback
will be designed together when the feature is scheduled.

MCP-over-ACP can carry client-provided tools over the existing ACP connection.
The client can own local stdio processes or remote HTTP connections while the
service owns logical MCP sessions and invocation routing. This simplifies the
server's transport responsibilities, not the trust decision. The
[proposal](https://agentclientprotocol.com/rfds/mcp-over-acp) is currently Draft;
implementation, SDK integration and the complete client feature are deferred.

## Acceptance In This Batch

Test rejection of every client source at new/load/resume/fork, no partial
persistence or replay, no capability advertisement, refusal of retained client
sources, and continued platform/managed-stdio Runtime tool execution. Negative
tests verify an honest boundary; they are not an obligation to implement the
deferred transports. Preserve the separate v1 lifecycle and recovery evidence.
