# Console authentication and delegated actor (#25/#26)

This owning-service batch follows the
[platform authentication contract](../platform/service-authentication.md).
Every application, asset and administrative route requires the immediate
`edge-gateway` workload. The catalog's local `/status` probe remains the only
health exception. Unknown API routes retain their deny policy.

Administrative routes additionally require exactly one unchanged CCT. Console
verifies Ed25519, strict JOSE/header/claim shape, `admin-console` audience,
issuer, 60-second maximum lifetime and at most 30 seconds of tolerance. Agent
routes compare `agt` with the actual route parameter. Other administration is
organization-scoped. The signed subject, organization, membership and roles
construct the principal; X-Antnest headers never authenticate or select it.
Existing system/organization administrator checks remain mandatory.

Console obtains bounded public JWKS only from the configured, authenticated
Identity origin. Cache trust expires after 30 seconds. A refresh uses the
dependency timeout, serializes concurrent requests and allows at most one
unknown-kid refresh per five seconds; unavailable or expired trust fails closed.
No token header selects a URL, key, algorithm or deployment. Identity alone
performs the live `sid` recheck before its administrative effects.

Identity, Controller, ACP and optional Registry connections use exact shared
service token/mTLS configuration. Complete TLS configuration pins their DNS and
service URIs. Credential files are validated before listening and re-read per
request; no cached token, redirect or legacy Registry-wide Authorization token
is accepted. Outgoing RPCs carry the private request CCT unchanged and derive
actor/scope payloads from its verified principal. Public provider-model discovery
continues to use its separate provider client; service credentials are never
attached to provider origins.

JSON operations require exactly one `application/json` content type, with only
optional UTF-8 charset. Body parsing rejects duplicate/case aliases and extra
documents before effects; existing multipart Skill upload routes keep their
separate size and structure rules. Credentials and CCTs are excluded from
browser projections, logs and RPC-content/trace capture. Consumer and deployment
admissions remain separate; final cross-service Docker E2E follows all batches.
