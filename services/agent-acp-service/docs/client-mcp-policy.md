# MCP Trust And Injection Boundary

This document describes which MCP tool sources an Agent can use and why
client-injected MCP servers are rejected. Platform Runtime MCP is supported;
client MCP injection is not implemented.

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
- Loading/resuming an unchanged source list reuses its revision and preserves
  the Session's `updated_at`, including reactivation after close. Opening history
  is not a modification. A changed source list creates a revision and updates
  modification time; new messages and explicit configuration changes retain
  their existing timestamp updates. Session list ordering reflects modifications,
  not the most recent view.
- No client MCP capability or administrator enable switch is advertised.
- No HTTP-specific policy field, private RPC extension or transport proxy is
  introduced. Controller, Console and Runtime contracts remain unchanged.
- Stable ACP v1's client-stdio requirement remains a documented compatibility
  deviation.

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

## Test Coverage

Tests cover rejection of every client source at new/load/resume/fork, absence
of partial persistence or replay, absence of capability advertisement, refusal
of retained client sources, and continued platform and managed-stdio Runtime
tool execution. These negative tests verify the boundary; they do not imply
that the deferred transports will be implemented.
