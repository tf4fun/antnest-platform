# Edge Gateway Contracts

This directory holds the browser-facing session contract owned by Edge Gateway.
`session-contract.json` defines the browser-session, administrator, and Agent
workspace routes plus the trusted headers Edge Gateway may inject into internal
services. It is a product-facing browser contract, not a public third-party
OpenAPI.

[Public entry](public-entry.md) defines native TLS, HTTPS proxy trust, public
Origin, client addresses, forwarding headers, HSTS and certificate rotation.

[Request header boundary](request-headers.md) and its [registry](request-headers.json)
define both reserved namespaces, per-route outbound allowlists, browser-local
inputs and server-injected fields. Revision 18 removes retired hints from the
trusted list and explicitly inventories internal credentials and response-only
metadata without making them browser exceptions.

## Workspace routes

Version 18 of `session-contract.json` includes the Node Workspace HTML, HTTP
API and SSE routes. Gateway authenticates HTML and business API requests, while
hashed static assets are served without a browser session. The browser uses
this route set instead of a direct ACP connection.

Revision 15 adds mandatory internal workload authentication and forwards an
unchanged Identity revision-14 CCT selected by the actual route. The entire
browser X-Antnest namespace and both authentication headers are removed; CSRF
is validated locally from private context. See
[service authentication](service-authentication.md) for Agent scope, TLS,
credential rotation, stream expiry and pending consumer batches. The identity
headers below remain presentation hints, not workload or user authentication.

Revision 16 adds shared Origin admission before every `/api/` route, including
admin and session endpoints. Mutations require matching public Origin or,
when Origin is absent, same-origin Fetch Metadata. Cross-site, same-site and
malformed metadata reject mutations even with matching Origin. The explicit
originless compatibility setting is off by default and never waives CSRF or
ACP WebSocket Origin checks. See [public entry](public-entry.md) for the complete
safe-method, header validation and compatibility rules.

Revision 17 defines Secure-mode `__Host-` cookies and CSRF bound to the stable
Identity token ID with an independent Gateway secret. See
[browser session security](session-security.md) for strict cookie reads, the
trusted issuer boundary, logout behavior, key provisioning and the separate
Admin-origin phase. Producer, browser consumers and integration have individual
admission gates; the shared contract alone does not activate this behavior.

For `/api/app/workspace/v1/{path...}`, Gateway strips every incoming
`X-Antnest-*` identity header and injects verified `X-Antnest-Organization-ID`,
`X-Antnest-Principal-ID`, `X-Antnest-User-ID`, `X-Antnest-Membership-ID` and
`X-Antnest-Administrator` values. When the path names an Agent
(`agents/{agent_id}/...`), Gateway also sets `X-Antnest-Agent-ID`; otherwise it
removes that header. The Agent UI Node Bridge rejects Agent-scoped requests
that lack the Organization, Principal or Agent header. POST requests require
the CSRF token independently of the shared Origin admission. GET requests
may omit Origin; any supplied Origin must match the configured public origin.

Identity access tokens are cookie-only secrets. Token IDs remain Identity audit
identifiers and are not stored in the browser session. Neither may appear in
the JSON response schemas described by this contract.

## Organization display projection

Browser login and session responses must pass
[`session-response.schema.json`](session-response.schema.json). Their principal
preserves Identity revision 13's required `organization_slug` and
`organization_name`. Missing, null, empty or whitespace-only metadata is an
unavailable Identity response, not a successful session or evidence of revocation.

Authenticated Workspace API and SSR HTML requests carry the exact labels in
`X-Antnest-Organization-Slug` and `X-Antnest-Organization-Name`, each encoded as
one canonical, unpadded Base64URL value over UTF-8. Gateway removes browser
values before injecting verified values; anonymous assets and other upstreams
receive neither header. See the shared
[Organization projection](../agent-ui/organization-projection.md) for decoding,
freshness and staged consumer activation. Labels do not confer authorization.

