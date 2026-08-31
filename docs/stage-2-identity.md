# Stage 2 Identity Service

> Status: implementation contract  
> Updated: 2026-08-31

## Goal

Identity Service is the sole authority for enterprise principals and directory
membership. Stage 2 must prove one closed path:

```text
bootstrap organization/admin
  -> local login or OIDC login
  -> resolve opaque access token to a principal
  -> SCIM provisions users, groups, and memberships into the same organization
```

It does not create Agents, bind Channels, authorize Agent operations, or read
another service's database.

## Identity Model

The model separates a human identity from its organization-specific directory
resource:

```text
User
  1 -> N OrganizationMembership
OrganizationMembership
  N -> N Group through GroupMembership
User
  1 -> N ExternalIdentity
```

- `User` is a stable Antnest subject. It carries only system-wide role and
  active state; it has no email, display name, provisioning source, or password
  field.
- `OrganizationMembership` carries normalized organization-local email,
  display name, organization role, active state, SCIM resource identity, and
  directory ownership. Email is unique only inside an Organization.
- `LocalCredential` owns the password hash for a User. A User may also have
  multiple OIDC `ExternalIdentity` credentials without changing the User row.
- An administrator may attach an existing active User to another Organization
  by stable User ID. Email matching never creates a cross-organization link.
- `Group` belongs to one Organization. Display name is not identity and need
  not be unique.
- `GroupMembership` has an explicit owner (`local` or `scim`). SCIM replacement
  may only replace SCIM-owned edges, and a database foreign key requires the
  edge and Group to have the same owner.
- `ExternalIdentity` is keyed by OIDC Provider and subject. A verified OIDC
  identity may bind an existing active non-system Membership with the same
  normalized email in that Provider's Organization. Email matching never
  crosses an Organization boundary.
- Provider identity is `(organization_id, name)`. Its issuer is immutable;
  moving to another issuer requires disabling the old Provider and creating a
  new Provider under a new name. The old Provider and external identities stay
  durable for audit, so an old subject namespace is never reinterpreted.
  Enable/disable is idempotent and local; it does not depend on OIDC discovery.
- Every Provider change advances a monotonic revision. A login session pins
  that revision before redirecting and is rejected if configuration changes
  before callback completion.
- A system administrator creating an Organization atomically receives its
  active local administrator Membership; no unusable ownerless Organization
  is committed.

This removes the special case where deprovisioning one tenant accidentally
disables a person's membership in every tenant.

## Owned Persistent Facts

Identity Service owns only its private schema:

```text
organizations
users
local_credentials
organization_memberships
groups
group_memberships
oidc_providers
external_identities
oidc_auth_sessions
api_tokens
scim_tokens
identity_events
schema_migrations
```

There are no cross-service foreign keys, views, queries, triggers, or shared
transactions. IDs referenced by other services are opaque strings.

`identity_events` remains a transactional journal in this stage. Delivery,
consumer cursors, replay, and Agent Controller reactions are completed together
with Agent Controller rather than being guessed in advance here.

## Internal RPC

The machine contract is in
[`../contracts/identity/identity-contract.json`](../contracts/identity/identity-contract.json).
Stage 2 exposes trusted-network JSON RPC for:

- creating organizations and local users, and explicitly adding an existing
  User to another Organization, under administrator authority;
- changing a User's own local password, updating local-owned Memberships, and
  enabling or disabling a global User under the corresponding authority;
- local password login;
- resolving and revoking opaque access tokens;
- listing the organization directory;
- issuing and revoking SCIM bearer tokens;
- configuring OIDC Providers and starting login.

Internal transport is trusted but domain authorization is not skipped. Admin
mutations carry an `actor_principal_id`; Identity Service verifies system or
organization administration itself.

## OIDC Protocol

1. A system administrator configures Provider issuer, client ID, client secret,
   and scopes. The callback URI is service-owned and fixed as
   `ANTNEST_IDENTITY_PUBLIC_BASE_URL/protocol/oidc/callback`; callers cannot
   inject or override it per Provider.
