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
and Membership. A new verified OIDC identity may bind an existing active,
non-system Membership by normalized email, but only inside the Provider's
Organization. It never searches another Organization. This permits local,
SCIM, and multiple OIDC credentials to identify the same organization member
without making email a global User key.
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

### AuthSession And Token

OIDC AuthSession is a short-lived state machine:

```text
pending -> exchanging -> completed
                     `-> failed
```

State is addressed by a SHA-256 hash. One callback claim performs one code
exchange. The initial successful callback returns the access credential once.
A completed callback replay returns only the committed principal, token ID,
and expiry; state is never a credential-retrieval secret. Failed or expired
sessions require a new login.
The login deadline applies at completion too: an exchange that finishes at or
after expiry cannot bind an external identity or issue an API token. Persistence
resamples its injected clock after Provider/session and identity row locks,
before token insertion; time spent waiting on those locks is not excluded. Its
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
authorization check and write. This does not retroactively revoke sessions on
password rotation or cancel already-admitted Agent work; those are separate
contracts. Global User disable continues to revoke that User's existing tokens.
Administrative SCIM lists retain active and revoked metadata for audit and
rotation, but never select the token hash. Listing and revocation require
organization administration; Provider administration requires a system
administrator.

## Application Modules

```text
internal/directory/       organization and local-user commands plus directory queries
internal/localauth/       password login and access-token resolution
internal/oidcflow/        Provider configuration and login state machine
internal/oidcclient/      standards-based OIDC discovery and verification adapter
internal/scim/            SCIM resource semantics and HTTP projection
internal/repository/      private PostgreSQL adapters and migrations
internal/rpc/             trusted internal JSON transport
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
  that User, creates a fresh SCIM Membership ID, and repoints any durable OIDC
  identity to the new Membership.
- SCIM tokens are rotating credentials for one logical directory authority per
  Organization. They do not create separate ownership namespaces.

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
  external ID. PUT/PATCH are transactional updates addressed by resource ID.
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