Gateway producer [#92](https://github.com/tf4fun/antnest-platform/issues/92)
precedes Node/SSR/frontend consumer
[#93](https://github.com/tf4fun/antnest-platform/issues/93). Only the latter
activates the new principal in the bootstrap wire schema and runs full UI
integration after both service admissions. The old `/api/app/bootstrap` is
unchanged; its retirement remains tracked by
[#64](https://github.com/tf4fun/antnest-platform/issues/64).

## Workspace state

Workspace state GET/SSE expose six ACP-owned fields: Agent ID, availability,
access permission, nullable configuration digest, nullable active Session ID
and nullable unavailability reason. Missing or revoked access returns a
sanitized offline view; source failure is never reported as an idle state.
The routes reject supplied scope and replay cursors. Identity determines the
User and Organization; ACP determines Agent access and Session disclosure.
Subscriptions have a bounded authentication lease and never renew inside
Gateway. See [Workspace state](../../services/edge-gateway/docs/workspace-state.md)
for response validation, revocation, shutdown and client recovery requirements.

## OIDC and SCIM

OIDC discovery/start and callback routes bridge Identity Service into the
browser session boundary. The callback consumes Identity's one-time access
token server-side, sets the normal session cookies, and redirects without
placing credentials, state, or authorization codes in browser-visible JSON or
locations. Unknown OIDC paths fail closed and never reach the Console SPA.

SCIM requests pass through to Identity Service with their protocol Bearer
credential intact. Browser cookies and forged trusted-principal headers are
removed; Identity remains the sole SCIM authentication and business authority.

## ACP routing

Workspace bootstrap returns only Agent ID and name discovery metadata from
Controller. It does not aggregate execution availability. Protocol and state
requests go directly to ACP with trusted Organization, Principal and Agent
headers, without a Controller lookup. Incoming identity headers, including the
retired access subject, are removed. See
[Execution boundary](../../services/edge-gateway/docs/execution-boundary.md)
for the Gateway side of the Controller/ACP split.

## WebSocket relay

After upgrade, Edge terminates both WebSocket hops and relays opaque complete
messages using the Gorilla WebSocket library. The upgrade requires a
same-origin request. Before each client data message is forwarded, Identity
resolves the original cookie token again; its active User, Organization and
Membership must match upgrade admission. Revoked, expired or mismatched
identity closes both hops with 1008. An unavailable Identity closes with 1013
and never forwards the waiting message. No cookie is changed after upgrade;
reconnect uses normal HTTP authentication.

This applies to v1, v2 and the v1 alias without inspecting JSON methods, IDs or
envelopes. Replies and notifications are also client data messages. Ping/pong
are hop-local transport events. Payloads are bounded to 64 MiB per complete
message, with one in-flight message per direction and bounded socket writes.
ACP may impose a lower configured input limit. No prompt, payload or credential
is recorded by the relay; admission checks retain the Gateway trace context.

The check is the admission point, not a distributed revocation transaction:
messages already admitted can finish, and an idle connection is not polled.
Server output for admitted work may continue until another client message or
disconnection. Closing a socket does not cancel a durable Run. ACP continues to
own Agent and Session authorization. No Identity or ACP RPC contract or
database exists for browser session revalidation.

Per Gateway process, 64 upgraded or admitting connections and four buffered
data messages bound relay concurrency (including Identity calls). Permits are
taken after a message header is available, so idle sockets do not consume
payload capacity. Permit waits and writes use the dependency timeout; a started
message has an absolute one-minute assembly deadline after a buffer slot is
acquired, unaffected by ping/pong. Capacity failure closes with 1013 (HTTP 503
before upgrade). Compression is disabled on both hops. These are live-work
bounds, not an RSS guarantee or per-user quota. A structurally invalid Identity
resolution is unavailable (1013), not evidence of revocation. Checks
overlapping revocation can authorize a message even if its eventual ACP intent
or Run is created after the revocation response.
