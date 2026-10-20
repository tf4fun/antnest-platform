# ACP HTTP Transport

This document describes the Streamable HTTP transport on `/v1/acp`: identity
binding, connection lifetime, limits and tracing.

## Contract

The v1 endpoint `/v1/acp` accepts the official SDK's Streamable HTTP transport
in addition to the WebSocket transport. `/v2/acp` accepts only WebSocket; the
draft v2 HTTP/batch transport is not implemented. HTTP itself is an
experimental ACP transport, not an additional stable v1 protocol requirement.
Client MCP injection remains disabled.

Connection IDs, POST message routing and GET SSE delivery belong to the official
SDK. The Node adapter validates JSON media type,
UTF-8, duplicate keys and body limits before handing a request to that SDK.
Antnest supplies the existing v1 Agent handler, bound to authorized platform
identity. There is no second application API or stdio subprocess bridge.

Every HTTP request requires verified Agent UI workload and an unchanged
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
initializations, SDK cleanup and unacknowledged retired connections. Unused HTTP connections expire
after five minutes without an active request. Open SSE receivers keep their
connection alive. DELETE, failed initialization and shutdown release transport
resources. Closing or expiring a transport never deletes a persisted Session
or cancels a durable Run. Reconnect uses initialize followed by session/load
or session/resume; SDK transport queues are not a durable replay journal.
After validating a known connection's empty DELETE body, the adapter calls the
SDK server's public `close()` once and joins its original result before sending
an empty 202. It does not first invoke SDK DELETE: that route removes its index
before asynchronous cleanup has completed. Concurrent admitted DELETE requests
share the same cleanup result, and closing the other responses must not destroy
their acknowledgements. A completed successful response releases the connection
ID; a later request for the released ID receives 404. Already admitted responses
remain owned and counted until they close, with the original fixed retirement
deadline and shutdown still able to abort them.
A rejected DELETE (for example, an oversized body) does not close the SDK
connection and must leave it usable.

When the SDK itself closes a known connection first, its original authorized
binding and cleanup result remain available for a fixed five-minute deadline.
Only a same-binding DELETE can acknowledge it; GET and POST return 404, another
binding returns 403, and unknown or expired IDs return 404. The complete DELETE
body is still checked: nonempty bodies return 400 and oversized bodies return
413 without consuming the acknowledgement. Cleanup failure returns 503 and
remains a failure on subsequent DELETE requests. The deadline does not restart
on reads, rejected bodies or repeated DELETE requests. Expiry removes the ID,
while pending cleanup continues to occupy capacity until it settles. Idle
expiry, failed initialization and forced shutdown cannot create a fresh receipt.
Normal process shutdown drains existing HTTP connections for at most five
seconds concurrently with WebSocket shutdown. It rejects new connections and
GET/POST work while closing existing streams. Only the original authenticated
same-binding DELETE may complete during that explicit drain despite readiness
being false; ordinary not-ready operation still rejects it. Complete empty-body
validation and actual cleanup-before-202 remain required, and cleanup failures
remain 503. Existing retirement deadlines are not renewed. The drain finishes
when all entries have joined, or forces response closure at its fixed deadline
and then joins pending cleanup before retiring the listener.
See the [shared retirement contract](../../../contracts/agent-acp/service-authentication.md#private-http-transport-retirement).

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

## Agent UI Integration

Agent UI calls the private ACP transports with its own workload credential and
the unchanged signed user context. Browser traffic reaches Agent UI through the
retained Gateway workspace Bridge; the old direct Gateway ACP routes and its ACP
caller grant are retired. The private v1 HTTP and v1/v2 WebSocket protocols remain
available to Agent UI. Official SDK protocol tests continue to exercise those
private transports. Browser business, cancellation and trace consumers must be
migrated to the Bridge and admitted in the explicit cross-service batch; earlier
direct-Gateway evidence does not establish that acceptance.

The following are platform boundaries, not transport defects: identity and
Provider authority stay outside ACP, the workspace is remote (Runtime-owned),
and Controller owns configuration and rebuild.