2. Identity Service performs discovery and requires the returned issuer to
   exactly match the configured issuer, including trailing-slash semantics.
   Issuer and every discovered endpoint must use HTTPS. Redirects are not
   followed, and discovery, token, UserInfo, and JWKS responses are bounded to
   1 MiB. Deployment egress policy remains responsible for restricting which
   HTTPS destinations the service may reach.
3. `start_oidc_login` creates durable, expiring state, nonce, and PKCE verifier
   facts and pins the current Provider revision. State is stored only as a
   hash; secrets are encrypted at rest.
4. `GET /protocol/oidc/callback` atomically claims the state before exchanging
   the authorization code.
   A standard OIDC `error` response terminalizes the session without token
   exchange; provider-controlled descriptions and URIs are neither persisted
   nor returned as trusted application text.
5. The ID token must pass signature, issuer, audience, expiry, and nonce
   validation. UserInfo is requested only when the verified ID Token lacks a
   usable email; its `sub` must exactly equal the ID-token subject. OIDC
   subjects are opaque identifiers and are never trimmed or normalized.
6. OIDC never creates a User or Membership. A verified email may bind only an
   existing active non-system Membership in the Provider's Organization.
   Local- and SCIM-owned profile attributes remain authoritative and are never
   refreshed from OIDC claims.
7. `(provider_id, subject)` is immutable. Callback replay returns committed
   principal/token metadata without exchanging the code twice and without
   disclosing the raw access token again.
8. A callback fails deterministically if its pinned Provider revision no longer
   matches current configuration; the user starts a new login with the new
   Provider settings.
9. Provider discovery selects and persists one supported client-secret token
   authentication method and the supported asymmetric ID-token signing
   algorithms. Token exchange uses that method exactly once and never retries
   an authorization code with another client-authentication style.
10. If completion commits but the caller observes an ambiguous database error,
    Identity Service reclaims the same state and returns the in-memory token only
    when the committed token ID is exactly the one generated by that callback.

Provider client secret, authorization code, refresh token, PKCE verifier, raw
state, and ID token never enter logs, traces, events, or callback responses.
The one exception is the required authorization URL returned by
`start_oidc_login`, whose query contains the raw one-time state; callers must
treat that whole URL as a secret and must not log it. The raw Antnest access
token is returned exactly once by the initial successful callback and is never
stored reversibly.
Callback failure persistence stores only a stable internal stage summary and
has a five-second deadline even after the incoming request is canceled.

## SCIM 2.0 Protocol

The Stage 2 profile implements RFC 7643/7644 core Users and Groups at
`/scim/v2`:

- ServiceProviderConfig plus collection and item ResourceTypes/Schemas discovery;
- User create/get/list/replace/patch/deactivate/delete;
- Group create/get/list/replace/patch/delete;
- pagination and exact `eq` filters used by enterprise IdPs;
- Bearer tokens with `scim:read` and `scim:write` scopes;
- canonical SCIM error envelopes and resource locations.

The supported User profile requires the core User schema, a non-empty
case-insensitive `userName`, and one organization-local email. `userName` does
not need to be an email. Email is selected from the sole primary `emails`
entry, otherwise the first non-empty entry, with an email-shaped `userName` as
a compatibility fallback. `displayName` may fall back to `name.formatted` and
then `userName`. Exact `eq` filters are supported for User `userName`,
`externalId`, and `emails.value`, and Group `displayName` and `externalId`.
PATCH supports the fields advertised by discovery, including primary email
replacement and filtered Group member removal; unsupported paths fail with a
SCIM error instead of being silently discarded. Bulk, sorting, ETags, and
password mutation are explicitly unsupported.

Mutation bodies contain exactly one JSON object and are limited to 1 MiB.
Group member references must be non-empty; a Group replacement and its owned
membership set commit as one row-locked transaction. PUT/PATCH use an
optimistic compare-and-swap version and strictly advance `updated_at` even
when two writes observe the same wall-clock tick.

SCIM sees only SCIM-owned organization memberships, groups, and group edges.
It cannot enumerate, mutate, or take ownership of local resources. POST is
create-only: an existing local SCIM resource ID or organization-scoped
`externalId` returns conflict rather than overwriting the resource. PUT/PATCH
are the only update operations; display names are never used as identity.
Group deletion removes the SCIM Group and its SCIM-owned membership edges,
allowing the same `externalId` to create a fresh Group later. The Group core
schema does not invent an `active` attribute.

