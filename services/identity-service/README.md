# Identity Service

Identity Service is Antnest's enterprise identity authority. It owns people,
organizations, directory membership, local login, OIDC federation, SCIM 2.0,
and opaque access credentials. It does not own Agents, Channels, Runtimes, or
model credentials.

## Status

The identity model and the documented OIDC/SCIM profile are independently
deployable. A narrow `resolve_principal` RPC lets Agent Controller validate an
opaque organization/user binding without reading Identity storage or receiving
profile data. It requires an active organization membership even for a system
administrator; it is intentionally stricter than administrative authorization.
The `get_current_account` RPC separately returns the signed-in actor's safe
organization profile, Organization name/slug, and an authoritative boolean
indicating whether a local password credential exists. Internal consumers use
its identity IDs for binding but must explicitly project browser-safe fields;
the RPC never returns credential material.
The internal `list_principal_revocations` RPC supplies a durable, replayable
deactivation feed, separate from synchronous authorization and the general audit
journal. Agent Controller now consumes it with a durable cursor and idempotent
Disable operations; C2-05 Docker acceptance covers scoped/global/SCIM revocation
and offline catch-up. Workspace and history are retained, uncertain Runtime
effects stay fenced/pending, and reactivation never automatically enables an
Agent. Create/Enable use `resolve_owner_authorization` to read the active owner
and latest revocation sequence atomically. Identity still does not own Agent
lifecycle or read Controller storage. The service contract is
[`../../docs/stage-2-identity.md`](../../docs/stage-2-identity.md); this
directory is the only implementation authority for this service.

## Owns

- Users, Organizations, OrganizationMemberships, Groups, and GroupMemberships.
- OIDC Providers, external identities, and durable login state.
- Local password credentials, API tokens, and SCIM bearer tokens. Credentials
  are separate records and are not attributes of the global User subject.
- SCIM Users/Groups projection and the transactional Identity event journal.
  The general journal is private; `principal_revocations` is the narrow ordered
  cross-service feed. See the [delivery contract](../../contracts/identity/principal-revocations.md).
- Its private PostgreSQL schema and migrations.

## Does Not Own

- Agent access policy, Agent lifecycle, Templates, or Provider model secrets.
- Channel connectors, webhook signatures, or external conversations.
- Runtime deployment, workspace data, network rules, or Tool execution.
- Public gateway sessions, page state, or another service's database.

## Interfaces

| Interface                          | Direction | Purpose                                         |
| ---------------------------------- | --------- | ----------------------------------------------- |
| `GET /status`                      | inbound   | Liveness/readiness                              |
| `/rpc/identity/*` JSON RPC         | inbound   | Trusted internal identity commands and queries, including current-account capability projection |
| `GET /protocol/oidc/callback`      | inbound   | Standard Authorization Code callback            |
| `/scim/v2/*`                       | inbound   | SCIM 2.0 discovery and directory provisioning   |
| OIDC discovery/token/UserInfo/JWKS | outbound  | Federated login                                 |
| Private PostgreSQL                 | owned     | Identity facts, credentials, events, migrations |

Internal transport is trusted. Administrator mutations still carry a
principal and are authorized against Identity Service's own system or
organization role facts.

## Local Commands

```bash
go test ./...
go test -race ./...
golangci-lint run ./...
```

Run the real PostgreSQL profile from the repository root:

```bash
make test-identity-postgres
docker compose --profile stage2 build identity-service
```

Unit tests remain in this service. Repository and protocol integration tests
live in [`tests/integration/go/identity-service`](../../tests/integration/go/identity-service).
The root runner uses a Go overlay to compile them in their original service
packages, preserving access to internal helpers without duplicating test source.
With `ANTNEST_IDENTITY_TEST_DATABASE_URL` set to a dedicated disposable database,
run the integration suite from the repository root:

```bash
node tests/integration/go/run.mjs identity-service -- -race
```

The PostgreSQL suite includes deterministic login-admission races plus a local
HTTPS OIDC fixture (authorization redirect, PKCE, client authentication, signed
ID token and JWKS). It checks completion deadlines, immutable client registration,
and successful secret rotation. These are service-owned component tests, not
Gateway/browser acceptance. To reuse a development PostgreSQL instance, supply
`ANTNEST_IDENTITY_TEST_DATABASE_URL` for a dedicated disposable database and run
`node tests/support/verification/go-service.mjs identity-service` from the
repository root; never point tests at business data.

See [`docs/architecture.md`](docs/architecture.md) for the module and domain
model and [`docs/operations.md`](docs/operations.md) for configuration,
secrets, readiness, telemetry, and recovery.
