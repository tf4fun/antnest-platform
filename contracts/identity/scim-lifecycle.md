# SCIM token lifecycle and resource versions

This is the shared contract for [issue #66](https://github.com/tf4fun/antnest-platform/issues/66).
The [policy](scim-lifecycle-policy.json) and
[extension schemas](scim-lifecycle.schema.json) define the shared behavior.
Identity revision 18 implements its token lifecycle and resource versions; the
complete RPC request and response shapes are in the active
[Identity catalog](identity-contract.json). Console version 54 implements expiry,
issuer review and rotation controls with its own service admission. Current
consumer references align with Identity 18 and Console 54; a separate real HTTPS
integration batch remains pending. The extension schema
definitions validate field projections, not entire RPC envelopes.

## Issuance, expiry and rotation

The `issue-scim-token` RPC accepts optional integer `expires_in_days` in 1–365;
omission means 90 days. Null, strings, fractions and values outside the range are
invalid. A new expiry is the authoritative time sampled within the issuance
transaction after lock waits, plus that many 24-hour days. Token use never extends
it. The token is expired when `expires_at <= now`.

Identity owns `expires_at`, `issued_by` and `issuer_review_required`. The issuer is
the verified global User ID, never a Membership ID or a browser-supplied authority
field. Existing verified caller-context checks still apply. Issuance and listing
return all three metadata fields; the token credential is returned only once by
issuance. Inventory never returns credentials or hashes.

Rotation issues another token with the same name, scopes and immutable
`oidc_provider_id`. A current verified administrator authorizes issuance, becomes
the new issuer and chooses a valid TTL. The new token has a new ID and credential;
the original token and its own expiry remain unchanged. Install and exercise the
new credential in the provisioning client, then explicitly revoke the original.
There is no automatic revocation after issuance or after the first new-token use.
A failed or ambiguous issuance must not trigger automatic replay.

## Issuer authority and migration

`ANTNEST_IDENTITY_SCIM_REVOKE_ON_ISSUER_LOSS` defaults to true; invalid values fail
startup. When true, loss of effective administration authority revokes the
issuer's unrevoked tokens in the affected organization. When false, it persists
`issuer_review_required=true` and an audit event instead. The tokens can remain
usable under the ordinary expiry, scope, organization and revocation checks.
Global User deactivation applies across organizations. Organization membership
demotion, deactivation or removal affects that organization's tokens; loss of one
membership alone does not remove a SystemAdmin's remaining effective authority.
These changes and their audits commit in the same transaction as the authority
change. Restoring authority neither reactivates revoked tokens nor clears a
review flag. Rotation produces a new independently authorized token.

Migration `0010_scim_lifecycle.sql` backfills expiry from each token's
`created_at + interval '1 year'`, not from deployment time. This calendar-year
backfill differs intentionally from new issuance's fixed-day TTL. Already expired
rows become immediately unusable; revoked rows are never reactivated. Issuer
recovery requires exactly one distinct existing User named by a same-organization
`scim_token.issued` audit for that token. Missing or ambiguous evidence produces
`issued_by=null` and `issuer_review_required=true`; it must not guess the issuer.
Unknown legacy issuers cannot be evaluated for authority loss, so their flagged
tokens remain subject to expiry and explicit revocation, even with the default
policy. Administrators must rotate or revoke them.

Before readiness, the new service reconciles known issuers against current
effective authority using the configured policy. Migration warnings report
aggregate counts without credentials, hashes or user/token identifiers. An old
binary does not enforce the new policy merely because columns exist: deployment
must retire old Identity instances before declaring lifecycle enforcement active.
An already-running old instance continues without that enforcement. Starting an
old binary against the upgraded migration journal normally fails its unknown-
migration check, so a binary-only rollback is not a supported recovery path.

For every User and Group mutation, middleware authorization is only an initial
check. The write transaction locks and rereads the token and relevant authority
and pairing state, checks scope, active organization, revocation and fresh expiry
after lock waits, and refuses before committing side effects if admission is lost.
Issuance and manual revocation likewise recheck the verified caller after waits.
No business lock is acquired after a revocation-feed writer lock; existing
principal-feed-before-session-feed ordering is preserved. Audit failure rolls
back the business mutation and lifecycle effects together.

Mutation commands retain the acting token's own Provider pairing separately
from the target resource. The locked token must match that authorization
snapshot; another pairing does not partition the organization's existing
directory. Group writes lock incoming User and Membership parents before the
Group, and User deletion locks affected Groups before the Token. This prevents
a concurrent Group write from adding a reference to a deleted Membership.
For a historical SCIM-managed administrator, User deactivation or deletion also
locks the acting token and all affected issuer tokens as one ordered set. Expiry
is rechecked after the whole set is locked, before evaluating `If-Match`.
An admitted request may intentionally revoke its own token in the same
transaction; this does not extend its original expiry or skip the final check.
The admitted expiry is checked again after all audit and revocation-feed waits,
so a late refusal rolls back resources, usage, browser revocations and both
feeds in the same transaction.

Directory administrator changes likewise lock the caller and target browser
sessions as one ordered set after the authority parents and issuer tokens.
They recheck the signed CCT and session deadlines after the final audit and feed
writes, including activation and idempotent calls. Intentional self-demotion or
Membership deactivation may revoke the caller's own session, but still uses its
original idle/absolute deadlines and signed CCT validity. Global self-disable
retains its existing conflict response.

## ETag representation

Single User and Group GET, POST, PUT and PATCH responses return an `ETag` header
and identical `meta.version`, generated as `W/"<persisted updated_at UnixNano>"`.
List entries also include their resource's `meta.version`. This follows SCIM's
resource-version surface and weak-version examples.
[RFC 7643 §3.1](https://www.rfc-editor.org/rfc/rfc7643.html#section-3.1),
[RFC 7644 §3.14](https://www.rfc-editor.org/rfc/rfc7644.html#section-3.14).

Versions use the timestamp actually stored by PostgreSQL, including on create
and replace responses. Effective changes advance it monotonically at database
microsecond precision even when the supplied clock is unchanged or moves backward.
User fields and their version must describe one consistent snapshot; changing
global User active status also advances all affected SCIM Membership versions in
that transaction. User PATCH preserves Membership activity unless an active
operation explicitly changes it; the response's active field remains
`User.Active && Membership.Active`. Group fields, member IDs and version likewise
come from one snapshot. Deleting a User advances affected Group versions before
removing their member references. ServiceProviderConfig advertises
`etag.supported=true` only with the Identity implementation.

## Conditional writes

User and Group PUT, PATCH and DELETE accept `If-Match`. This SCIM profile compares
opaque version text exactly and accepts either weak or strong syntax with that
same opaque value. This is a SCIM compatibility choice; generic HTTP `If-Match`
requires strong comparison and would not match the generated weak tag.
[RFC 9110 §13.1.1](https://www.rfc-editor.org/rfc/rfc9110.html#section-13.1.1).

Repeated fields combine as a comma-separated entity-tag list. Space and tab are
allowed around list elements. A standalone `*` matches an existing resource;
mixing it with tags or another wildcard is invalid. Empty list members are
tolerated up to the limits below; a present but empty list matches nothing.
Quoted commas belong to opaque text, not list separators. Only uppercase `W/`
is a valid weak prefix. Valid but unknown opaque text, including leading-zero or
very large decimal strings, simply does not match. Client tags are never parsed
into integers or timestamps. These list and entity-tag syntax rules follow
[RFC 9110 §5.6.1](https://www.rfc-editor.org/rfc/rfc9110.html#section-5.6.1)
and [§8.8.3](https://www.rfc-editor.org/rfc/rfc9110.html#section-8.8.3).

The combined value is limited to 8,192 bytes, 64 entity-tags and 64 empty list
members. Malformed or over-limit input returns SCIM `400 invalidSyntax`.
Authorization, scope and normal missing-resource `404` behavior precede
conditional evaluation. A missing resource is not converted to a conditional
failure. The transaction compares against the locked, current resource version
before writes or audit/feed emission; a nonmatching condition returns
`412` with `scimType: "mutability"`.

The client precondition and the existing internal request-snapshot CAS remain
separate. The server may have computed a PUT/PATCH update from an earlier read.
Even when a wildcard or multi-tag condition still matches the locked resource,
a changed internal read baseline returns the existing `409` conflict, preventing
an old computed update from overwriting a concurrent change. An absent header
keeps the existing internal CAS behavior. DELETE compares the current locked
version and does not add an artificial request-snapshot CAS. Neither side retries
a failed mutation automatically.

## Console and admission evidence

The Console explicitly projects `expires_at`, `issued_by` and
`issuer_review_required`, accepting a null issuer only for a review-required
legacy token. It accepts the optional issuance TTL without browser-owned issuer
or expiry fields. Token status precedence is revoked, expired, expiring soon,
active; expiry equality means expired, while positive remaining lifetime up to
and including 14 days means expiring soon. Issuer review is a separate indication.
Rotation retains immutable Provider pairing as well as name and scopes.

The new credential remains only in the one-time response and current modal.
Closing the modal clears it; a failed clipboard operation or inventory refresh
does not discard the only displayed copy. Responses use `Cache-Control: no-store`
and do not mutate Cookies. Neither browser nor BFF automatically replays issuance,
rotation or revocation.

Identity admission requires unit and contract evidence for input bounds, config,
parser, errors and version projection; real PostgreSQL evidence for expiry and
post-wait rechecks, both issuer-change/issuance orderings, transaction rollback,
scope isolation, legacy migration, snapshot precision and stale-write refusal;
and its applicable service Docker gate. Console admission requires its own
request/response projection, clock-boundary and credential-dialog evidence.
These producer and consumer gates do not prove the complete workflow. The final
real HTTPS Docker batch must provision a User, use both credentials during the
rotation overlap, revoke the original and prove only the new one still works;
it also verifies ETag/If-Match through Gateway. Test sources remain in their
owning services or root `tests/`; private evidence belongs in
`artifacts/verification/`, never `.cache/`.
