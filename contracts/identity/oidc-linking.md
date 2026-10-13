# OIDC account linking

This defines Identity revision 16, Gateway session revision 20 and Console
revision 52 for [#61](https://github.com/tf4fun/antnest-platform/issues/61).
It extends the delivered [browser session contract](browser-sessions.md).
Identity, Gateway, Console, Agent UI and the Controller revision consumer
implement this contract in separate admission batches. The shared definitions
precede those changes; their combined behavior is verified by the real HTTPS
workflow described below.

## Provider policy

Every Provider exposes `link_policy`, `link_domains`, `authoritative` and
`link_policy_review_required`. The last field is read-only durable state.

| Policy                      | First login without a binding                                                                                                             |
| --------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `none`                      | Refuse with `oidc_membership_required`; require an administrator or SCIM pre-binding.                                                     |
| `verified_email_in_domains` | Require a verified email, an exact allowed domain and an active matching Membership.                                                      |
| `verified_email`            | Require a verified email and an active matching Membership. Administrators explicitly opt into trusting this Provider's email assertions. |

Automatic linking to an organization administrator additionally requires
`authoritative=true`, including for migrated Providers. This is a per-Provider
flag; it does not impose a single authoritative Provider per organization.
System administrators remain ineligible for OIDC linking and login.

New registrations default to `none`, `[]`, `false`. Updating an existing
registration without policy fields preserves all policy values. If any policy
field is supplied, all three must be supplied. Domain lists are nonempty only
for `verified_email_in_domains`; other policies require an empty list. Inputs
are trimmed using ECMAScript WhiteSpace and LineTerminator characters, then
ASCII-lowercased and validated as exact DNS domains, at most
253 characters with labels of at most 63 characters. IDNs use their ASCII
A-label spelling. Wildcards, URLs, ports, trailing dots and empty labels are
invalid. Canonical duplicates are rejected. Domain matching has no implicit
subdomain suffix rule. Lists contain at most 100 entries.

The trim set is U+0009–U+000D, U+0020, U+00A0, U+1680,
U+2000–U+200A, U+2028, U+2029, U+202F, U+205F, U+3000 and U+FEFF.
U+0085 is not trimmed and makes a domain invalid. This rule applies only to
domain configuration; opaque subjects are never trimmed.

Migration sets existing Providers to `verified_email`, `[]`, `false` and
persists `link_policy_review_required=true`. Existing bindings remain usable;
the flag does not undo an earlier unwanted binding. Only an explicit complete
policy submission with `acknowledge_link_policy_review=true` clears it.
Omission, `false`, secret rotation and enable/disable changes preserve it.
The Console explains email trust and the administrator restriction, and keeps
the legacy review warning visible until that explicit review succeeds.

## Identity resolution and ownership

Issuer, audience, signature, protocol state and nonce verification always
apply. A subject is an opaque nonempty string of at most 255 Unicode code points,
compared exactly without trimming, case folding, email normalization or
resource-ID parsing. NUL and unpaired surrogate values are invalid; decoders
must reject them rather than replace or truncate them. Go producers count code
points, not UTF-8 bytes. A validated issuer and exact subject identify an existing
binding. Such a binding does not require a current email or `email_verified`
claim; those claims and domain policy govern first automatic linking only.
Provider enablement and live User/Organization/Membership checks still apply.

For an unbound subject, automatic linking uses the existing normalized email
lookup within the Provider's organization and revalidates the exact User,
Membership, email, policy and roles under locks. It never creates a User or
Membership or searches another organization. `none`, domain mismatch,
unverified email and a non-authoritative administrator match all return the
existing non-disclosing `oidc_membership_required` result. A revoked subject
does not fall back to an email lookup.

`(provider_id, subject)` remains unique across active and revoked history.
`(provider_id, user_id)` is unique among active bindings only. A revoked old
subject therefore does not prevent explicitly binding a new subject, but its
original User ownership is never transferred. A conflict returns
`409 external_identity_conflict`; no operation silently replaces another
active subject or User.

Bindings retain their original `created_at`, last activation `bound_at` and
`method` (`auto`, `admin` or `scim`), plus nullable `revoked_at`. Existing rows
are backfilled as `auto`, with their original creation time and no revocation;
migration does not create new-binding notices. Provider and organization
display fields in binding inventories describe the current records.

## Bind and unbind

`bind_external_identity` requires Console workload identity and live caller
context for an administrator in the signed organization. Identity derives
the target User and organization from `membership_id`; caller JSON cannot
select them independently. Provider and Membership must belong to that
organization. Pre-binding a disabled Provider is permitted, but does not make
it usable until enabled. Existing same-owner active bindings are idempotent:
retries do not change method/time or produce another audit event or notice.

A tombstone returns `409 external_identity_restore_required` unless the
administrator explicitly sends `restore_revoked=true`. Restoration is only
for the original User, into its validated Membership lineage. An already
active different subject for that User/Provider remains a conflict. Each
actual restoration has a new activation time, an `admin` binding event and
a new notice ID. A normal callback, SCIM write or retry cannot restore it.

`unbind_external_identity` accepts `self` only from Gateway and `organization`
only from Console. Self scope derives the User from the live CCT and can
remove that User's bindings across organizations. Organization scope always
uses the CCT organization, including for a system administrator. Authorization
and target ownership are checked before reporting login-method availability.
Organization requests require `membership_id` copied from the Console path;
self requests forbid it. Under locks, Identity requires the binding's current
Membership to equal that exact target. A path for M1 with a binding belonging
to M2 returns `not_found` and makes no session, mapping, audit or feed change.

Before removing an active binding, Identity checks whether a usable sign-in
method remains for the target Membership. A usable local credential must
pass the same active identity checks as local login. An external alternative
must be an active binding to an enabled Provider for that Membership. Other
organizations, disabled Providers, revoked bindings and an email auto-link
policy are not usable alternatives. With none remaining, the default result
is `409 external_identity_last_method`; explicit `allow_lockout=true` permits
the removal in either scope without bypassing authorization. The UI obtains
this decision from Identity, never by counting an incomplete inventory page.

Unbinding atomically marks the mapping revoked, revokes every browser session
of the target Membership, and appends its audit event and session-revocation
feed entries. It does not deactivate the Membership, emit principal
offboarding, disable Agents or cancel accepted Runs. It returns only
`revoked_count` and `current_revoked`; the latter refers to the signed caller's
session. Removing an already revoked binding is an authorized no-op with no
new notice or event. A response after self revocation is the completion of an
already admitted operation, not permission to make further authenticated calls.

## Transactions and races

The callback retains its auth-session lock prefix. Operations that need
Provider state acquire all relevant Provider rows in deterministic ID order
before acquiring User rows. Actor and target User rows are ordered by ID,
then Organization, Membership, mapping and session rows follow the existing
parent-first order; multiple rows at each level use deterministic IDs.
Binding mutations, Provider changes, SCIM pairing/provisioning and callback
issuance must not introduce a User-to-Provider lock inversion. In particular,
an administrator pre-binding their own account cannot hold its User lock
while waiting for a Provider held by a callback.

Read candidate identifiers without locking children, then revalidate them
under the ordered locks. When usable-method checks require several Providers,
lock the relevant set before parents; if the discovered set changes, restart
the transaction rather than taking a new Provider lock after a User lock.
Revalidate live caller session, both deadlines and roles after lock waits and
before committing effects. A stale administrator or changed target cannot
authorize a bind, restore, removal or SCIM credential issue.

If callback issuance commits first, a following unbind includes its issued
session in the revocation transaction. If unbind commits first, the callback
observes the tombstone and cannot issue a session. Mapping ownership, the
active-only uniqueness rule and policy are checked again under locks. Audit,
new-binding notice and binding state commit together; failure rolls all back.

## SCIM pairing

`issue_scim_token.oidc_provider_id` optionally selects one exact Provider in
the signed organization. It is immutable token authorization, not a field
accepted in SCIM User payloads. Token metadata always returns the Provider ID
or `null`; legacy and omitted pairings remain directory-only. Full Provider
configuration stays SystemAdmin-only. The limited organization Provider
chooser supports pairing and pre-binding without exposing IdP configuration.

A new SCIM Membership records the issuing token's pairing. With a pairing,
its nonempty `externalId` is the exact opaque Provider subject, without the
current generic trim behavior. Creation binds that subject transactionally
with method `scim`. Paired User creation and reprovisioning require an
`externalId` satisfying the subject rules above; missing or invalid values
return SCIM `invalidValue` without Membership, binding, session, notice or
audit business changes. The [SCIM lifecycle contract](scim-lifecycle.md) also
leaves token usage unchanged on failed mutations; authentication alone does not
record `last_used_at`. Nonempty means the original string is nonempty, without
trimming. Legacy unpaired credentials retain the optional-field behavior.
A paired subject cannot be replaced or cleared by ordinary
PUT/PATCH. An omitted unchanged field does not remove it. Ordinary directory
attributes, User GET/LIST, Groups and group membership keep their existing
organization scope; pairing does not create a second directory partition.

Pairing only authorizes the matching identity-binding side effect. Directory
CRUD from another credential must not reinterpret a stored `externalId` as a
subject for its own Provider, change Membership pairing, restore a tombstone
or acquire another mapping's ownership. An unpaired Membership may still be
explicitly pre-bound by an administrator without changing its NULL pairing.
Ordinary writes through legacy unpaired tokens remain directory operations.

Reprovision lookup must validate the stored pairing and the exact old
Membership lineage as well as organization and `externalId`. A token paired
to Provider A cannot adopt Provider B's or an unpaired tombstone's User.
Preserve the existing organization-wide SCIM `externalId` uniqueness rule:
such a collision is refused, not merged or reassigned. Repointing a same-owner
binding along a confirmed Membership lineage preserves its revoked state.
Deleting, deactivating, recreating or retrying a SCIM User never silently
restores an explicitly revoked subject. Existing SCIM offboarding remains
applicable to actual directory deactivation; an identity unbind does not use it.

## Inventories and notices

`list_external_identities` uses a required limit of 1–100. Self responses
always contain `bindings` and `notices`; organization responses contain only
`bindings` and reject notice pagination. Each array has an independent
immutable-ID order and exclusive cursor: `after_id` / `next_after_id` for
bindings and `notice_after_id` / `next_notice_after_id` for pending notices.
Terminal cursors are omitted, not null. The same limit bounds each collection.
These are live pages, not a snapshot; refresh begins at the first page.
Cursor validity depends on the ID syntax and order, not continued presence
in the pending set, so acknowledging a page does not break its continuation.

Every new binding or actual restoration records `external_identity.bound`
with its Provider, Membership and method, and creates a durable notice for the
bound User. Notice IDs are distinct from binding IDs. The public notice is an
immutable, independently renderable snapshot of Provider/organization display,
Membership, subject, method and creation time. It stays visible when a binding
is revoked, renamed or absent from the current binding page. No password,
session credential, caller token, Provider secret or private endpoint is exposed.

`acknowledge_external_identity_notices` accepts 1–100 distinct exact notice
IDs for the signed User. Validate the entire set before changing anything;
an unknown or foreign ID returns `not_found` with no partial acknowledgment.
Already acknowledged owned IDs are safe to retry. `acknowledged_count` counts
newly acknowledged rows, so a repeated request can return zero. There is no
sequence watermark, acknowledge-all operation or incidental acknowledgment
on a read. An old acknowledgment cannot hide a new restoration notice.

Both browser applications show the notice and account binding controls,
including for users without local passwords or Agents. Normal notice and
inventory reads do not renew session activity. No email delivery is claimed;
the repository has no account-email notification transport in this batch.

## Browser and Console boundaries

Gateway owns three self routes: GET `/api/session/external-identities`, DELETE
`/api/session/external-identities/{binding_id}` and POST
`/api/session/external-identities/notices/acknowledge`. They use the existing
Identity-only `session` CCT profile. Bodies are closed schemas with no actor,
User, Membership, organization, SID or credential overrides. GET accepts only
canonical bounded `limit` and the two single-value cursors, no body; mutations
accept no query parameters. Shared Origin and CSRF checks still apply.
All responses are `no-store` and none may write Cookies.
Unknown or unowned binding/notice targets preserve `404 not_found`.
The self DELETE preserves `409 external_identity_last_method` so the browser
can request explicit confirmation without guessing from an error message.

Console owns four organization routes under `/api/admin`: the limited
`/directory/identity-providers` chooser and list/create/delete operations at
`/directory/memberships/{membership_id}/external-identities`. Browser bodies
never supply actor or organization scope. Binding paths must match the target
Membership verified by Identity, including when unbinding by binding ID.
Writes require `Idempotency-Key` for audit correlation, not automatic replay.
Chooser and binding projections explicitly permit their public opaque IDs
and organization display fields; this does not widen other resource allowlists.

The two UIs retain the session-generation and CSRF delivery-hint protections
from #58. A current-generation `401` retires private state; a dependency `503`
preserves it. `current_revoked=true` retires the current page immediately and
stops follow-up reads. Delayed reads or acknowledgments cannot restore a prior
account, clear a newer notice or replace a newer login. A last-method conflict
requires an explicit second action with `allow_lockout=true`; no pending write
is automatically retried after login or a transient failure.

## Delivery and acceptance

Identity owns policy/migration and issuer/subject resolution, followed by
binding/SCIM/notice transactions, actual PostgreSQL concurrency and session
feed evidence, including the M1-path/M2-binding rejection with unchanged state.
Gateway owns self routes and grants, Console owns both
account and organization UI, and Agent UI owns its account consumer. Consumers
with exact Identity revision assertions adopt revision 16 in their own
batch. Each batch has its own documentation, unit/contract/component gates
and applicable Docker evidence. `make e2e-browser-sessions-https` runs the real
Identity, Gateway, Console and Workspace with a signed mock OIDC Provider. It proves
default-policy refusal of an asserted administrator email, explicit pre-binding
admission, notice visibility, unbinding, session retirement and forbidden
automatic restoration even after an automatic-linking policy is enabled. Paired
SCIM also proves exact opaque-subject login without an email claim and explicit
last-method lockout. Quiet SSE/WSS retire while an already accepted Run finishes
on the same Runtime. The existing password, revocation and idle-session flows
run afterward in the same HTTPS gate.
