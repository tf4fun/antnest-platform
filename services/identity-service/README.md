# Identity Service

Identity Service is Antnest's enterprise identity authority. It owns people,
organizations, directory membership, local login, OIDC federation, SCIM 2.0,
and opaque access credentials. It does not own Agents, Channels, Runtimes, or
model credentials.

## Status

Stage 2 implementation is complete and independently deployable. The cross-service contract is
[`../../docs/stage-2-identity.md`](../../docs/stage-2-identity.md); this
directory is the only implementation authority for this service.

## Owns

- Users, Organizations, OrganizationMemberships, Groups, and GroupMemberships.
- OIDC Providers, external identities, and durable login state.
- Local password credentials, API tokens, and SCIM bearer tokens.
- SCIM Users/Groups projection and the Identity event journal.
- Its private PostgreSQL schema and migrations.

## Does Not Own

- Agent access policy, Agent lifecycle, Templates, or Provider model secrets.
- Channel connectors, webhook signatures, or external conversations.
- Runtime deployment, workspace data, network rules, or Tool execution.
- Public gateway sessions, page state, or another service's database.

## Interfaces

| Interface | Direction | Purpose |
| --- | --- | --- |
| `GET /status` | inbound | Liveness/readiness |
| `/rpc/identity/*` JSON RPC | inbound | Trusted internal identity commands and queries |
| `GET /protocol/oidc/callback` | inbound | Standard Authorization Code callback |
| `/scim/v2/*` | inbound | SCIM 2.0 discovery and directory provisioning |
| OIDC discovery/token/UserInfo/JWKS | outbound | Federated login |
| Private PostgreSQL | owned | Identity facts, credentials, events, migrations |

Internal transport is trusted. Administrator mutations still carry a
principal and are authorized against Identity Service's own system or
organization role facts.

## Local Commands

```bash
go test ./...
go test -race ./...
go vet ./...
```

Run the real PostgreSQL profile from the repository root:

```bash
make test-identity-postgres
docker compose --profile stage2 build identity-service
```

See [`docs/architecture.md`](docs/architecture.md) for the module and domain
model and [`docs/operations.md`](docs/operations.md) for configuration,
secrets, readiness, telemetry, and recovery.
