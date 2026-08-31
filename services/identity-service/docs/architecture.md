# Identity Service Architecture

> Status: Stage 2 implementation contract  
> Updated: 2026-08-31

## Mission

Resolve enterprise authentication and directory protocols into stable Antnest
principals without importing Agent, Channel, Runtime, or UI concepts.

## Domain Aggregates

### User And OrganizationMembership

`User` is the global human/account identity. `OrganizationMembership` is the
organization-scoped directory resource and carries role, active state, source,
and SCIM identity. A User can survive deactivation in one Organization.
Administrators attach an existing active User to another Organization by
stable User ID; the repository treats an identical local Membership as an
idempotent result and rejects ownership, role, or active-state conflicts.

The system administrator is a local User with `system_role=admin`. Creating an
Organization atomically grants its creator an active local administrator
Membership, so the Organization is usable immediately. OIDC and SCIM can never
create or promote a system administrator.

### Group And GroupMembership

A Group belongs to one Organization. Display names are labels, not keys.
GroupMembership points to an OrganizationMembership rather than directly to a
User, making cross-organization edges structurally impossible.

Every edge has a source. A SCIM replacement sees and replaces only
SCIM-owned edges; local edges remain invisible and unchanged.

### OIDCProvider And ExternalIdentity

OIDCProvider owns discovered endpoints and an encrypted client secret.
ExternalIdentity is immutable at `(provider_id, subject)` and maps to one User.
Verified email can bind a SCIM-created membership in the same organization but
cannot take over a local or differently bound identity.

Provider identity is `(organization_id, name)`. The issuer cannot change in
place because doing so would reuse the old subject namespace for a different
authority. An administrator disables the old Provider and creates the new
issuer under a new Provider name; old external identities remain durable for
audit. Concurrent first writes return the canonical persisted Provider ID;
secret encryption binds to the stable Organization/name key rather than a
contending proposed ID. Enable/disable is a separate idempotent local command:
it never performs discovery, so a retired or unavailable IdP can still be
disabled and the state transition can be audited.

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

Failure persistence is detached from a canceled callback only long enough to
record the terminal fact, and is bounded by a five-second deadline. Durable
failure rows contain an internal stage and stable summary, never the raw IdP,
OAuth2, token, claims, or database error text.

The authorization URL returned by the start operation contains the raw
one-time state as OIDC requires. It is the only response that contains state
and must be handled as a secret. The callback response never echoes it.

API and SCIM token rows contain hashes and metadata only. Plaintext exists
only in the issuance response.

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
and one IdentityEvent atomically. Rate-limited token `last_used_at` touches are
operational metadata, not domain events. This is local aggregate consistency,
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
- OIDC keeps standard query, token, and claims semantics. Private fields are
  not injected into protocol success objects.
- SCIM keeps standard schemas, pagination, filters, errors, and locations.
  Unsupported PATCH paths fail explicitly instead of being ignored.
- SCIM Group DELETE is a real resource deletion. Group membership rows cascade,
  and the same external ID may later create a fresh Group.

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
- SCIM writes are transactional and idempotent by resource ID/externalId.
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
