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

Identity revision 18 implements the [SCIM lifecycle contract](scim-lifecycle.md):
bounded token expiry, issuer metadata and authority-loss policy, overlap rotation,
and conditional User/Group writes. The complete RPC schemas require lifecycle
metadata; single-resource responses expose ETag and `meta.version`. Console
version 54 exposes expiry, issuer review and independent rotation controls.
The owning-service batches and current consumer references are delivered;
real HTTPS integration remains pending before #66 can close.

Revision 17 delivered the [password verification policy](password-verification.md)
and its [machine-readable contract](password-verification-policy.json) under #60.
It declares `credential_busy`/503 and `credential_rate_limited`/429, a shared
Argon2 budget, persistent login/password-change attempt limits, transactional
rehash and scheduled cleanup. Gateway, Console and HTTPS integration were
delivered in their own batches; these historical activation revisions remain
unchanged by SCIM lifecycle delivery.

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
Gateway, Console, Agent UI and final HTTPS integration were delivered by #61
in separate batches after their owning-service gates passed.

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
