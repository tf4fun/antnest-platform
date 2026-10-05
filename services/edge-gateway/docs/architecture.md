# Edge Gateway Architecture

This document describes how Edge Gateway admits browser requests, binds OIDC
transactions, routes Admin Console, Agent UI and ACP traffic, and how it fails.

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
Business clients return errors and preserve their causes; they do not create
spans. HTTP observation records metadata and errors only, without Header values
or request/response content. ACP/SCIM/Console payloads are not decoded or buffered
for tracing. The receiving service's RPC adapter owns optional content capture;
Gateway does not duplicate it on each HTTP hop.

Session rejection and Identity unavailability are distinct. Authoritative
`unauthenticated`/`inactive_principal` responses or an inactive resolved principal
return 401 and clear browser cookies. Transport, timeout, malformed-response and
other upstream errors deny access with 503 without destroying the browser's
session. A retry must revalidate with Identity; unavailable never means admitted.

```text
HTTP limits/security header defaults wrapper
  -> W3C trace extraction/root span
  -> remove browser service/context credentials and all X-Antnest-* headers
  -> route match
  -> cookie token resolution (protected routes)
  -> route-specific admission
       -> administrator + CSRF -> Admin Console
       -> signed caller context + workload identity -> ACP local authorization
       -> authenticated bootstrap -> Controller ID/name metadata
       -> scoped state observation -> Agent ACP snapshot/watch
  -> Admin Console or Agent UI application proxy
  -> final response commit: supply only missing security headers
```

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
request observes current Identity metadata without a Gateway cache. Missing or
blank metadata fails as `503 identity_unavailable`, preserving existing cookies.
The blank check includes U+FEFF, matching the Node consumer's whitespace check;
valid labels retain their exact UTF-8 bytes rather than being trimmed.
The [shared projection contract](../../../contracts/agent-ui/organization-projection.md)
defines Node decoding and the #92 → #93 → integration sequence. This Gateway
batch does not alter the old `/api/app/bootstrap` projection tracked by #64.

The Workspace API accepts only `GET` and `POST`. Each request resolves the
browser session and replaces incoming identity headers with the verified
Organization, Principal, User, Membership, administrator flag and path Agent ID.
Only `Accept`, `Content-Type`, `If-Match`, `Idempotency-Key`, `Last-Event-ID`
and the trusted identity headers are forwarded. Origin and CSRF rules are
exact:

- A request that carries an `Origin` header is rejected with `403` unless the
  Origin matches the Gateway origin. A request without `Origin` is not rejected
  for that reason.
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

Login and logout call Identity Service directly because the Gateway owns the
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
path, query, body, content headers, and SCIM Bearer authorization while removing
browser cookies and untrusted principal headers. Identity continues to own
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
client message is buffered within 64 MiB, then checked against Identity using
the original browser token before forwarding. Protocol values remain unchanged,
except W3C context in standard request/notification `params._meta`, which the
transport tracing wrapper replaces with the actual Gateway PRODUCER context.
Responses and non-JSON frames remain byte-for-byte unchanged. The current
principal must be active and retain the same User/Organization/Membership;
authentication cannot switch identity inside an existing connection. One
message per direction is processed at a time, so a message waiting for Identity
cannot bypass the check through fragmentation or pipelining. Independent
directions permit client messages while ACP emits output; cancellation and
client replies are subject to the same session check as every other message.

Revocation/expiry closes both hops with 1008; dependency failure uses 1013.
These are transport outcomes, not invented ACP errors. No cookies or Bearer
tokens reach ACP. All checks are children of the Gateway request context and
log only stable result classes. Writes and dependency calls are bounded by the
request timeout; connection cancellation closes both sockets and joins relay
workers. Signal or listener failure stops new upgrades, cancels WebSocket
contexts and waits for handlers (including their telemetry) within the shutdown
deadline. Ordinary HTTP requests retain their graceful drain window; their
contexts are not tied directly to the process signal.

This is new-message admission, not cancellation of previously admitted work.
An idle connection is not periodically checked, and output for an admitted Run
can still arrive until another client message or disconnect. A check overlapping
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
`X-Antnest-CSRF-Token` matching the CSRF cookie. A supplied Origin must match
the Gateway origin; HTTP clients without Origin are allowed only with the same
authentication and CSRF requirements. WebSocket upgrades always require a
matching Origin. Only `Content-Type`, `Accept`, `Acp-Connection-Id` and
`Acp-Session-Id` are forwarded from the client, with trusted identity and trace
context injected by Edge. Responses preserve ACP routing headers.

GET SSE responses are flushed immediately and live until disconnect or upstream
closure, not an ordinary short request timeout. They consume receive-connection
capacity separately from POST/DELETE message admission. Cancelling the client
HTTP request cancels the upstream receive request; it does not become a
session/cancel command. ACP Service owns connection IDs, expiry and recovery;
Gateway owns no ACP connection registry. HTTP reuses the new-message admission
policy above, including its explicit already-admitted-work boundary. Gateway
does not poll idle connections or translate disconnect into Run cancellation;
ACP owns access updates, output subscription revocation, reconnect and
connection expiry.

## Login, Logout and Protocol Routes

Login admission consumes bounded per-source and normalized-account windows
before Identity performs Argon2 verification. Each table holds at most 4096
keys per replica. When a table is full, expired windows are pruned; if it is
still full, a login for a new key is refused with `429` rather than evicting an
existing window. Logout asks Identity to revoke
the presented opaque access token directly and clears browser cookies only
after `revoked` or `already_invalid`. Agent event watches have a bounded stream
lease; reconnect repeats normal token resolution.

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
and the complete X-Antnest namespace are removed; CSRF is kept privately for
local comparison. Identity revision 14 resolves the session with a fixed
server-selected audience profile and target Agent; Gateway forwards its CCT
unchanged from private request context. Internal credential response headers
are removed, and principal JSON never serializes the CCT.

Direct WebSocket messages require the original session and an unexpired
handshake CCT. Expiry rejects the next client message and requires reconnect;
it does not cancel previously accepted ACP work. #58 owns in-place renewal.
Console, UI, ACP and Controller consumer enforcement remains pending in their
own batches. Follow the [rollout ledger](../../../contracts/platform/service-authentication-rollout.json)
for local admissions and the final cross-service Docker acceptance.

The browser's `X-Antnest-Expected-Principal` is a private account-switch CAS
guard. After session, administrator and CSRF checks, only the network-policy PUT
compares its one decoded organization/user pair with verified Identity facts.
Gateway rejects a missing/duplicate/mismatched guard with `409 principal_changed`
and regenerates a canonical matching header for Console. Other routes never
receive it. Delegated authorization continues to use the unchanged signed CCT.
