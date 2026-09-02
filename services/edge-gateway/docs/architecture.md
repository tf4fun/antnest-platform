# Edge Gateway Architecture

## Request Pipeline

```text
HTTP limits/security headers
  -> W3C trace extraction/root span
  -> remove incoming X-Antnest-* headers
  -> route match
  -> cookie token resolution (protected routes)
  -> administrator admission and CSRF (when required)
  -> trusted principal projection
  -> Admin Console proxy
```

Login and logout call Identity Service directly because the Gateway owns the
browser credential boundary. Every other administrative command goes to Admin
Console. Gateway never calls Agent Controller or Runtime Controller.

Login admission consumes bounded per-source and normalized-account windows
before Identity performs Argon2 verification. Logout asks Identity to revoke
the presented opaque access token directly and clears browser cookies only
after `revoked` or `already_invalid`. Agent event watches have a bounded stream
lease; reconnect repeats normal token resolution.

`/protocol/oidc` and `/scim/v2` are reserved routes. Until their Identity
pass-through adapters are connected they return structured
`503 protocol_unavailable`; route matching cannot send protocol traffic to the
Console SPA.

## Failure Semantics

- missing, expired, revoked, or inactive credentials return `401`;
- an active non-administrator returns `403`;
- a state-changing request with a missing or mismatched CSRF token returns
  `403` without reaching Admin Console;
- Identity or Console transport failure returns `503` with a stable error code;
- exhausted login admission returns `429` before Identity password verification;
- retryable logout revocation failure returns `503` and preserves the cookies
  required to retry;
- upstream application status and JSON are preserved after admission.

Access tokens, passwords, cookies, Provider secrets, and OIDC state are never
logged or added to span attributes.

## Extension Rules

OIDC callback and SCIM pass-through replace the reserved handlers when they are
added. Business resource routes, cross-service aggregation, and domain retries
belong to the owning service or presentation BFF, not this Gateway.
