# ACP workload and caller context (#26/#27)

The [platform contract](../platform/service-authentication.md) fixes the token,
mTLS and signed CCT profiles. This owning-service contract adds listener placement.

`ANTNEST_ACP_LISTEN` (default `:8080`) serves ACP, signed workspace observation,
Console audit and Registry source reads. `ANTNEST_ACP_CONTROL_LISTEN` (default
`:8081`) serves only `POST /rpc/agent-acp/apply-execution-snapshot`,
`POST /rpc/agent-acp/settle-agent` and minimal `GET /status`. The workspace
listener returns 404 for the two Controller paths, including unsupported methods
and query variants, before reading their bodies. The control listener returns
404 for every other path and denies WebSocket upgrades. State get/watch remain
on the workspace listener because their callers are Gateway and Agent UI.

Control calls require verified `agent-controller` workload identity. There is
no separate legacy control bearer, no user CCT, and no body-selected caller.
Missing or invalid workload credentials return 401 `service_unauthenticated`
with the token challenge; a verified wrong service returns 403
`caller_not_allowed`. The accepted snapshot revision cannot move backwards.

Both listeners use the same mandatory shared token/mTLS configuration; startup
opens both before reporting readiness and closes both if either bind fails.
Deployment must bind them to their separate caller networks, not merely attach
a wildcard listener to several networks. That wiring and authenticated Controller
client adoption belong to later owning batches. Cross-service E2E is deferred
until final integration.

ACP and workspace routes require exactly one Identity-signed CCT with ACP
audience and `agt`, then repeat current local Agent and Session authorization.
Audit calls additionally require Console workload and a signed organization-scoped
administrator. Controller operations and Registry source reads rely on their
exact workload allowlist and retain their existing operation checks.
Unsigned `X-Antnest-*` fields never select authority.

Identity JWKS is read only through the configured, authenticated
`ANTNEST_ACP_IDENTITY_URL` origin. Token files are validated before listening
and reread per outgoing request. Optional Controller learning-policy and Registry
clients use their separate fixed origins and per-receiver credentials. Runtime
outbound authentication remains pending the RC-owned private instance connection
reference in #29/#30; execution fences and maintenance tickets remain mandatory.

Expired CCTs reject new HTTP requests and new WebSocket methods. A WebSocket
closes with 1008 and `caller_context_expired`; already accepted model work is
not cancelled, and permission replies for accepted work may settle. Long-lived
renewal belongs to #58. No new ACP refresh frame is introduced.

JSON POSTs require one `application/json` content type with only optional UTF-8
charset. Strict UTF-8, duplicate members, extra documents and exact-case domain
schemas are checked before effects; malformed JSON returns 400, oversized bodies
413 and unsupported media/encoding 415. The SDK still owns ACP connection IDs,
message routing, SSE and DELETE closure. Rejected DELETE bodies cannot close an
accepted SDK connection. Credentials and CCTs are not persisted or captured in
logs, trace attributes or RPC content.

## Provider destinations (#28)

Actual model calls use the [shared destination policy](../platform/provider-destination-policy.md)
independently of private workload transports. All DNS answers are rechecked per
completion and sockets are pinned to approved literal IPs with original TLS/Host
identity. Redirects, environment proxies and private credentials are excluded.
Only exact operator configuration can opt into private endpoints; snapshots,
Templates and caller context cannot. Existing Run receipt classifications add
`provider_endpoint_forbidden` and `provider_endpoint_unavailable` within their
existing string contract; ACP messages and browser DTOs do not change.
