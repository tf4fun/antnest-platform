# Edge Gateway Architecture

This document describes how Edge Gateway admits browser requests, binds OIDC
transactions, routes Admin Console and Agent UI traffic, and how it fails.

For #64, the accepted [browser workspace entry decision](../../../docs/architecture/browser-workspace-entry.md)
is option A: remove the unused direct browser stack and retain the Agent UI
Bridge. The [shared retirement policy](../../../contracts/edge-gateway/workspace-entry-retirement.md)
defines Gateway 24 activation, unchanged security boundaries, consumer migration
and real two-user capacity admission. Gateway 24 removes the old routes; receiver
credential retirement, Agent UI capacity and consumer/integration work have
separate admission gates.

## Browser session boundary

Secure mode accepts and emits only `__Host-antnest_session` and
`__Host-antnest_csrf`: Secure, host-only, Path `/`, SameSite Lax, with only the
session cookie marked HttpOnly. Explicit insecure loopback development uses the
unprefixed names. There is no production fallback. Duplicate or malformed
configured cookies invalidate the request; a missing CSRF delivery cookie does
not invalidate the session itself.

Gateway derives CSRF as unpadded `base64url(HMAC-SHA256(key, UTF8(token_id)))`.
The private 32-byte key is loaded from `ANTNEST_EDGE_CSRF_KEY_FILE` at startup;
all replicas for an origin share it. Login and OIDC supply Identity's `token_id`;
later requests use the stable `sid` from the authenticated Identity response's
CCT. Gateway validates that identifier and keeps it outside browser JSON.
Neither CCT `iat`/`jti` nor a browser-supplied identifier determines the binding.
Every authenticated mutation compares exactly one CSRF header with this server
derivation. The delivery cookie's value is never the authorization reference.

Logout resolves the session before checking CSRF and revoking the access token.
No-session logout clears local cookies with 204. Invalid cookies or an inactive,
expired or revoked session clear local cookies with 401; without a trusted sid,
this path does not promise durable token revocation. Identity transport/issuer
failures and revocation outages return 503 while preserving browser credentials.
Bad Origin or CSRF returns 403 without revocation or cookie changes. Successful
revocation returns 204 and clears cookies; a token already invalid at revocation
returns 401 and clears them.

Identity supplies absolute and idle deadlines plus `activity_interval_ms` in
login, OIDC completion and every resolution. Gateway validates their shape and
checks fresh time and request cancellation after resolution. Only
`POST /api/session/activity` records real user activity; reads, CCT issuance,
business mutations and streams do not extend idle expiry. Session/CSRF cookies
are written only by login, OIDC completion, successful password rotation and
logout, always with absolute expiry. Ordinary 401, SSR rejection and session
revocation responses preserve cookies, including when revoking the current SID.
Proxy responses cannot set browser cookies.

Gateway owns current account, password, activity, session inventory and
revocation routes under `/api/session`. They use the `session` CCT profile,
whose sole audience is Identity and which carries no Agent. Self scope, actor
and target User come from the verified principal. Public inventory exposes
independent public references and bounded plain-text user-agent hints, never
private SID/CCT/raw credentials. Mutations enforce Origin, session-bound CSRF
and strict typed bodies. Password rotation replaces cookies only after a live
replacement is received; a lost reply requires fresh login with the new
password. Only a wrong current password returns `invalid_current_password`;
generic input failures return `invalid_request`, both without cookie changes.
Login and password change separately validate Identity revision 17's admission
errors. Closed, duplicate-free JSON and the exact status/code/message/retryable
tuple must agree with one canonical `Retry-After`: 1–900 seconds for
`credential_rate_limited` (429), exactly 1 for `credential_busy` (503).
Only the validated private error type reaches the public three-field writer.
Malformed responses use `503 identity_unavailable` without retry metadata;
all these failures use `no-store`, preserve cookies and never repeat the RPC.
Other Identity RPCs retain their existing error handling.
See the [shared lifecycle contract](../../../contracts/identity/browser-sessions.md)
for the Console, Agent UI and script consumers and their HTTPS integration.

The three external identity routes also use the session profile. GET requires
`limit` from 1 to 100 and accepts separate `after_id` and `notice_after_id`
exclusive cursors. Each returned array is bounded and strictly ordered; its
optional cursor must advance independently and cannot precede its last item.
A self page can span organizations. Notices preserve historical binding facts
and do not need a matching binding or Membership in the current page.

