# Verified Organization display metadata

Gateway session contract revision 15 consumes Identity principal revision 14.
Node verifies Gateway workload identity and the signed CCT; display headers
never supply subject, Organization or administrator authority.
`organization_slug` and `organization_name` are required, non-whitespace strings
from the authenticated Organization row. IDs, membership, roles and active state
remain authorization facts; neither label determines scope or administrator access.

## Gateway to Node

Authenticated `/api/app/workspace/v1/*` and `/workspace/*` HTML requests carry
`X-Antnest-Organization-Slug` and `X-Antnest-Organization-Name`. Each header has
exactly one canonical unpadded Base64URL value encoding the exact UTF-8 label.
For example, `engineering` becomes `ZW5naW5lZXJpbmc`; Unicode names use the same
encoding. No URI decoding, trimming, default labels or raw Unicode HTTP headers
are involved. Gateway strips incoming values globally and sets these headers
only from the principal obtained through Identity. Anonymous assets and other
upstreams receive neither value.

Node accepts only the Base64URL alphabet, verifies canonical re-encoding, decodes
UTF-8 strictly and requires a non-whitespace decoded string. Duplicate headers
(including a comma-joined value), padding, invalid UTF-8, missing or empty values
return `401 unauthenticated` before Controller discovery. The private Node
listener verifies workload credentials regardless of network reachability;
display headers do not create an alternative browser identity source. See the
[service-authentication contract](service-authentication.md).

The active bootstrap emits decoded `organizationSlug` and `organizationName`
alongside `userId`, `organizationId` and `administrator`. The shared
[`verifiedWorkspacePrincipal`](workspace-api.schema.json#/$defs/verifiedWorkspacePrincipal)
defines that complete principal. SSR uses the same handler and frontend decoder
as a bootstrap refresh. React renders the name as text with the existing styles.

## Freshness and failure

There is no Organization metadata cache in Gateway or Node. Each authenticated
HTTP request resolves the opaque session token through Identity again. Reloading
SSR or re-fetching bootstrap sees a committed display change while retaining the
same authenticated IDs and administrator semantics. Existing rendered text need
not change until re-bootstrap; display changes do not invalidate Agent sessions,
operations or SSE authorization scope. No continuous rename watcher is added.

Malformed Identity principals yield Gateway `503 identity_unavailable`, preserve
an existing browser session and never reach Node. Inactive or revoked identities
retain the existing `401` and cookie-clearing behavior. Browser JSON and SSR
contain display facts only, never Identity access credentials or token IDs.

## Delivery sequence

1. [#92](https://github.com/tf4fun/antnest-platform/issues/92): freeze this contract,
   add the shared principal definition, implement Gateway and prove its local
   unit/contract/component and Identity-to-Gateway Docker behavior. Leave Node
   and frontend implementations unchanged.
2. [#93](https://github.com/tf4fun/antnest-platform/issues/93): after Gateway
   admission, activate `verifiedWorkspacePrincipal` for the existing bootstrap
   definition, implement Node/SSR/frontend and pass Agent UI local checks.
3. Explicit integration: real local and OIDC sessions through
   Identity → Gateway → Node → browser; re-bootstrap after rename; logout,
   inactive membership and Organization isolation. Record evidence on both issues.

The deprecated Gateway `/api/app/bootstrap` is not expanded. Its removal or
repurposing remains [#64](https://github.com/tf4fun/antnest-platform/issues/64).
