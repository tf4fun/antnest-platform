# Edge Gateway Architecture

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
HTTP limits/security headers
  -> W3C trace extraction/root span
  -> remove known trusted identity/access-subject headers
  -> route match
  -> cookie token resolution (protected routes)
  -> route-specific admission
       -> administrator + CSRF -> Admin Console
       -> Agent access -> Agent ACP Service
      -> authenticated bootstrap -> browser-safe JSON
       -> scoped state observation -> Agent Controller snapshot/watch
  -> Admin Console or Agent UI application proxy
```

Login and logout call Identity Service directly because the Gateway owns the
browser credential boundary. Every administrative command goes to Admin
Console. Workspace bootstrap and ACP admission call Agent Controller's narrow
principal-scoped projection; Gateway never calls Runtime Controller or reads a
service database.

[Workspace state observation](workspace-state.md) is a separate leased GET/SSE
projection of that same authority. Scope comes from the original browser
principal, never from URL query fields. Typed Controller frames are bounded and
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
IDs, names, and availability only. During a same-origin WebSocket upgrade at
`/api/app/agents/{agent_id}/v1/acp` (stable) or
`/api/app/agents/{agent_id}/v2/acp` (draft), Edge resolves the selected Agent again and
injects its opaque access subject into the upstream request. Incoming cookies,
authorization, and forged access-subject headers are not forwarded. The Agent
UI application is served under `/workspace/` with that prefix stripped before
the internal static-service request.

The existing `/api/app/agents/{agent_id}/acp` Workspace route remains a v1
alias. Versions are an explicit route allowlist, not arbitrary upstream paths;
unknown versions return `404`. Both versions use identical upgrade admission,
Origin checks and subject injection. Edge does not translate ACP messages or
infer the version from their content.

After upgrade, a message relay replaces blind byte copying. Each complete
client message is buffered within 64 MiB, then checked against Identity using
the original browser token before being forwarded unchanged. The current
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

The v1 route and its alias also accept POST/GET/DELETE Streamable HTTP through
an opaque reverse proxy. Each request repeats cookie and Agent admission;
POST/DELETE also enforce the existing CSRF policy. A supplied Origin must match;
HTTP clients without Origin are allowed only with the same authentication and
CSRF requirements. Only the four documented ACP/content headers are forwarded,
with authoritative subject and trace context injected by Edge.

GET SSE responses are flushed immediately and live until disconnect or upstream
closure, not an ordinary short request timeout. They consume receive-connection
capacity separately from POST/DELETE message admission. Cancelling the client
HTTP request cancels the upstream receive request; it does not become a
session/cancel command. ACP Service owns connection IDs, expiry and recovery;
Gateway owns no ACP connection registry. HTTP reuses the new-message admission
policy above, including its explicit already-admitted-work boundary.

Login admission consumes bounded per-source and normalized-account windows
before Identity performs Argon2 verification. Logout asks Identity to revoke
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
