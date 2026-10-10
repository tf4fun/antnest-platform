# Browser session security

This contract defines the Gateway session boundary for #62. API Origin and
Fetch Metadata admission remain independent and follow [public entry](public-entry.md).
Identity owns token validity and user authority; the Gateway owns browser
cookies and CSRF verification.

## Cookie modes

With `ANTNEST_EDGE_COOKIE_SECURE=true` (the default), the only accepted and
emitted session names are `__Host-antnest_session` and `__Host-antnest_csrf`.
Both have `Secure`, `Path=/`, no Domain and `SameSite=Lax`; only the session
cookie is HttpOnly. This includes Secure-cookie loopback development. The
Gateway never falls back to unprefixed cookies in this mode.

The explicit `ANTNEST_EDGE_COOKIE_SECURE=false` mode is restricted to a literal
loopback HTTP listener by the public-entry contract. Only this mode uses
`antnest_session` and `antnest_csrf`. It retains the same session-bound CSRF
verification. A session cookie is required for authentication. Missing the CSRF
delivery cookie does not prevent a read or a mutation with a correct derived
header. If either configured cookie is supplied, an empty, malformed or
duplicate value invalidates the request. Cookies from the other mode do not
authorize a request.

## Session-bound CSRF

The token is exactly `base64url(HMAC-SHA256(key, UTF8(token_id)))`, without
Base64 padding. `token_id` is the stable Identity token identifier, never the
browser's claimed value, a timestamp or a caller-context JWS identifier.
Local login and OIDC completion already return it; subsequent resolution uses
the `sid` in the authenticated Identity response's caller context. That field
is defined in the [Identity authentication contract](../identity/service-authentication.md).
The Gateway validates the existing CCT ID grammar (1–200 characters, no
whitespace or control characters) and keeps the identifier private, outside
browser response JSON and downstream presentation headers. Invalid issuer
framing or a missing session identifier is an unavailable Identity response.

Login and OIDC completion deliver the derived value in the CSRF cookie. An
authenticated mutation must contain exactly one `X-Antnest-CSRF-Token` whose
value equals the server derivation for the freshly resolved session. Compare
in constant time. The cookie is a delivery mechanism; matching a caller's
cookie and header is not proof. A value from another session, or a planted
cookie/header pair, fails with `403 csrf_failed`. CSRF never grants identity
or substitutes for the Origin check.

Logout resolves an existing session before verifying its bound CSRF value and
revoking its token. No-session logout may clear cookies without an Identity
call after Origin admission. Malformed cookies and invalid or inactive sessions
clear cookies with `401 unauthenticated`; transient Identity failures preserve them and return
`503 identity_unavailable`. A failed CSRF check never revokes the session.
Identity does not issue a caller context for an inactive session, so this path
only clears browser state and does not promise persistent token revocation.
Further lifecycle and sign-out-everywhere behavior is tracked by #58.

## Key provisioning and upgrade

`ANTNEST_EDGE_CSRF_KEY_FILE` names a regular file containing exactly 32 raw
secret bytes. Missing, unreadable or incorrectly sized keys prevent startup;
there is no generated per-process fallback. The key is independent of workload,
CCT, Runtime and encryption keys. All Gateway replicas serving the same public
origin use the same key. The process reads it at startup; never log its bytes.

The development credential helper creates `edge-gateway/csrf.key` in its fresh,
private credential tree with mode 0600. Compose exposes it through the existing
read-only Gateway credential file mounts. Existing deployments add this independent
key without replacing workload credentials or application databases, then
restart the Gateways with the configured file. An upgrade from unprefixed
production cookies requires signing in again. Key rotation also requires a
coordinated Gateway rollout and fresh login to obtain the new CSRF value;
there is no rolling dual-key acceptance promise in this revision.

Gateway supplies `Cross-Origin-Opener-Policy: same-origin` and
`Cross-Origin-Resource-Policy: same-origin` defaults. These headers complement
the document owner's CSP and do not change the independent session checks.

## Admin origin phase 2

The current Console and Workspace continue to share the public origin. This
revision does not provide an XSS privilege boundary between those applications.
The next origin-separation phase requires a distinct configured Admin origin,
host or listener admission before routing, Console and admin APIs on that host,
and Workspace/UI APIs on the workspace host. Each host needs its own host-only
session cookie. Establishing an admin session must require a fresh password or
OIDC round trip; workspace authentication must not silently mint admin cookies.
Both hosts need explicit session/login/logout and OIDC callback routes. Define
their callback registration, CSRF key scopes, navigation and deployment tests
before introducing `ANTNEST_EDGE_ADMIN_ORIGIN` or claiming that isolation.

## Delivery batches

1. Shared contract and private development-key provisioning.
2. Gateway producer: cookie modes, trusted session ID, bound CSRF, logout,
   startup validation and response headers, with unit and component evidence.
3. Admin Console CSRF reader and its service tests.
4. Agent UI CSRF reader and its service tests.
5. Scripted clients and isolated Docker fixture keys/cookies.
6. HTTPS integration: login, Console writes, Workspace writes and logout;
   reject tossed cookies, cross-session replay and legacy production cookies.

Each consumer and the integration batch require their own admission evidence;
the Gateway producer alone does not complete the browser workflow.