`active=false` is a visible deactivation and can be reversed by a later SCIM
write. User DELETE is different: the SCIM Membership is tombstoned, disappears
from GET, list, and filters, and can later be provisioned as a fresh resource.
Exact `externalId` reprovisioning reuses the stable global User, creates a new
Membership, and repoints existing OIDC identities to that Membership; it never
reactivates the tombstone. The global User and audit facts remain because they
are not SCIM resources. Multiple active SCIM tokens are rotating credentials
for one logical Organization directory authority, not independent ownership
domains.

## Credentials

- Local passwords use Argon2id with a per-password random salt.
- API and SCIM tokens are random opaque values; only SHA-256 hashes are
  durable. Plaintext is returned once at issuance.
- OIDC client secrets and PKCE verifiers use AES-256-GCM under the required
  service bootstrap key.
- Revocation is durable and idempotent. Token resolution updates bounded
  last-used metadata but never exposes the hash.

## Events And Observability

Every committed identity-domain mutation appends an `identity_events` fact in
the same private transaction. Rate-limited token `last_used_at` touches are
operational metadata and deliberately do not expand the audit journal. The
journal is currently for local audit only, not a completed event bus or
downstream delivery interface.
OIDC start, claim, failure/expiry, and completion events use AuthSession as the
subject and preserve the originating request ID; completion metadata carries
only the resulting token and external-identity IDs.

W3C trace context crosses internal RPC and OIDC discovery/token/UserInfo calls.
Spans cover RPC/SCIM routes, OIDC outbound phases, repository transactions,
and token resolution. Metrics use bounded labels only: route template, method,
result, status, repository operation, and error class. User, organization,
Provider, token, state, subject, email, SCIM resource, event, and raw URL path
values are never metric labels.

Structured logs record event names and bounded error classes. Passwords,
tokens, secrets, claims, protocol payloads, email, and SCIM attributes are not
logged.

## Startup And Failure Semantics

Readiness requires valid configuration, successful private migrations,
PostgreSQL reachability, encryption-key validation, and idempotent bootstrap.
OIDC Providers and external IdPs are request-time dependencies and do not
block service readiness.

Migrations and bootstrap are independently serialized with transaction-scoped
PostgreSQL advisory locks. The migration journal rejects checksums changed in
place and entries newer than the running binary; concurrent replicas converge
on one bootstrap identity and event.

- An OIDC callback claim is durable. An unknown token-exchange outcome makes
  the session failed and requires a new login; it is never guessed or replayed
  with a fresh code.
- An ambiguous database completion is reconciled by state and exact token ID;
  it cannot mint or redisclose a different credential.
- Startup recovery marks only already-expired `exchanging` sessions failed; a
  still-valid callback being processed by another replica is left untouched.
- A database transaction either commits the domain fact and event together or
  exposes no mutation.
- SCIM replacement is one local transaction and preserves local-owned edges.
- OIDC failure finalization cannot hold shutdown indefinitely and never
  persists raw downstream error text.
- SIGTERM clears readiness, drains HTTP, and closes PostgreSQL and telemetry
  within the configured deadline.

## Acceptance

1. Local bootstrap admin can log in and its token resolves to the same User and
   Organization membership.
2. SCIM create/repeat/update/deactivate/delete/recreate for User and
   create/repeat/update/delete/recreate for Group preserve ownership boundaries
   and hide deleted resources.
3. OIDC discovery/login rejects issuer, audience, signature, nonce,
   unverified-email, subject, expiry, and replay failures.
4. Local, OIDC, and SCIM identity paths converge on stable User and Membership
   IDs without cross-organization email matching or profile takeover.
5. Composite PostgreSQL constraints reject cross-organization Provider,
   Membership, external-identity, Token, and AuthSession combinations.
6. Unit tests, real PostgreSQL integration, protocol HTTP tests, race,
   `golangci-lint`,
   formatting, production image build, and independent architecture review
   pass.
