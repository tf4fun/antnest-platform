# Edge Gateway Contracts

`session-contract.json` defines the Stage 3 browser-session, administrator, and
Agent workspace routes plus the trusted headers Edge Gateway may inject into
internal services. It is a product-facing browser contract, not the future
third-party OpenAPI.

Identity access tokens are cookie-only secrets. Token IDs remain Identity audit
identifiers and are not stored in the browser session. Neither may appear in
the JSON response schemas described by this contract.

Workspace state GET and SSE expose only five fields: Agent ID, availability,
access permission, Agent aggregate revision and nullable active Session ID.
They reject caller-provided scope and replay cursors. Identity determines
User/Organization; Controller determines Agent access and Session disclosure.
Subscriptions have a bounded authentication lease and never renew inside
Gateway. See [Workspace state](../../services/edge-gateway/docs/workspace-state.md)
for response validation, revocation, shutdown and client recovery requirements.

OIDC discovery/start and callback routes bridge Identity Service into the
browser session boundary. The callback consumes Identity's one-time access
token server-side, sets the normal session cookies, and redirects without
placing credentials, state, or authorization codes in browser-visible JSON or
locations. Unknown OIDC paths fail closed and never reach the Console SPA.

SCIM requests pass through to Identity Service with their protocol Bearer
credential intact. Browser cookies and forged trusted-principal headers are
removed; Identity remains the sole SCIM authentication and business authority.

Agent workspace bootstrap responses contain browser-safe Agent facts only.
Edge resolves the selected Agent again during WebSocket admission and injects
its opaque access subject into the ACP upstream request; that subject is never
returned to JavaScript or accepted from an incoming browser header.

After upgrade, Edge terminates both WebSocket hops and relays opaque complete
messages using the existing Gorilla WebSocket library. Before each client data
message is forwarded, Identity resolves the original cookie token again; its
active User, Organization and Membership must match upgrade admission. Revoked,
expired or mismatched identity closes both hops with 1008. An unavailable
Identity closes with 1013 and never forwards the waiting message. No cookie is
changed after upgrade; reconnect uses normal HTTP authentication.

This applies to v1, v2 and the v1 alias without inspecting JSON methods, IDs or
envelopes. Replies and notifications are also client data messages. Ping/pong
are hop-local transport events. Payloads are bounded to 64 MiB per complete
message, with one in-flight message per direction and bounded socket writes.
ACP may impose a lower configured input limit. No prompt, payload or credential
is recorded by the relay; admission checks retain the Gateway trace context.

The check is the admission point, not a distributed revocation transaction:
messages already admitted can finish, and an idle connection is not polled.
Server output for admitted work may continue until another client message or
disconnection. Closing a socket does not claim to cancel a durable Run. Agent
Controller/ACP continue to own Agent and Session authorization. No Identity or
ACP RPC contract or database is added for browser session revalidation.

Per Gateway process, 64 upgraded/admitting connections and four buffered data
messages bound relay concurrency (including Identity calls). Permits are taken
after a message header is available, so idle sockets do not consume payload
capacity. Permit waits and writes use the dependency timeout; a started message
has an absolute one-minute assembly deadline after a buffer slot is acquired,
unaffected by ping/pong. Capacity
failure closes with 1013 (HTTP 503 before upgrade). Compression is disabled on
both hops. These are live-work bounds, not an RSS guarantee or per-user quota.
A structurally invalid Identity resolution is unavailable (1013), not evidence
of revocation. Checks overlapping revocation can authorize a message even if
its eventual ACP intent or Run is created after the revocation response.
