# Edge Gateway Architecture

This document describes how Edge Gateway admits browser requests, binds OIDC
transactions, routes Admin Console, Agent UI and ACP traffic, and how it fails.

For #64, the accepted [browser workspace entry decision](../../../docs/architecture/browser-workspace-entry.md)
is option A: remove the unused direct browser stack and retain the Agent UI
Bridge. The [shared retirement policy](../../../contracts/edge-gateway/workspace-entry-retirement.md)
defines Gateway 24 activation, unchanged security boundaries, consumer migration
and real two-user capacity admission. The initial shared batch leaves Gateway
23 implementation and the existing route behavior below unchanged.

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
`console`, `workspace`, `acp` or `session` profile, and exact Agent scope (including
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
the Gateway SERVER span. WebSocket handshakes use the same observation rules
without changing the message relay or its socket configuration.

HTTP middleware and error-returning handler bindings own request diagnostics.
Business clients return errors and preserve their causes; actual RPC CLIENT
spans belong to the shared Transport. Resolve additionally emits a request-owned
INTERNAL decision marker without replacing the actual RPC parent. HTTP
observation records metadata and errors only, without Header values
or request/response content. ACP/SCIM/Console payloads are not decoded or buffered
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
       -> signed caller context + workload identity -> ACP local authorization
       -> authenticated bootstrap -> Controller ID/name metadata
       -> scoped state observation -> Agent ACP snapshot/watch
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
ACP HTTP adds its connection/session IDs to Accept and Content-Type. SCIM
forwards Accept, Content-Type, Authorization, If-Match and If-None-Match.
No browser Cookie reaches an upstream; only SCIM receives browser Authorization.
All HTTP proxies discard request trailers, including values populated at EOF,
while preserving the body. Only the declared ACP WebSocket routes forward
subprotocol negotiation; generic application proxies do not forward upgrades.

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
override foreign or malformed evidence. ACP WebSocket upgrades always require
matching Origin, regardless of this setting or Fetch Metadata. OIDC callbacks,
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
receives exactly `max-age=31536000`, including proxy responses and WebSocket
handshakes. The configured public origin also defines the API Origin checks.
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
defines Node decoding and the #92 → #93 → integration sequence. This Gateway
batch does not alter the old `/api/app/bootstrap` projection tracked by #64.

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

Request bodies are limited to the ACP message limit (64 MiB). Ordinary requests
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

Login, logout and account/session controls call Identity directly because Gateway owns the
browser credential boundary. Every administrative command goes to Admin
Console. Only workspace discovery calls Agent Controller's principal-scoped
ID/name list. ACP protocol and execution-state traffic goes directly to ACP,
without Controller lookups. Gateway never calls Runtime Controller or reads a
service database.

[Workspace state observation](workspace-state.md) is a separate leased GET/SSE
projection of ACP execution authority. Scope comes from the original browser
principal, never from URL query fields. Typed ACP frames are bounded and
re-encoded, with Identity revalidation before subsequent frames. Access loss,
transport failure or lease expiry ends observation without replaying or
cancelling ACP work. No private Run protocol or state cache is added. The
service's stream lifecycle also cancels and drains these watches before
telemetry shutdown; ordinary request drain remains unchanged.

The login page discovers enabled organization OIDC methods through Edge and
starts authorization through a typed Identity call. Identity completes the
callback and returns its one-time access token only to Edge; Edge establishes
the ordinary browser cookies and redirects to the application. The start
response necessarily contains the authorization URL and its OIDC state for
browser navigation. Callback completion/error redirects do not disclose state,
authorization code or access token. Those values never belong in logs or span
attributes, and the access token is never returned to browser JavaScript.

`/scim/v2` is a protocol-preserving proxy to Identity. It forwards method,
path, query, body and its declared request header profile, including SCIM Bearer
authorization. Browser cookies, reserved namespaces and trailers are removed.
Identity continues to own
token verification, scopes, SCIM semantics, and canonical error envelopes.

`GET /api/app/bootstrap` returns principal display facts and accessible Agent
IDs and names only. During a same-origin WebSocket upgrade at
`/api/app/agents/{agent_id}/v1/acp` (stable) or
`/api/app/agents/{agent_id}/v2/acp` (draft), Edge injects authenticated
Organization/Principal and the route Agent ID. ACP owns Agent and Session
authorization, including unavailable targets and protocol errors. Incoming
cookies, authorization and forged internal identity headers are not forwarded.

The existing `/api/app/agents/{agent_id}/acp` Workspace route remains a v1
alias. Versions are an explicit route allowlist, not arbitrary upstream paths;
unknown versions return `404`. Both versions use identical upgrade admission,
Origin checks and trusted identity injection. Edge does not translate ACP messages or
infer the version from their content.

After upgrade, a message relay replaces blind byte copying. Each complete
client message is buffered within 64 MiB, then checked by scoped Resolve using
the original browser token before forwarding. Protocol values remain unchanged,
except W3C context in standard request/notification `params._meta`, which the
transport tracing wrapper replaces with the actual Gateway PRODUCER context.
Responses and non-JSON frames remain byte-for-byte unchanged. The current
principal must be active and retain the same SID, User/Organization/Membership and roles;
authentication cannot switch identity inside an existing connection. One
message per direction is processed at a time, so a message waiting for Identity
cannot bypass the check through fragmentation or pipelining. Independent
directions permit client messages while ACP emits output; cancellation and
client replies are subject to the same session check as every other message.

Revocation/expiry closes both hops with 1008; dependency failure uses 1013.
These are transport outcomes, not invented ACP errors. No cookies or Bearer
tokens reach ACP. Each request owns its decision marker; a shared waiter links
the exact actual RPC CLIENT, and background refresh owns a separate root linked
to its trigger. Diagnostics expose only stable result classes. Writes and dependency calls are bounded by the
request timeout; connection cancellation closes both sockets and joins relay
workers. Signal or listener failure stops new upgrades, cancels WebSocket
contexts and waits for handlers (including their telemetry) within the shutdown
deadline. Ordinary HTTP requests retain their graceful drain window; their
contexts are not tied directly to the process signal.

All long-lived browser transports also run independent non-touch checks while
quiet: administrator Agent events, Workspace state, Workspace API events, ACP
v1 HTTP receive (including its alias), and both direct WebSocket versions.
The guard starts before opening the upstream. It binds the original SID,
User/Organization/Membership and roles, with maximum stale bound `R = 30s`.
The check interval and RPC budget are at most `min(R/3, activity_interval_ms)`.
Each hard stale deadline is anchored to the actual source Resolve RPC start,
including RPC latency
and at most `min(1s, R/3)` for socket closure. Initial resolution is bounded by
`R/3`, then by the returned hint; a late successful response cannot open a stream.
Current probe wait/scheduling time is separate from that source age. A cached
snapshot may be older than the scheduling hint when every authority deadline,
proof and stale-output budget remains valid; a hit cannot reset source age.
Live/shared results must also satisfy the actual RPC duration budget.
Idle expiry schedules a fresh check, so activity through another replica can
extend it. Absolute expiry and the direct WebSocket's original handshake CCT
remain hard caps. Fresh CCTs never extend an existing direct WebSocket.

One main-owned private revocation-feed poller accelerates closure through the
active SID registry. It starts at cursor zero, uses pages of at most 500 and at
most four pages per catch-up pass, and retains no event cache. The same events
fence cached authority, with terminal-page catch-up proof as described above.
Feed failure, backlog, restart or a register/poll race cannot weaken independent
bounded checks; stale proof forces live Resolve.
Cancellation interrupts blocked HTTP writes and both WebSocket directions;
later frame deadlines cannot reopen a cancelled write. Guard workers, relay
workers and callbacks are joined, and HTTP deadlines clear only after completion.

Stream closure does not cancel previously admitted ACP work. A check overlapping
revocation can authorize a message even if ACP creates its Run after logout
returns. A check started after authoritative revocation completes must reject;
there is no distributed transaction between that check and ACP Run creation.
ACP retains responsibility for Agent access revision, Session ownership and
durable Run behavior; it does not receive browser credentials.

## ACP Streamable HTTP

The v1 route and its alias also accept POST/GET/DELETE Streamable HTTP through
an opaque reverse proxy to ACP `/v1/acp`, relaying the official SDK transport.
The draft v2 endpoint is WebSocket-only. Gateway does not interpret ACP methods.
Each request repeats browser authentication with the existing login cookies;
ACP owns resource authorization. POST and DELETE also require
`X-Antnest-CSRF-Token` matching the authenticated session derivation, independently of the shared
API Origin admission. Non-browser HTTP clients send the configured public
Origin; the originless compatibility setting does not waive authentication
or CSRF. WebSocket upgrades always require a
matching Origin. Only `Content-Type`, `Accept`, `Acp-Connection-Id` and
`Acp-Session-Id` are forwarded from the client, with trusted identity and trace
context injected by Edge. Responses preserve ACP routing headers.

GET SSE responses are flushed immediately and bounded by the browser-session
guard and `ANTNEST_EDGE_STREAM_LEASE`, not an ordinary short request timeout.
They consume receive-connection
capacity separately from POST/DELETE message admission. Cancelling the client
HTTP request cancels the upstream receive request; it does not become a
session/cancel command. ACP Service owns connection IDs, expiry and recovery;
Gateway owns no ACP connection registry. HTTP reuses the new-message admission
policy above, including its explicit already-admitted-work boundary. Gateway
does not translate browser-session closure into Run cancellation;
ACP owns access updates, output subscription revocation, reconnect and
connection expiry.

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
- Identity, Agent Controller, ACP, Console, Agent UI, or SCIM transport failure
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
for HTTP requests and WebSocket handshakes. Browser-supplied service/CCT headers
and both complete reserved namespaces are removed; CSRF is kept privately for
local comparison. Identity revision 16 resolves the session with a fixed
server-selected audience profile and target Agent; Gateway forwards its CCT
unchanged from private request context. Internal credential response headers and upstream Set-Cookie
are removed, and principal JSON never serializes the CCT.

Direct WebSockets require the original session and an unexpired handshake CCT.
Hard expiry closes quiet connections as well as active ones and requires
reconnect; it does not cancel previously accepted ACP work. Console and Agent UI
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
