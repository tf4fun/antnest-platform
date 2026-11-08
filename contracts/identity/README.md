# Identity Service Contracts

The directory pagination additions are first published in
[directory-publication-proposal.json](directory-publication-proposal.json).
The owning service activates them with its implementation: Identity revision 19
in #589 and Console version 61 in #590. Before those batches, the active catalogs
remain Identity 18 / Console 60; proposed schemas do not advertise live routes.
The sections below describe the target contract once activated.

Identity Service owns the JSON RPC contract in `identity-contract.json` and
the standard OIDC/SCIM protocol surfaces described in
[`../../docs/stage-2-identity.md`](../../docs/stage-2-identity.md).

The JSON contract requires verified workload identity and route-specific caller
context, as defined by the [Identity authentication contract](service-authentication.md)
and the [platform profile](../platform/service-authentication.md). It is not public OpenAPI.
It records each RPC method, route, request field type, response shape, and the
stable error codes callers may branch on. `$ref` values address definitions in
the same JSON document. `error.http_status_by_code` records non-default HTTP
status mappings; listed error codes without an entry use HTTP 500. Error
envelopes follow the [common error schema](../common/error.schema.json) with the
[Identity slice](../common/slices/identity-service.json) of emitted codes.

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

Revision 19 introduced the bounded directory read methods `list_members` and
`list_groups` (POST `/list-members`, `/list-groups`). Revision 20 is the
current opaque-ID revision binding their standalone
schema [directory.ids-v2.schema.json](directory.ids-v2.schema.json) to the
[shared grammar](../common/ids.schema.json). Requests require
`actor_principal_id`, `organization_id` and integer `limit` (1..200), and accept
an optional canonical `cursor` plus a closed `filter` object (members:
`email_prefix`, `role`, `active`, `source`; groups: `display_name_prefix`,
`active`, `source`). Responses are closed pages of at most 200 items with a
required nullable `next_cursor`; there is no `after` alias. Method entries keep
inline `required`/`properties` for existing contract tooling while `$ref`
targets the standalone schema. `list_directory` remains for one release,
deprecated, with both `users` and `groups` arrays capped at 200 entries; it is
not a stable full-organization listing. Owning-service implementation is delivered
in Identity; the Admin Console consumer and integration batches are pending; this
contract makes no end-to-end workflow claim.

Identity's implementation filters `active` as the effective flag (user `active`
AND membership `active`; groups filter the group's own flag), normalizes
`email_prefix`/`display_name_prefix` by trimming whitespace and lowercasing
(maximum 256 bytes, valid UTF-8), and treats `%`/`_`/`\\` in prefixes as
literal characters rather than LIKE wildcards. Cursors are opaque
base64url-encoded envelopes bound to the page kind, organization, and the
normalized filter fingerprint; they grant no authority and are not a snapshot:
rows inserted behind the current cursor are not retroactively included, while
rows ahead of it may appear on later pages. Cursor misuse, filter changes, or
organization changes all fail closed with `invalid_argument` before any
directory read.
