# ACP HTTP Transport

This document describes the Streamable HTTP transport on `/v1/acp`: identity
binding, connection lifetime, limits and tracing.

## Contract

The v1 endpoint `/v1/acp` accepts the official SDK's Streamable HTTP transport
in addition to the WebSocket transport. `/v2/acp` accepts only WebSocket; the
draft v2 HTTP/batch transport is not implemented. HTTP itself is an
experimental ACP transport, not an additional stable v1 protocol requirement.
Client MCP injection remains disabled.

Connection IDs, POST message routing, GET SSE delivery and DELETE connection
closure belong to the official SDK. The Node adapter validates JSON media type,
UTF-8, duplicate keys and body limits before handing a request to that SDK.
Antnest supplies the existing v1 Agent handler, bound to authorized platform
identity. There is no second application API or stdio subprocess bridge.

Every HTTP request requires verified Gateway/UI workload and an unchanged
Identity-signed CCT with ACP audience and Agent scope. Signed claims supply the
organization, principal and Agent; raw identity hints grant nothing. See the
[authentication contract](../../../contracts/agent-acp/service-authentication.md).
A transport connection is bound to that immutable
tuple; ACP checks current access locally using the Controller-published execution
projection. There is no per-request Controller resolution. `Acp-Connection-Id`
is not a credential; another binding cannot read, write or close that connection.
`Acp-Session-Id` routes messages inside an already authorized connection and
does not replace application-level Session ownership checks.

Connection state is process-local and bounded to 1024 entries, including pending
initializations. Unused HTTP connections expire
after five minutes without an active request. Open SSE receivers keep their
connection alive. DELETE, failed initialization and shutdown release transport
resources. Closing or expiring a transport never deletes a persisted Session
or cancels a durable Run. Reconnect uses initialize followed by session/load
or session/resume; SDK transport queues are not a durable replay journal.
The SDK may close its connection before returning DELETE's 202 response. The
outer transport waits for that HTTP response to finish or disconnect before
releasing it; closure must not destroy its own acknowledgement.
A rejected DELETE (for example, an oversized body) does not close the SDK
connection and must leave it usable.

HTTP bodies use the existing ACP payload limit. Stream spans record metadata,
not frames. Registered parsed ACP requests/responses follow the content switch in
[observability](observability.md); the SDK continues to own HTTP/SSE parsing,
queues and streaming. HTTP SERVER lifetime ends at response completion or close,
not when headers become available. A telemetry-only adapter forwards the current
POST's actual SERVER context through standard ACP metadata across the SDK queue;
clients do not need to inject metadata or understand this internal handoff.
Null metadata is supported, unrelated metadata is preserved, and an old
traceparent/tracestate pair is replaced together rather than mixed with the
receiving HTTP context.

## Gateway Integration

Edge Gateway forwards authenticated POST/GET/DELETE requests on the v1 Agent
route with unbuffered SSE, protocol headers, origin checks and revocation.
Integration tests drive the real ACP Service through Gateway with the official
HTTP client (initialize, new, prompt, cancel and load) alongside the WebSocket
paths.

The following are platform boundaries, not transport defects: identity and
Provider authority stay outside ACP, the workspace is remote (Runtime-owned),
and Controller owns configuration and rebuild.
