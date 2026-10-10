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

Revision 15 defines [browser session lifecycles](browser-sessions.md): separate
idle and absolute deadlines, explicit activity, password rotation, session
inventory and revocation, and the Identity-only `session` CCT profile. Its
method authorization declarations specify the required policy; active caller
grants change with the owning service implementation. Identity, Gateway,
browser consumers and final HTTPS integration have separate admission batches.
The shared contract does not activate those pending behaviors.

OIDC and SCIM payloads keep their standard field names and are not translated
into this RPC envelope. `start_oidc_login.authorization_url` necessarily
contains the one-time OIDC `state` value in its query string; callers must
treat the complete URL as a secret and must not log it. Callback responses do
not return that state value.
