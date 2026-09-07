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

```text
HTTP limits/security headers
  -> W3C trace extraction/root span
  -> remove incoming X-Antnest-* headers
  -> route match
  -> cookie token resolution (protected routes)
  -> route-specific admission
       -> administrator + CSRF -> Admin Console
       -> Agent access -> Agent ACP Service
       -> authenticated bootstrap -> browser-safe JSON
  -> Admin Console or Agent UI application proxy
```

Login and logout call Identity Service directly because the Gateway owns the
browser credential boundary. Every administrative command goes to Admin
Console. Workspace bootstrap and ACP admission call Agent Controller's narrow
principal-scoped projection; Gateway never calls Runtime Controller or reads a
service database.

The login page discovers enabled organization OIDC methods through Edge and
starts authorization through a typed Identity call. Identity completes the
callback and returns its one-time access token only to Edge; Edge establishes
the ordinary browser cookies and redirects to the application. OIDC state,
authorization code, and access token never enter a response body, redirect
location, log field, or span attribute.

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
