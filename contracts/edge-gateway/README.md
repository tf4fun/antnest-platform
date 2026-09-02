# Edge Gateway Contracts

`session-contract.json` defines the Stage 3A browser-session routes and the
trusted principal headers Edge Gateway may send to internal presentation
services. It is a product-facing Console contract, not the future public
third-party OpenAPI.

Identity access tokens are cookie-only secrets. Token IDs remain Identity audit
identifiers and are not stored in the browser session. Neither may appear in
the JSON response schemas described by this contract.

OIDC and SCIM path prefixes are reserved before their pass-through adapters are
connected. Requests receive a structured `503 protocol_unavailable`; they can
never fall through to the Console SPA and return misleading HTML success.
