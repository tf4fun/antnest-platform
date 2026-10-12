# Identity Service Contracts

Identity Service owns the JSON RPC contract in `identity-contract.json` and
the standard OIDC/SCIM protocol surfaces described in
[`../../docs/stage-2-identity.md`](../../docs/stage-2-identity.md).

The JSON contract requires verified workload identity and route-specific caller
context, as defined by the [Identity authentication contract](service-authentication.md)
and the [platform profile](../platform/service-authentication.md). It is not public OpenAPI.
It records each RPC method, route, request field type, response shape, and the
stable error codes callers may branch on. `$ref` values address definitions in
the same JSON document. `error.http_status_by_code` records non-default HTTP
status mappings; listed error codes without an entry use HTTP 500.

The versioned [password verification policy](password-verification.md) defines
the pending #60 attempt store, shared Argon2 budget, stored-parameter migration
and retryable failures. Its [machine-readable contract](password-verification-policy.json)
is shared first. Identity publishes the active error catalog with its owning
implementation at revision 17; Gateway and Console consumer batches and real
integration follow.
The candidate revision-17 catalog declares `credential_busy`/503 and
`credential_rate_limited`/429. The resource batch implements the busy response;
persistent attempt limits, the 429 projection and transactional rehash are the
next owning-service batch. Consumer and integration work remain pending.

Revision 15 defines [browser session lifecycles](browser-sessions.md): separate
idle and absolute deadlines, explicit activity, password rotation, session
inventory and revocation, and the Identity-only `session` CCT profile. These
producer, consumer and HTTPS integration batches were delivered by #58.

Revision 16 adds [OIDC linking policy and ownership](oidc-linking.md), binding
controls, immutable SCIM token pairing and durable exact-ID notice acknowledgment.
Its method authorization declarations specify the required policy; active caller
grants change with the owning service implementation. Identity's Provider policy
and five binding/notice RPCs implement their producer grants. Identity also
implements paired SCIM token issuance and exact-lineage reprovisioning.
Gateway, Console, Agent UI and final HTTPS integration remain separate pending
#61 batches; the shared contract alone does not deliver these consumers.

OIDC and SCIM payloads keep their standard field names and are not translated
into this RPC envelope. `start_oidc_login.authorization_url` necessarily
contains the one-time OIDC `state` value in its query string; callers must
treat the complete URL as a secret and must not log it. Callback responses do
not return that state value.

## Gateway Resolve cache consumer

Gateway revision 21 reuses the existing Resolve and session-revocation schemas
under the [bounded cache contract](../edge-gateway/resolve-cache.md). Terminal-page
proof depends on the existing commit-order guarantee and fresh authoritative
reads; it does not add an RPC, watermark or Identity migration. The shared
policy, Identity PostgreSQL evidence, Gateway implementation and consumer/HTTPS
integration have separate admission batches.
