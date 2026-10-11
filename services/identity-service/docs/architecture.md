# Identity Service Architecture

This document describes the Identity Service domain model, application modules,
transaction rules, protocol boundaries, failure semantics, and invariants. The
platform-level identity design is [Stage 2 identity](../../../docs/stage-2-identity.md);
this service directory is the only implementation authority for the service.

## Mission

Resolve enterprise authentication and directory protocols into stable Antnest
principals without importing Agent, Channel, Runtime, or UI concepts.

## Principal Projection

The existing revision-13 principal contract requires Organization slug and
name alongside subject, Organization, Membership, roles, and active state.
All organization-scoped repository builders select those fields from the
already-joined Organization row, including completed OIDC session replay.
Local login returns the metadata read during credential lookup; access-token
resolution and callback replay read the current Organization row rather than
storing display labels in token/session records.

The user-only `getPrincipal` branch remains an internal unscoped actor for
system administration. It is not a principal response on login, token
resolution, or callback routes. `resolve_principal` projects its separate
Organization binding DTO and does not acquire extra response fields.
See the [producer decision and pending consumers](../README.md#principal-response-contract).

## Resource Identifiers

New owned records use `<kind>_<32 lowercase hex digits>` from the
[platform resource ID contract](../../../contracts/resource-identifiers.md).
Bootstrap, local login, directory administration, OIDC, and SCIM request the
specific resource kind from the same secure generator. Existing IDs remain
opaque and unchanged, including SCIM resource references. Token record IDs are
separate from bearer credential bytes.

## Domain Aggregates

### User And OrganizationMembership

`User` is the stable Antnest subject and carries only system-wide role and
status. It does not own an email, display name, credential, or provisioning
source. `OrganizationMembership` is the organization-scoped profile and
carries email, display name, role, active state, source, and SCIM identity. A
User can survive profile changes or deactivation in one Organization without
changing its identity in another Organization.
Administrators attach an existing active User to another Organization by
stable User ID; the repository treats an identical local Membership as an
idempotent result and rejects ownership, role, or active-state conflicts.

`LocalCredential` owns a password hash for one User independently of any
Membership. The system administrator is a User with `system_role=admin`, a
LocalCredential, and a local administrator Membership. Creating an
Organization atomically grants its creator an active local administrator
Membership, so the Organization is usable immediately. OIDC and SCIM can never
create or promote a system administrator.

The current-account application query resolves the active principal, exact
Organization and Membership, then checks only whether its User has a
`LocalCredential`. It projects Organization name/slug and profile fields plus
that boolean, and never returns the credential record or hash. Credential and
Organization presentation facts therefore remain owned by Identity;
presentation services do not guess from Membership source or display internal
IDs as labels.

Local Membership updates are serialized by Organization. Demoting or
deactivating an effective administrator succeeds only when another active
administrator User and Membership remain, so concurrent commands cannot leave
an Organization ownerless. Global User deactivation locks all affected
Organizations in stable order and applies the same invariant before revoking
tokens. SCIM-owned Membership profiles remain writable only through SCIM.

### Group And GroupMembership

A Group belongs to one Organization. Display names are labels, not keys.
GroupMembership points to an OrganizationMembership rather than directly to a
User, making cross-organization edges structurally impossible.

Every edge has a source. A SCIM replacement sees and replaces only
SCIM-owned edges; local edges remain invisible and unchanged. The persistence
model requires Group and edge source to match, so an adapter cannot attach a
SCIM-owned edge to a local Group or vice versa.

### OIDCProvider And ExternalIdentity

OIDCProvider owns discovered endpoints and an encrypted client secret.
ExternalIdentity is immutable at `(provider_id, subject)` and maps to one User
and Membership. New Providers default to `link_policy=none`. First automatic
linking requires an explicit `verified_email` policy, or
`verified_email_in_domains` with an exact canonical ASCII domain match, plus a
verified email matching an active non-system Membership in that Organization.
Administrator Memberships additionally require `authoritative=true`.
An existing binding uses its validated issuer and exact subject independently
of current email, display claims, domain policy or UserInfo availability.
Subjects retain whitespace and case, contain at most 255 Unicode code points,
and reject NUL, invalid UTF-8 and unpaired JSON surrogates before any repair.
OIDC is authentication only: it never creates a User or Membership and never
rewrites a local- or SCIM-owned profile.

Provider identity is `(organization_id, name)`. Neither issuer nor Client ID
can change in place. A different client registration may receive different
pairwise subjects, so reusing its existing external-identity namespace is not
safe. This is a platform constraint, not an OIDC prohibition on registering new
clients; see [OIDC subject identifiers](https://openid.net/specs/openid-connect-core-1_0.html#SubjectIDTypes).
An administrator creates the replacement registration under a new Provider
name; old external identities remain durable for audit. Client-secret rotation
and other non-identity configuration updates remain supported.
Concurrent writes use Provider revision compare-and-swap; one commits
and a stale writer receives `version_conflict` instead of silently replacing
newer discovery data. Secret encryption binds to the stable Organization/name
key rather than a proposed row ID. Enable/disable is a separate idempotent local command:
it never performs discovery, so a retired or unavailable IdP can still be
disabled and the state transition can be audited.

Provider configuration is restricted to system administrators. Its callback
URI comes only from service deployment configuration. Every successful change
increments `revision`; AuthSession pins that value so a callback cannot mix
authorization performed under one configuration with token exchange under
another. Discovery also pins the selected client-secret authentication method
and supported asymmetric ID-token signing algorithms. Provider writes use the
revision as a compare-and-swap token rather than accepting a stale replacement.
Administrative Provider lists use a dedicated metadata query that does not
select client-secret ciphertext or nonce. This is a persistence boundary, not
response-time redaction.

Migration `0006` retains `verified_email` for historical registrations and sets
a durable review flag; it leaves bindings, credentials, revisions and sessions
unchanged. A complete policy plus `acknowledge_link_policy_review=true` clears
the flag. Omitted policy fields preserve all values; secret rotation, enable
changes and a false acknowledgment do not complete review.

Provider mutations lock Provider rows before the actor User. New registrations
serialize per Organization before locking possible name/issuer conflicts, so
an insert conflict cannot reverse that order. Callback issuance locks its auth
session, then Provider, User, Organization and Membership, and rechecks policy
and roles before binding. Browser authority is revalidated after mutation lock
waits.

The external identity application preserves the complete signed Caller for
transactional authorization. Organization controls use the signed organization
and exact target Membership; self controls use the signed User across its
organizations. Migration `0007` preserves historical method/time metadata and
reserves every Provider/subject tombstone while limiting active bindings to
one per Provider/User. Only an explicit administrator restoration can reactivate
the same owner and Membership. New automatic bindings and administrator
bindings/restorations atomically append an audit event and an immutable notice.
Migration does not manufacture notifications for historical bindings.

Binding writers lock Providers, sorted Users, Organizations, Memberships,
mapping rows and browser sessions in that order. A changed set of usable
Providers restarts the entire transaction before any effects. Add-Membership
and SCIM reprovisioning also lock Users before Memberships. Unbind serializes
with callback issuance, revokes only the target Membership's sessions and
publishes its session feed in the same transaction; it never emits principal
offboarding. The final usable-method guard excludes disabled/revoked Providers
and bindings in another Membership. Explicit lockout permission does not relax
caller authorization. Self-revocation still checks the original signed Caller
and deadlines at completion while holding the parent/session locks.

Inventory reads do not touch session activity or acknowledge notices. Binding
and pending-notice pages have independent exclusive ID cursors; organization
responses omit private notices. Acknowledgment validates every requested owned
notice ID before updating any row. An old acknowledgment cannot clear a later
restoration notice. Gateway and browser consumers are delivered in separate batches
in the [shared delivery contract](../../../contracts/identity/oidc-linking.md).
The real HTTPS integration exercises their public routes and both browser
applications, including a held Run that survives binding removal.

Paired SCIM token issuance locks the same-organization Provider before actor
parents and SID, and revalidates the original signed Caller after audit writes.
Migration `0008` adds nullable token/Membership Provider references without
backfilling authority. A paired User creation commits the exact subject binding,
SCIM-actor audit and immutable notice with its new directory resource.

SCIM User creation and deletion first acquire a transaction advisory lock in a
dedicated namespace for the organization. This protects both absence of a
deleted candidate and the newest deleted lineage through commit. Creation then
locks all discovered Providers (including revoked mappings), the issuing token,
User, Organization and old Membership, rechecking the discovered Provider set.
Other or null pairing cannot adopt the old lineage. Reprovisioning changes only
the confirmed old Membership's mapping pointers; method, activation timestamp,
revocation and existing notices stay unchanged. Directory updates do not publish
tombstones and retain optimistic concurrency plus active-resource uniqueness.
Each replacement Membership starts strictly after its confirmed predecessor's
deletion at database microsecond precision, even when the wall clock stays
fixed or moves backwards. Equal highest historical deletion timestamps refuse
reprovisioning rather than selecting a generation by random ID.

### AuthSession And Token

OIDC AuthSession is a short-lived state machine:

```text
pending -> exchanging -> completed
                     `-> failed
```

State is addressed by a SHA-256 hash. One callback claim performs one code
exchange. The initial successful callback returns the access credential once.
A completed callback replay returns only the current principal, original token
ID, both deadlines and activity interval; state is never a credential-retrieval
secret. The callback locks its state before independently resolving the original
live SID, so token/principal facts committed during the wait cannot hide behind
a joined statement's earlier snapshot. Replay does not record browser activity.
Failed or expired
sessions require a new login.
The login deadline applies at completion too: an exchange that finishes at or
after expiry cannot bind an external identity or issue an API token. Persistence
resamples its injected clock after Provider/session and identity row locks,
and again after token insertion; time spent waiting on locks or storage is not
excluded. It checks the stored microsecond deadlines as well as the OIDC workflow
deadline. Its
terminal failure is recorded as `expired`; a callback retry never re-exchanges
the authorization code. A timely completed callback remains replayable as
metadata until its issued access token becomes unavailable.

Failure persistence is detached from a canceled callback only long enough to
record the terminal fact, and is bounded by a five-second deadline. Durable
failure rows contain an internal stage and stable summary, never the raw IdP,
OAuth2, token, claims, or database error text.

The authorization URL returned by the start operation contains the raw
one-time state as OIDC requires. It is the only response that contains state
and must be handled as a secret. The callback response never echoes it.

API and SCIM token rows contain hashes and metadata only. Plaintext exists
only in the issuance response.
Browser tokens have an independent random public reference, an absolute and an
idle deadline, a last-activity timestamp and a bounded display-only user-agent
hint. New local/OIDC credentials initialize activity at issuance. Raw-token,
SID, CCT and completed-callback reads never touch that activity. Before listening,
startup clamps existing unrevoked browser rows to the minimum of their current
idle deadline, absolute deadline and last activity plus configured idle TTL.
The transaction locks token IDs in the same order as bulk revocation; it does
not acquire parent locks. Only a successful commit publishes the immutable
per-Store policy. Data-plane reads use an atomic policy snapshot rather than
holding a configuration mutex across database waits.

The browser-session application service requires an authenticated `Caller`
retaining the original signed CCT. Claims are routing facts; mutations reverify
the signature and current SID using their own database transaction after all
business locks. They do not borrow another pool connection while holding a
transaction. Activity locks only that SID and renews idle expiry without
extending absolute expiry. Inventory is a non-touch read of active sessions,
projects only the independent public reference and display metadata, and uses
an exclusive ascending public-reference cursor.

Self inventory/revocation spans the signed User's Organizations. Administrative
scope always uses the signed current Organization, including for system
administrators, and requires a nondeleted target Membership. Bulk revocation
locks target User then ordered browser rows, and observes fresh actor facts
without acquiring another actor User/Organization/Membership lock. That final
observation is the authorization point for overlapping administrator actions.

Password change is a separate session operation rather than a Directory
credential-only mutation. It locks the User, current Organization/Membership,
and ordered User tokens; revalidates the signed SID and expected password hash;
changes the password; revokes all previous browser sessions; and inserts a
replacement in one transaction. The replacement inherits the original absolute
deadline and display hint. Wrong current password is a business `400`, not a
session authentication failure. The old SID and request ID cannot recover a
secret after a lost response: log in with the new password.
The transaction checks the replacement deadlines after any feed writer wait.
Expiry before commit rolls everything back; expiry first observed after commit
returns no raw credential while retaining the committed password and revocations.

`session_revocations` is a private Gateway feed distinct from principal
offboarding. Actual changed rows determine events and counts. A writer obtains
the table lock before allocating sequence numbers, after business locks; event
rows have no parent foreign keys. Operations that publish both feeds must
publish principal then session. Rollback publishes neither effects nor events.
Membership role changes, local/SCIM deactivation and SCIM deletion persistently
revoke only that Membership's browser rows; global User disable revokes across
Organizations. Logout revokes only its locked SID after fresh nonlocking live
authority checks. Role, password, logout and explicit browser revocations emit
no principal offboarding event and never disable Agents.
Directory role/lifecycle requests carrying a browser Caller revalidate it with
the same transaction after the last business lock and before changing authority.
The check therefore rejects a logged-out waiting administrator while permitting
authorized self-demotion. Trusted internal directory calls may omit browser
context; a present invalid context fails closed, and public RPCs require CCT.
Reactivating a legacy inactive local/SCIM Membership retires any remaining
unrevoked browser rows with `session_revoked`; it does not synthesize a new
principal offboarding event or revoke another Organization's credentials.

OIDC first discovers User/Membership identifiers without locks, then locks User,
Organization and Membership explicitly and revalidates the original email or
subject binding. Existing external mappings are locked and compared after those
parents, matching SCIM reprovisioning. SCIM replacement locks User before
Membership. Role mutations acquire the Organization update lock during initial
authorization, after actor User, without upgrading a shared lock.
Local password verification runs outside a database transaction. Token issuance
must then revalidate the verified password hash and authorization facts against
active Organization, User, and Membership records inside the issuance
transaction: User, Organization and Membership IDs, both roles, and active
state. Organization slug/name are excluded from this comparison, so a rename
between verification and issuance does not reject an otherwise authorized
login. Changed credentials, role bindings, or inactive/deleted membership
reject that login with `unauthenticated`, without an issued-token row or event.
The caller starts a fresh login rather than silently accepting a stale snapshot.
The lock order is User, Organization, then Membership/credential, matching
directory authorization and global deactivation. The relevant rows remain
locked through token/event commit, so a concurrent
disable or password change orders before or after issuance, not between its
authorization check and write. Password rotation revokes the User's existing
browser sessions, as does global User disable. Session revocation does not
cancel already-admitted Agent work or change Agent ownership.
Administrative SCIM lists retain active and revoked metadata for audit and
rotation, but never select the token hash. Listing and revocation require
organization administration; Provider administration requires a system
administrator.

## Application Modules

```text
internal/directory/       organization and local-user commands plus directory queries
internal/localauth/       password login and access-token resolution
internal/browsersessions/ activity, inventory, revocation and atomic password rotation
internal/oidcflow/        Provider configuration and login state machine
internal/oidcclient/      standards-based OIDC discovery and verification adapter
internal/scim/            SCIM resource semantics and HTTP projection
internal/repository/      private PostgreSQL adapters and migrations
internal/rpc/             authenticated JSON transport, workload/CCT admission
internal/serviceauth/     strict workload tokens, TLS/mTLS and JSON parsing
internal/callercontext/   Identity-owned Ed25519 issuer and live-session verifier
internal/server/          status and protocol route composition
internal/telemetry/       OTLP setup and HTTP/application instrumentation
cmd/identity-service/     composition root only
```

Dependencies point inward. Domain/application packages do not import
PostgreSQL, HTTP handlers, OIDC SDK transports, or another service.

## Transactions

Each command calls one repository operation that commits all domain records
and one IdentityEvent atomically. Access-token resolution is an authoritative
read. A conditional `last_used_at` update runs only when the previous sample is
older than five minutes; failure of that operational metadata update does not
change the authorization result and creates no domain event. This is local aggregate consistency,
not a generic cross-module transaction manager. Network calls such as OIDC
discovery and token exchange occur outside database transactions; durable
AuthSession claims make their uncertainty explicit.

Schema migrations run as one ordered transaction under a service-specific
PostgreSQL advisory lock. The migration journal records checksums, rejects
unknown future entries, and prevents two replicas from applying the same DDL.
Bootstrap uses a separate transaction-scoped advisory lock, so concurrent
replicas converge on one Organization, administrator, Membership, and audit
event without resetting an existing password.

## Protocol Boundaries

- Internal JSON RPC follows `contracts/identity/identity-contract.json` and is
  not public OpenAPI.
- OIDC uses Authorization Code, Discovery, PKCE S256, state, nonce, ID Token
  verification, and optional UserInfo. Standard authorization error responses
  terminalize the login session without attempting token exchange. Private
  fields are not injected into protocol success objects. Issuer and discovered
  endpoints require HTTPS, redirects are rejected, remote responses are bounded
  to 1 MiB, and an authorization code is exchanged using one discovered client
  authentication style exactly once. The opaque `sub` value is preserved byte
  for byte.
- The Antnest SCIM Profile supports core User and Group resources, collection
  and item discovery, pagination, exact `eq` filters, PUT, the documented PATCH
  subset, and canonical SCIM errors and locations. User `userName` is an
  organization-scoped identifier and need not be an email; a primary email is
  accepted from `emails` with `userName` as a compatibility fallback when it
  is itself an email. Unsupported PATCH paths fail explicitly instead of being
  ignored.
- SCIM Group DELETE is a real resource deletion. Group membership rows cascade,
  and the same external ID may later create a fresh Group.
- SCIM User `active=false` is reversible deactivation. User DELETE tombstones
  the SCIM Membership and hides it from GET, list, and filter results while the
  global User and audit facts remain. Exact external-ID reprovisioning reuses
  that User only under the same stored Provider pairing (including null),
  creates a fresh SCIM Membership ID, and repoints that exact old Membership's
  durable OIDC identities without restoring revoked bindings.
- SCIM tokens are rotating credentials for one logical directory authority per
  Organization. They do not create separate directory namespaces. Optional
  immutable Provider pairing grants only the additional subject-binding effect;
  another token cannot reinterpret a paired Membership's external ID.

## Persistence Boundary

The PostgreSQL adapter references only tables created by this service's
`migrations/`. External service IDs are opaque values and there are no
cross-service foreign keys or SQL joins.

Within the private schema, composite foreign keys enforce Organization
coherence. An ExternalIdentity must join a Provider and Membership from the
same Organization and User; a completed AuthSession must reference a Token
whose Organization, User, and Membership match the session result.

## Failure Semantics

- Password/token mismatch is a stable unauthenticated result, not an internal
  database error.
- OIDC discovery mismatch leaves the prior Provider revision unchanged.
- Once callback exchange begins, an uncertain exchange never retries the code
  automatically.
- An ambiguous completion result is reclaimed by the same state and accepted
  only when the committed token ID equals the credential generated by that
  callback.
- Startup recovery terminalizes only callbacks whose durable session lifetime
  has expired. It does not fail another replica's still-valid exchange.
- SCIM POST is create-only and returns conflict for an existing resource ID or
  external ID. User creation returns the persisted resource metadata, including
  PostgreSQL timestamp precision, so the response version matches an immediate
  read. PUT/PATCH are transactional updates addressed by resource ID.
- Membership and Group replacement compare the previously read update version
  under row lock; successful writes advance it monotonically at PostgreSQL
  timestamp precision.
- A SCIM mutation accepts one bounded JSON object. Group member references
  must be non-empty, and replacement locks the Group before changing its
  owned membership set.
- Event persistence failure aborts the associated identity mutation.
- Shutdown stops readiness before draining protocol requests.
- Startup and terminal logs expose only stable stage error classes; underlying
  database, OIDC, and credential text is not logged.

## Invariants

1. OIDC and SCIM never create a system administrator.
2. One external subject maps to one User within one Provider forever.
3. One GroupMembership cannot cross Organizations.
4. SCIM cannot enumerate or mutate local-owned directory resources.
5. Raw OIDC state appears only in the start operation's authorization URL; it
   is hashed durably and never logged, traced, journaled, or echoed by callback.
6. No operation reads or writes another service's database.
7. SCIM mutations update only the organization-scoped Membership profile;
   they never rewrite another Organization's profile or a global User subject.
8. Passwords and OIDC subjects are credentials of a User, not User attributes.

## Principal Revocation Delivery

Identity mutations continue to append `identity_events` in the same database
transaction. This general audit journal is private and is not a safe
commit-ordered cursor. `principal_revocations` separately records global User
deactivation, organization Membership deactivation and SCIM deletion in the
same mutation transaction. It contains only the stable User, optional scoped
Organization, reason, occurrence time and originating trace parent.

Writers lock the feed table at the end of the transaction before allocating a
`CACHE 1`, non-cycling sequence. This serializes revocations, not login/audit
traffic; allocation must not be moved before the lock. Rollbacks leave gaps but
cannot leave an earlier uncommitted event behind a consumer's committed cursor.
Scope is constrained by reason: global deactivation has no Organization;
Membership events must have one. No cross-service foreign keys or cascades
erase historical revocations.

Trusted internal `list_principal_revocations` exposes ascending pages of 1..500
records after an exclusive nonnegative cursor. Empty pages return `events: []`
and the unchanged cursor. No feed pruning is implemented; consumers own their
durable cursor and processing state. The
[contract](../../../contracts/identity/principal-revocations.md) defines scope
and replay. Agent Controller consumes this feed with its own durable cursor and
an idempotent Disable workflow. Workspace and history are retained, uncertain
Runtime effects stay fenced or pending, and reactivation never automatically
enables an Agent. Feed delivery itself is not proof of completed Runtime
shutdown; the lifecycle owner publishes that outcome only after confirmed
effects. Identity does not own Agent lifecycle or read Controller storage.

Agent owner validation continues to use the narrow synchronous
`resolve_owner_authorization` for explicit create/enable: activity and the latest
applicable revocation sequence are returned from one SQL statement snapshot.
This avoids ordering authorization by clocks across services. Ordinary access
checks retain the existing
`resolve_principal` RPC: it returns opaque principal facts only and neither
enumerates the directory nor exposes profile data. Its dedicated repository
projection requires a Membership row and computes active state from User,
Membership, and Organization activity without the system-administrator bypass
used by administrative mutations. It therefore requires an active organization
Membership even for a system administrator, and is intentionally stricter than
administrative authorization. Agent Controller uses it to validate an opaque
organization/user binding without reading Identity storage or receiving
profile data.

The `get_current_account` RPC separately returns the signed-in actor's safe
organization profile, Organization name and slug, and an authoritative boolean
that indicates whether a local password credential exists. Internal consumers
use its identity IDs for binding but must explicitly project browser-safe
fields; the RPC never returns credential material.

## Service authentication rollout

Identity implements [RPC revision 14 and its authentication profile](../../../contracts/identity/service-authentication.md).
Its [caller catalog](../../../contracts/identity/callers.json) is enforced before
application calls: verified workload identity, route allowlist, administrative
CCT signature/audience/lifetime, live session and actor/scope matching. The issuer
uses the existing API token ID as `sid`; there is no additional session store.
Receiver hashes and signing/public keys are validated before listening. Secure
listeners and local probes verify platform TLS identities; explicit development
HTTP remains token-authenticated.

Gateway and Console forwarding, other receiver implementations and coordinated
deployment remain separate owning-service batches in the
[rollout ledger](../../../contracts/platform/service-authentication-rollout.json).
This producer batch alone does not complete the browser or cross-service workflow.
