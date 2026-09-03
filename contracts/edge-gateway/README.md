# Edge Gateway Contracts

`session-contract.json` defines the Stage 3 browser-session, administrator, and
Agent workspace routes plus the trusted headers Edge Gateway may inject into
internal services. It is a product-facing browser contract, not the future
third-party OpenAPI.

Identity access tokens are cookie-only secrets. Token IDs remain Identity audit
identifiers and are not stored in the browser session. Neither may appear in
the JSON response schemas described by this contract.

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