The typed Identity client rejects missing/null required values, unknown or
duplicate fields, casing aliases, invalid public IDs and malformed timestamps.
Opaque subjects retain exact whitespace and Unicode scalars; invalid UTF-8,
unpaired surrogates and NUL fail closed. Explicit `revoked_at: null` and
`provider_enabled: false` are valid. Malformed Identity responses return 503
without exposing upstream payloads or changing cookies.

DELETE accepts only an optional Boolean `allow_lockout` (default false); explicit
null is rejected. Identity owns the last-login-method decision and atomically
revokes the affected Membership's sessions. The Gateway returns Identity's
committed counts even if the current SID was revoked; a later request resolves
again. POST notice acknowledgment accepts 1–100 unique IDs and never acknowledges
by a watermark or as a side effect of reading. Both mutations use server-generated
request IDs; browser actor, scope and Membership overrides are rejected.
`not_found` stays 404 and `external_identity_last_method` stays 409. The Console,
Agent UI and real Identity HTTPS workflow was delivered with #61.

Gateway defaults COOP and CORP to `same-origin`. Console and Workspace currently
share one origin; these controls do not provide an XSS privilege boundary
between them. The [session security contract](../../../contracts/edge-gateway/session-security.md)
defines a separate Admin-origin phase with independent host-only sessions,
fresh authentication and explicit routing, callback and deployment admission.

## Bounded Identity Resolution

Gateway revision 21 uses one process-owned Identity client and the existing
revision 16 session-revocation feed. The [shared cache policy](../../../contracts/edge-gateway/resolve-cache.md)
defines admission separately from the downstream service's authorization.
The LRU key contains SHA-256 of the exact browser token, the server-selected
`console`, `workspace` or `session` profile, and exact Agent scope (including
absence). Each client/issuer owns its cache; no raw browser token is retained
in an entry. Only complete active Principals, their exact display fields and
original private SID/CCT may enter it.

An entry expires at the earliest of the actual Resolve RPC start plus TTL,
idle expiry, absolute expiry and original CCT expiry. Equality is expired.
Hits and feed proofs never move that deadline. The default TTL is 10 seconds,
bounded at 30 seconds; zero preserves direct Resolve without coalescing or
background refresh. The entry count, accounted byte budget and shared-work
limits are independent; a valid response above the per-entry budget is returned
live without retaining an LRU entry. These budgets do not describe process RSS.

Concurrent misses share one exact-scope generation. The process owns the RPC,
with deadline `min(5s, request timeout, TTL)`; each caller can stop waiting
independently. The final foreground waiter cancels abandoned work. Its slot
remains occupied through transport cleanup and final waiter delivery, including
completed oversized results. Capacity refusal returns 503. After half TTL, a
valid hit may trigger bounded refresh, with at least half TTL between attempts
even after failure; saturated refresh does not invalidate a still-valid hit.

The single feed poller applies each event to the stream registry and cache.
Only a validated short terminal page, after all consumers apply its events,
updates catch-up proof, anchored to that page RPC's start. A short fourth page
qualifies; four full pages, failure, cancellation or partial application do not.
Missing proof at startup or proof age reaching TTL requires live resolution.
Revocations fence in-flight completion and late delivery. Authoritative denial
or a complete inactive response evicts every cached scope for the token,
including denial from background refresh.

Session-feed invalidation uses a fixed window of 128 applied SID digests. Each
flight keeps its creation counter through completion and delivery. Both checks
use the actual validated response SID, so unrelated session revocations do not
discard a valid live response or trigger a retry. A known SID must agree with
that response. More than 128 intervening events fail closed for old work; a
counter reset first invalidates all retained work. The window retains 4096 bytes
of digests plus its counter, independently of the entry budget. Local User
mutation generations, immediate SID eviction and every work/deadline bound stay
in force. See the shared policy for overflow and late-delivery requirements.

Validated local logout evicts the token. Password changes, self revocation and
OIDC unbinding evict the trusted User across organizations, even when the current
session survives. A validated activity response evicts the trusted SID's cached
observations. Retained work identified by entries or known/completed SID evidence
for the same token becomes obsolete for joining and cache refill. Its existing
readers may still receive the live response within its original deadlines and
final security checks; activity neither cancels their RPC nor patches its CCT or
Principal. Later readers start a new generation, which old completion cannot
remove or overwrite. Old authoritative denial still fences every token scope.
All generations retain their work/waiter charges through cleanup and delivery;
there is no retry or capacity exemption. Unrelated users' work is unchanged.
A truly cold response whose SID remains unknown may deliver its still-valid
conservative old idle observation, clipped to every original deadline. Each
subsequent expired observation requires another Resolve.

