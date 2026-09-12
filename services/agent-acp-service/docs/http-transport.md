# ACP HTTP transport

## Contract

The v1 endpoint `/v1/acp` accepts the official SDK's Streamable HTTP transport
in addition to the existing WebSocket transport. `/v2/acp` retains WebSocket;
this batch does not implement the draft v2 HTTP/batch transport. HTTP itself
remains an experimental ACP transport, not a claim of additional stable v1
protocol requirements. Client MCP injection remains disabled.

Like Goose `serve`, transport parsing, connection IDs, POST message routing,
GET SSE delivery and DELETE connection closure belong to the official SDK.
Antnest supplies the existing v1 Agent handler, bound to authorized platform
identity. There is no second application API or stdio subprocess bridge.

Every HTTP request requires the trusted `x-antnest-agent-access-subject` header
and current Agent Controller resolution. A transport connection is bound to
subject, principal, Agent and access revision. `Acp-Connection-Id` is not a
credential; another binding cannot read, write or close that connection.
`Acp-Session-Id` routes messages inside an already authorized connection and
does not replace application-level Session ownership checks.

Connection state is process-local and bounded to 1024 entries, including pending
initializations. Unused HTTP connections expire
after five minutes without an active request. Open SSE receivers keep their
connection alive. DELETE, failed initialization and shutdown release transport
resources. Closing or expiring a transport never deletes a persisted Session
or cancels a durable Run. Reconnect uses initialize followed by session/load
or session/resume; SDK transport queues are not a durable replay journal.

HTTP bodies use the existing ACP payload limit. Traces record request method,
protocol and outcome, never subjects or raw messages. Registered parsed ACP
requests/responses can emit bounded safe diagnostic projections as described in
[observability](observability.md); the SDK continues to own HTTP/SSE parsing,
queues and streaming. HTTP SERVER lifetime ends at response completion or close,
not when headers become available. Follow-on POST-to-SSE request correlation
without protocol `_meta` is an explicit SDK integration gap.

## Delivery batches

1. ACP Service: official SDK HTTP adapter, immutable binding, bounded lifecycle,
   real HTTP contract tests and PostgreSQL lifecycle/recovery regression.
2. Edge Gateway: authenticated POST/GET/DELETE forwarding on the v1 Agent
   route, unbuffered SSE, protocol headers, origin checks and revocation.
3. Integration: Gateway to real ACP Service with official HTTP client;
   initialize/new/prompt/cancel/load and existing WebSocket regression.

Each batch passes its local gates before the next service is modified.
A2 (identity/provider authority), A3 (remote workspace), and A4 (Controller
configuration/rebuild authority) are accepted platform boundaries, not defects.
