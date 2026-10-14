# Edge Gateway Contracts

This directory holds the browser-facing session contract owned by Edge Gateway.
`session-contract.json` defines the browser-session, administrator, and Agent
workspace routes plus the trusted headers Edge Gateway may inject into internal
services. It is a product-facing browser contract, not a public third-party
OpenAPI.

The [workspace entry retirement contract](workspace-entry-retirement.md) and
its [policy](workspace-entry-retirement-policy.json) select removal of the
unused direct browser stack for #64. Gateway 24 activates that retirement and
header registry 2 removes the direct ACP profiles. Only the shipped Agent UI
Bridge remains for browser workspace traffic. Receiver caller retirement,
Bridge capacity, consumer migration and real integration have separate gates.

The shared [login admission contract](login-admission.md) and its
[policy](login-admission-policy.json) define independent password/OIDC budgets,
IPv6 `/64` aggregation and bounded FIFO eviction for #2. Gateway version 23
activates the implementation with its service documentation, unit, component
and authenticated owning-container evidence. Consumer references and real
two-source HTTPS/OIDC integration follow as separate delivery batches.

The shared [password verification policy](../identity/password-verification.md)
defines Identity's persisted attempt limits and Argon2 resource failures.
Gateway version 22 validates the complete password failure tuple on login and
password change, then publishes `credential_rate_limited` (429) or
`credential_busy` (503), with one bounded `Retry-After` and `retryable: true`.
Both errors preserve cookies and use `no-store`; malformed metadata returns
`503 identity_unavailable` without a retry hint. Gateway never replays a
password request. The existing `login_rate_limited` prefilter remains separate.
Console user creation and final cross-service HTTPS admission were delivered
with [#60](https://github.com/tf4fun/antnest-platform/issues/60).

Revision 21 defines [bounded Identity resolution](resolve-cache.md) and its
[machine-readable policy](resolve-cache-policy.json): scoped positive caching,
private session-feed invalidation, resource limits and unchanged hard stream
boundaries. The shared batch precedes Gateway implementation, trace/display
consumers and real HTTPS outage/load admission. It does not enable caching on
its own or add an Identity RPC.

Revision 20 adds the three self binding/notice routes defined by
[OIDC account linking](../identity/oidc-linking.md), with closed browser schemas,
the Identity-only session CCT profile, shared Origin/CSRF admission and no Cookie
mutation. Identity, Gateway, browser consumers and the explicit HTTPS integration
were admitted in separate #61 batches.

[Public entry](public-entry.md) defines native TLS, HTTPS proxy trust, public
Origin, client addresses, forwarding headers, HSTS and certificate rotation.

[Request header boundary](request-headers.md) and its [registry](request-headers.json)
define both reserved namespaces, per-route outbound allowlists, browser-local
inputs and server-injected fields. Revision 18 removes retired hints from the
trusted list and explicitly inventories internal credentials and response-only
metadata without making them browser exceptions.

## Workspace routes

Version 19 of `session-contract.json` includes the Node Workspace HTML, HTTP
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
originless compatibility setting is off by default and never waives CSRF. See [public entry](public-entry.md) for the complete
safe-method, header validation and compatibility rules.

Revision 17 defines Secure-mode `__Host-` cookies and CSRF bound to the stable
Identity token ID with an independent Gateway secret. See
[browser session security](session-security.md) for strict cookie reads, the
trusted issuer boundary, logout behavior, key provisioning and the separate
Admin-origin phase. Producer, browser consumers and integration have individual
admission gates; the shared contract alone does not activate this behavior.

Revision 19 defines [browser session lifecycles](../identity/browser-sessions.md),
including idle and absolute deadlines, account/session-management routes,
explicit activity, atomic password rotation and bounded live stream checks.
Cookies change only on login, OIDC completion, successful password rotation or
logout. Shared schemas precede Identity, Gateway, browser and integration
batches; their completed admissions are recorded in the [global TODO](../../TODO.md).

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
integration after both service admissions. Gateway 24 removes the old
`/api/app/bootstrap`; the retained Bridge bootstrap remains owned by Agent UI.

## Workspace view and events

The Bridge forwards Agent UI's authorized view/events without decoding or
re-encoding the retired six-field ACP state projection. Agent UI owns DTOs,
event recovery and browser behavior; ACP owns private execution state.
Gateway retains scoped non-touch admission, the bounded Resolve cache and
private feed, original identity/absolute limits and the 30-second source-age
bound. Every current CCT must remain valid. Observer closure never cancels an
accepted Run. See [Workspace Bridge entry](../../services/edge-gateway/docs/workspace-state.md).

Bridge HTTP bodies remain limited to 64 MiB. There are 64 process-wide Bridge
SSE slots, separate from ordinary commands. These do not prove Agent UI's upload
fairness or actual Runtime cancellation; the retirement policy requires separate
two-user reception/EOF-processing and same-execution cancellation evidence.

## OIDC and SCIM

OIDC discovery/start and callback routes bridge Identity Service into the
browser session boundary. The callback consumes Identity's one-time access
token server-side, sets the normal session cookies, and redirects without
placing credentials, state, or authorization codes in browser-visible JSON or
locations. Unknown OIDC paths fail closed and never reach the Console SPA.

SCIM requests pass through to Identity Service with their protocol Bearer
credential intact. Browser cookies and forged trusted-principal headers are
removed; Identity remains the sole SCIM authentication and business authority.

## Retired direct browser routes

The legacy bootstrap, state/watch and `acp`, `v1/acp`, `v2/acp` registrations
are removed. Valid outer requests, including HEAD and WebSocket upgrades, return
`404 not_found` without Identity or upstream calls, with or without a valid
browser session. Invalid Origin/Fetch Metadata still receives the existing
outer rejection. The `/api/app/*` deny fallback is preserved.

Gateway no longer connects to Controller or ACP and owns no direct ACP
connection/message or state pools. Authenticated service-internal ACP v1/v2
remains available. Agent UI keeps its downstream workload grants and Identity
workspace CCT audiences for Controller/ACP. Receiver grants, deployment
credentials and consumers retire in their separate owning batches.
See [execution ownership](../../services/edge-gateway/docs/execution-boundary.md).
