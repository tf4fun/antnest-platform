# External login administration

Console revision 52 consumes Identity revision 16 and Gateway revision 20 under
the shared [OIDC linking contract](../../../contracts/identity/oidc-linking.md).
Identity owns policy, binding transactions, SCIM pairing, notices and session
revocation. Console supplies management forms and strict public projections.

## Provider policy and SCIM pairing

System administrators configure one complete policy tuple:
`link_policy`, `link_domains` and `authoritative`. New Providers default to
`none`, an empty domain list and false administrator trust. The other choices
permit verified-email linking either in exact allowed domains or for any
verified email. Domain input is canonicalized by the BFF before forwarding:
the shared ECMAScript whitespace set is trimmed, ASCII is required, DNS labels
are lowercased, and canonical duplicates are rejected. Wildcards and URLs are
not domains. Non-authoritative Providers never automatically bind organization
administrators; system administrators cannot sign in through OIDC.

Historical Providers retain `link_policy_review_required` until the operator
submits the complete tuple with an explicit true review acknowledgment. Secret
rotation and enable/disable do not acknowledge review. The API also supports
omitting the entire tuple to preserve the producer's stored policy. Partial
tuples, null fields and an acknowledgment without a tuple are rejected before
an Identity call. Required response policy fields cannot be absent or null.

The last confirmed review warning stays visible while inventory refresh is
loading or unavailable. Only returned Provider metadata changes that warning.
The organization Provider chooser retries the failed page, retaining previous
choices and the selected SCIM pairing.

SCIM credential issuance defaults to directory-only. Organization administrators
can instead choose a Provider from the limited organization chooser, including
a disabled Provider. The resulting `oidc_provider_id` is immutable; metadata
always contains its public ID or explicit null. An omitted input leaves the
grant directory-only; explicit input null is invalid. The one-time credential
stays in page memory and is never stored in browser persistence. Its paired
Provider is displayed in the inventory and issuance receipt.

## Organization membership controls

The Directory exposes external login management for local and SCIM members.
Every BFF operation requires the Gateway workload plus the unchanged verified
CCT. Actor identity and organization come from signed claims. Membership and
binding targets come from validated paths, never override fields in JSON.

- `GET /api/admin/directory/identity-providers?limit=...&after_id=...`
- `GET /api/admin/directory/memberships/{membership_id}/external-identities?limit=...&after_id=...`
- `POST /api/admin/directory/memberships/{membership_id}/external-identities`
- `DELETE /api/admin/directory/memberships/{membership_id}/external-identities/{binding_id}`

Reads require a canonical limit from 1 to 100 and use exclusive public ID
cursors. A cursor may advance beyond the last visible row, including an empty
page. The chooser exposes only ID, name, display, enabled and policy/review
metadata; full IdP configuration remains restricted to system administrators.
Binding responses must match the signed organization and path Membership.
Organization inventory never exposes personal notices.

The binding form preserves the exact provider subject, including whitespace
and Unicode. The BFF rejects invalid UTF-8, unpaired JSON surrogates, NUL and
subjects longer than 255 Unicode scalars. A revoked binding requires a second
explicit restore action after `409 external_identity_restore_required`.
An already assigned subject returns `409 external_identity_conflict`.

Unbinding the last available login method returns
`409 external_identity_last_method`. A separate confirmation submits
`allow_lockout: true`; it does not bypass authorization. Both writes require
an `Idempotency-Key`, issue one request per user action and are never replayed
automatically. Changing the selected Membership remounts the complete dialog,
discarding previous rows, inputs, confirmation and pending reads.

## Personal bindings and notices

The account control is available without a local password or an Agent.
Ordinary members retain the existing redirect to Workspace. Administrator
sessions load personal notices through Gateway when the private Console is
mounted, even while the binding dialog is closed. Notice banners occupy normal
page space so they cannot cover management buttons. Self inventory can include
other organizations and historical notices whose binding or Provider is no
longer present in the current binding page.

Gateway owns the self GET, DELETE and notice acknowledgment routes under
`/api/session/external-identities`. Bindings and notices keep independent rows
and cursors; loading one stream never replaces or advances the other. Reading
does not acknowledge notices or renew the session. Acknowledgment freezes the
exact notice IDs and removes only those IDs after success, including an
idempotent zero count. A restored binding creates a different notice ID.
Bindings display their latest `bound_at`; immutable notices display `created_at`.

Every request keeps the session generation and CSRF delivery hint. Stale
responses, including delayed response bodies and 401s, cannot modify a later
session. Current 401s retire private state; 503s retain it without replay.
If a committed unbind reports `current_revoked: true`, the browser immediately
retires its private view without logging out again or refreshing inventory.
The BFF only accepts that flag for the current signed Membership and a positive
revocation count. These operations return `no-store` and never write Cookies.

## Verification boundary

Service Go tests cover request authority, strict response shapes, Unicode,
policy/null semantics, pairing, paging and revocation. Web tests exercise the
real API parser, component state and desktop/mobile entry points. Built-browser
fixtures and authenticated Console Docker doubles verify the owning consumer.
Their commands and limits are documented in the
[Console acceptance guide](../../../tests/e2e/service-authentication/console/README.md).
Real Identity transactions, both browser applications and HTTPS admission are
verified in the separate integration batch; doubles do not replace that gate.