## OIDC Browser Transaction

Identity owns the authorization transaction, PKCE, nonce, expiry and identity
binding. Edge also binds that transaction to the initiating browser: successful
start writes the SHA-256 digest of its state into a short-lived, HttpOnly,
SameSite=Lax, host-only cookie, using the configured Secure policy (`__Host-`
name under HTTPS; the unprefixed cookie is only for configured HTTP development). Callback
must match that cookie before any Identity exchange. A foreign/missing state
does not consume the legitimate browser's pending transaction or alter its
existing application session. A matching completion clears only the pending
OIDC cookie, including on rejection by Identity. One browser keeps its latest
login attempt; starting another replaces the earlier binding. There is no new
Gateway database or private Identity RPC field.

Parallel tabs are not independent transactions: response arrival order decides
the latest cookie, and a late matching callback response may clear a newer
attempt. The user restarts login in that case. Identity's durable claim, not
cookie deletion, serializes competing code exchanges.

This is browser CSRF binding, not a substitute for Identity's token validation
and server-side transaction deadline. See [RFC 9700 section 4.7.1](https://www.rfc-editor.org/rfc/rfc9700.html#section-4.7.1).

## Request Pipeline

Gateway follows the [platform observability contract](../../../docs/observability-contract.md).
`GET /status` reports local readiness only: successful composition and an active
listener. It does not call another service. A downstream outage is reported by
the affected business request, not by recursively disabling the entry point.

One shared HTTP Transport creates CLIENT spans and injects their context for
typed RPC clients, readiness-independent business calls and reverse proxies.
The receiving service's SERVER span is a child of that CLIENT, not directly of
the Gateway SERVER span.

HTTP middleware and error-returning handler bindings own request diagnostics.
Business clients return errors and preserve their causes; actual RPC CLIENT
spans belong to the shared Transport. Resolve additionally emits a request-owned
INTERNAL decision marker without replacing the actual RPC parent. HTTP
observation records metadata and errors only, without Header values
or request/response content. Workspace/SCIM/Console payloads are not decoded or buffered
for tracing. The receiving service's RPC adapter owns optional content capture;
Gateway does not duplicate it on each HTTP hop.

Session rejection and Identity unavailability are distinct. Authoritative
`unauthenticated`/`inactive_principal` responses or an inactive resolved principal
return 401 without changing browser cookies. Transport, timeout, malformed-response and
other upstream errors deny access with 503 without destroying the browser's
session. A retry must revalidate with Identity; unavailable never means admitted.

```text
HTTP limits/security header defaults wrapper
  -> W3C trace extraction/root span
  -> privately capture CSRF/CAS; remove all X-Antnest-* and Antnest-* headers
  -> shared Origin admission for every /api/ request
  -> route match
  -> cookie token resolution (protected routes)
  -> route-specific admission
       -> administrator + CSRF -> Admin Console
       -> signed workspace context + workload identity -> Agent UI Bridge
       -> scoped event observation -> leased Bridge SSE
  -> route allowlist after hop-by-hop filtering; inject verified identity
  -> Admin Console or Agent UI application proxy (no request trailers)
  -> final response commit: supply only missing security headers
```

## Request Header Boundary

The [request header contract](../../../contracts/edge-gateway/request-headers.md)
and its [registry](../../../contracts/edge-gateway/request-headers.json) define
the reserved namespaces and every outbound profile. Incoming `X-Antnest-*`
and `Antnest-*` fields are removed case-insensitively before routing, including
unknown names and duplicate values. CSRF and the network-policy account-switch
guard are captured privately for local validation; neither is an identity fact.

Every HTTP proxy creates a fresh header map from the post-hop-filter request.
It cannot restore a browser field nominated by `Connection`. Console and
Workspace assets forward the asset profile (Accept/encoding, cache validators
and Range); JSON APIs forward Accept, Content-Type, If-Match and Idempotency-Key;
event streams forward Accept and Last-Event-ID. Workspace HTML forwards Accept.
SCIM forwards Accept, Content-Type, Authorization, If-Match and If-None-Match.
No browser Cookie reaches an upstream; only SCIM receives browser Authorization.
All HTTP proxies discard request trailers, including values populated at EOF,
while preserving the body. No application proxy forwards a browser upgrade
handshake; the retired direct ACP routes return 404 after outer admission.

After the allowlist, authenticated routes reconstruct their presentation hints
and caller context from the private Identity result. A validated network-policy
CAS value has its own private context slot and is injected only on its owning
PUT route. Anonymous assets and SCIM never inherit session presentation hints
or caller context. Typed local handlers construct their own downstream requests.
Tracing, workload credentials and public forwarding metadata are added by their
existing server-owned layers. The repository vocabulary gate rejects new
reserved header literals until registered; generated attack tests verify every
registered name against each proxy family.

## API Origin Admission

Every `/api/` request passes Origin admission before routing, session resolution
or upstream calls, including login, login-method discovery, OIDC start, logout
and admin routes. GET, HEAD and OPTIONS may omit Origin; any supplied Origin
must be exactly the configured public Origin in one header value. Empty,
`null`, foreign and duplicate Origin values are rejected.

All other methods require that matching Origin or, when Origin is absent,
`Sec-Fetch-Site: same-origin`. For these methods, `same-site` and `cross-site`
always reject, even with matching Origin. Empty, unknown, duplicate or joined
Fetch Metadata values also reject. `none` requires matching Origin. Failures
return `403 forbidden` with `Request origin is not allowed` and the normal
security headers. Session authentication, authorization and CSRF remain
independent requirements after Origin admission.

`ANTNEST_EDGE_ALLOW_ORIGINLESS_MUTATIONS` defaults to `false`. Enabling it logs
a warning and admits requests only when both headers are absent; it cannot
override foreign or malformed evidence. OIDC callbacks,
SCIM and document/assets routes retain their own protocol checks outside
`/api/`. See the [public-entry contract](../../../contracts/edge-gateway/public-entry.md).

## Response Security Headers

The service that renders a document owns its Content Security Policy. Agent UI
owns the nonce-bearing CSP on Workspace HTML, including its `blob:` image and
media sources. Gateway forwards an upstream CSP unchanged, without adding,
merging or rewriting policies. Multiple policies deliberately sent by an
upstream also remain unchanged; the Gateway adds no extra policy.

Gateway supplies defaults for `Content-Security-Policy`,
`X-Content-Type-Options`, `Referrer-Policy` and `X-Frame-Options` independently,
only when the final response has no value for that header. This happens after
proxy response headers have been copied, immediately before the final status,
first body write or Flush. Interim 1xx responses do not commit defaults. Empty
responses receive defaults when the handler returns.

Gateway-generated errors, redirects and JSON responses, and proxied Admin
Console static files or Workspace assets without their own policy, retain the
existing defaults. An upstream HTML response without CSP receives that same
fallback. The wrapper preserves streaming Flush errors, response deadlines and
WebSocket hijacking; it does not buffer response bodies.

Gateway owns HSTS independently of document policies: an HTTPS public origin
receives exactly `max-age=31536000`, including proxy and retirement responses. The configured public origin also defines the API Origin checks.
Trusted proxy CIDRs determine the client address used for login admission and
diagnostics; incoming forwarding headers never pass through unchanged. See the
[public-entry contract](../../../contracts/edge-gateway/public-entry.md).

## Agent UI and Workspace API

One reverse proxy target, `ANTNEST_AGENT_UI_URL`, serves both the `/workspace/`
application (SSR HTML and hashed assets) and the Workspace HTTP/SSE API at
`/api/app/workspace/v1/*`. There is no separate Bridge base URL.

Identity supplies the required Organization slug/name on local login, token
resolution and OIDC completion. Browser session JSON preserves both. Workspace
HTML and API requests additionally receive verified `X-Antnest-Organization-Slug`
and `X-Antnest-Organization-Name`: one canonical unpadded Base64URL value per
header over the exact UTF-8 label. Browser values are removed before admission;
anonymous assets and other upstreams receive neither header. Neither label
affects scope or administrator status. A new authenticated bootstrap or SSR
request observes the complete bounded Principal snapshot. Rename visibility
is bounded by snapshot expiry plus the next actual read and request latency;
there is no background browser rename watcher. Empty feed pages do not renew
display fields. Missing or
blank metadata fails as `503 identity_unavailable`, preserving existing cookies.
The blank check includes U+FEFF, matching the Node consumer's whitespace check;
valid labels retain their exact UTF-8 bytes rather than being trimmed.
The [shared projection contract](../../../contracts/agent-ui/organization-projection.md)
defines Node decoding and the completed #92 → #93 → integration sequence.
The old `/api/app/bootstrap` projection is retired in Gateway 24.

The Workspace API accepts only `GET` and `POST`. Each request resolves the
browser session and replaces incoming identity headers with the verified
Organization, Principal, User, Membership, administrator flag and path Agent ID.
JSON routes forward `Accept`, `Content-Type`, `If-Match` and `Idempotency-Key`;
the event route forwards `Accept` and `Last-Event-ID`. Both receive the verified
identity fields after that allowlist. Origin and CSRF rules are exact:

- The shared API Origin admission above applies before Workspace routing.
  GET may omit Origin; POST requires matching Origin or same-origin Fetch
  Metadata, unless the explicit originless compatibility setting applies.
- Every `POST` (mutation) requires a valid CSRF token, independent of Origin.
  A missing or mismatched token returns `403 csrf_failed`.

Workspace HTTP request bodies are limited to 64 MiB. Ordinary requests
have a fixed 65-second deadline so the Node service can return its own response
deadline. `GET .../agents/{agent_id}/events` is an SSE stream: it forwards one
validated `Last-Event-ID` (at most 4096 bytes), flushes immediately, uses one of
64 stream slots and is bounded by `ANTNEST_EDGE_STREAM_LEASE`. During the stream
Gateway periodically revalidates browser identity and closes only the observer
on revocation.

Workspace documents require a browser session and preserve a validated
`/workspace/{agentId}/` or `/workspace/{agentId}/sessions/{sessionId}` path through
login. HTML receives verified principal headers; hashed assets remain anonymous
and never receive browser-supplied identity. IDs are validated after splitting
the escaped path, so encoded separators stay inside their ID. Query-bearing and
malformed return destinations fall back to `/workspace/`, per the
[document navigation contract](../../../contracts/agent-ui/workspace-navigation.md).
ACP retains durable execution authority.

## Routing

Login, logout and account/session controls call Identity directly because Gateway
owns the browser credential boundary. Administrative commands go to Admin
Console. All browser workspace traffic uses Agent UI at `/workspace/*` and
`/api/app/workspace/v1/*`. Gateway has no Controller/ACP client, discovery
fallback, execution-state projection or direct ACP protocol relay.

The old bootstrap, state/watch and ACP aliases return `404 not_found`,
including implicit HEAD and upgrade variants, for both anonymous and valid
browser sessions. They make no Identity or downstream call. Existing outer
Origin/Fetch Metadata admission still rejects invalid requests first. The
`/api/app/*` fallback remains a deny route, never the Console SPA.

The login page discovers organization OIDC methods through Edge and starts
authorization through a typed Identity call. Identity completes the callback
and returns its one-time access token only to Edge. Edge sets browser cookies
and redirects without exposing code, state or token in completion locations.
The start response includes the authorization URL and state for navigation;
those values never belong in logs or span attributes.

`/scim/v2` forwards protocol method, path, query, body and its declared header
profile, including the SCIM bearer. It removes browser cookies, reserved
namespaces and trailers. Identity owns SCIM authentication, scopes, canonical
errors and business behavior.

See [Workspace Bridge entry](workspace-state.md) and
[execution ownership](execution-boundary.md). Agent UI owns browser DTOs,
commands and reconnect/recovery; ACP retains private protocol and durable Run
authority. Gateway does not translate disconnect into a cancel command.

## Retained stream lifecycle

Only Workspace Bridge events and administrator Agent event watches are managed
receive streams. Their guard starts before opening the upstream, binds the
original SID, User/Organization/Membership and roles, and checks Identity without
recording activity, including during quiet periods.

The maximum stale bound is `R = 30s`. Check interval and RPC budget are at most
`min(R/3, activity_interval_ms)`. The hard deadline uses the actual source
Resolve RPC start, including RPC latency and at most `min(1s, R/3)` for closing
the connection. Initial admission must fit that budget before opening upstream.
A cached snapshot does not reset source age; probe wait and scheduling time
remain separate. Every returned snapshot must retain valid idle, absolute and
CCT deadlines. Fresh live resolution may observe renewed idle eligibility and
a new CCT, but cannot change the original identity or absolute session cap.

One main-owned private revocation-feed poller accelerates closure and fences
cached authority. It starts at cursor zero, applies at most 500 events per page
and four pages per catch-up pass, and retains no event cache. Missing or stale
catch-up proof requires live Resolve; feed failures never waive bounded checks.

Cancellation interrupts blocked browser writes even when the request carries
Upgrade headers. Later write deadlines cannot reopen a cancelled stream.
Signal or listener failure stops new streams, cancels upstream receive requests
and joins handlers, guard workers and telemetry. Ordinary HTTP, including
Bridge commands and prompts, keeps graceful drain.

Closing an observer does not cancel an accepted Run. A request whose admission
overlaps revocation can have a later business effect; there is no distributed
transaction between the Identity check and downstream Run creation. Downstream
services still enforce resource access, Session ownership and durable execution.

## Login, Logout and Protocol Routes

Password login consumes a source window and a normalized organization/account
window before Identity performs Argon2 verification. OIDC start consumes only
its own source window; it has no organization/provider account bucket. The
three tables are independent and each defaults to 65,536 entries. After trusted
client selection, the limiter unmaps IPv4 and groups IPv6 by `/64` without
rewriting forwarded addresses. Account keys are fixed 32-byte SHA-256 digests
of a domain and length-prefixed normalized organization/email components.

One mutex covers the decision, a single clock sample and all involved table
changes. Exhausted retained source keys take precedence over account keys.
Rejection leaves all maps and FIFO lists unchanged, including expired entries,
and returns `429 login_rate_limited` with the whole window rounded up in
`Retry-After`, `no-store` and no Cookie writes. Admitted requests prune expired
FIFO heads and, only if a new key still needs space in a full table, evict its
earliest-expiring live window, then consume each applicable budget once.
Windows have fixed expiry; a hit
neither extends it nor moves the node. Each key owns one map entry and one FIFO
node, both removed together.

Each admission decision records one fixed-label counter outcome after releasing
the mutex; two table evictions still produce one `evicted` decision. Eviction
can reset an old key's local allowance. Identity's persistent password backoff
and bounded KDF admission remain authoritative and independent. See the
[login admission contract](../../../contracts/edge-gateway/login-admission.md)
for configuration, metrics and the separate consumer/integration gates.

Logout follows the explicit outcome matrix above, including clearing invalid
browser state without promising token revocation. Agent event watches have a
bounded stream lease; reconnect repeats normal token resolution.

Unknown `/protocol/oidc` paths return JSON `404`; route matching cannot send
protocol traffic to the Console SPA. A SCIM transport failure returns a
canonical SCIM `503` envelope rather than a browser API error.

## Failure Semantics

- missing, expired, revoked, or inactive credentials return `401`;
- an active non-administrator may use workspace routes but receives `403` on
  administrator routes;
- a state-changing request with a missing or mismatched CSRF token returns
  `403` without reaching Admin Console;
- Identity, Console, Agent UI, or SCIM transport failure
  returns `503` with a stable route-specific error code;
- exhausted login admission returns `429` before Identity password verification;
- retryable logout revocation failure returns `503` and preserves the cookies
  required to retry;
- upstream application status and JSON are preserved after admission.

Access tokens, passwords, cookies, Provider secrets, and OIDC state are never
logged or added to span attributes.

## Extension Rules

Additional identity protocols require explicit route and credential-boundary
contracts. Business resource routes, cross-service aggregation, and domain
retries belong to the owning service or presentation BFF, not this Gateway.

## Service authentication rollout

The [platform authentication contract](../../../contracts/platform/service-authentication.md)
and [Gateway forwarding contract](../../../contracts/edge-gateway/service-authentication.md)
define the implemented internal connection boundary. Each dependency origin
has a distinct token file or verified mTLS service identity. Tokens are re-read
for each HTTP request. Browser-supplied service/CCT headers
and both complete reserved namespaces are removed; CSRF is kept privately for
local comparison. Identity revision 18 resolves the session with a fixed
server-selected audience profile and target Agent; Gateway forwards its CCT
unchanged from private request context. Internal credential response headers and upstream Set-Cookie
are removed, and principal JSON never serializes the CCT.

Retained SSE checks keep the original session identity, current snapshot CCT
validity and bounded source age. Closing observation does not cancel an
accepted Run. Console and Agent UI
implement browser activity, account controls and request generations. Scripted
consumers adopt replacement credentials and non-touch reads; the separate
`make e2e-browser-sessions-https` target verifies the browser workflow. The earlier
workload-authentication admissions are recorded in the
[rollout ledger](../../../contracts/platform/service-authentication-rollout.json).

The browser's `X-Antnest-Expected-Principal` is a private account-switch CAS
guard. After session, administrator and CSRF checks, only the network-policy PUT
compares its one decoded organization/user pair with verified Identity facts.
Gateway rejects a missing/duplicate/mismatched guard with `409 principal_changed`
and regenerates a canonical matching header for Console. Other routes never
receive it. Delegated authorization continues to use the unchanged signed CCT.
