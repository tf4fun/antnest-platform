# Identity Service

Identity Service is the enterprise identity authority for Antnest. It resolves
local login, OIDC federation, and SCIM 2.0 provisioning into stable Antnest
principals and opaque access credentials, so that no other service stores
people, organizations, or credentials. It is written in Go.

The global User is a stable subject with no profile or credential attributes.
Organization-scoped profiles, group edges, local passwords, external OIDC
identities, and tokens are separate records that point at that subject.

## Responsibilities

- Users, Organizations, OrganizationMemberships, Groups, and GroupMemberships.
- OIDC Providers, external identities, and durable login state.
- Local password credentials, API tokens, and SCIM bearer tokens. Credentials
  are separate records and are not attributes of the global User subject.
- SCIM Users/Groups projection and the transactional Identity event journal.
  The general journal is private; `principal_revocations` is the narrow ordered
  cross-service feed defined by the
  [principal revocation contract](../../contracts/identity/principal-revocations.md).
- Narrow internal queries for other services: `resolve_principal`,
  `resolve_owner_authorization`, `get_current_account`, and
  `list_principal_revocations`.
- Its private PostgreSQL schema and migrations.

## Non-responsibilities

- Agent access policy, Agent lifecycle, Templates, or Provider model secrets.
- Channel connectors, webhook signatures, or external conversations.
- Runtime deployment, workspace data, network rules, or Tool execution.
- Public gateway sessions, page state, or another service's database.

## Interfaces

| Direction | Interface | Purpose |
| --- | --- | --- |
| Inbound | `GET /status` | Liveness and readiness |
| Inbound | `/rpc/identity/*` JSON RPC | Authenticated internal identity commands and queries, including current-account capability projection |
| Inbound | `GET /protocol/oidc/callback` | Standard Authorization Code callback |
| Inbound | `/scim/v2/*` | SCIM 2.0 discovery and directory provisioning |
| Outbound | OIDC discovery, token, UserInfo, and JWKS endpoints | Federated login |
| Owned | Private PostgreSQL | Identity facts, credentials, events, and migrations |

Internal requests require the configured workload identity and exact route
caller policy. Administrator bodies carry an audit echo of the Identity-signed
CCT subject; Identity checks the live session, scope and its own role facts
before effects. The [authentication contract](../../contracts/identity/service-authentication.md)
defines token/mTLS, signing keys, JWKS, errors and rotation. Gateway, Console
and deployment adoption are separate pending batches. The internal RPC schema is
[`contracts/identity/identity-contract.json`](../../contracts/identity/identity-contract.json).

### Principal response contract

Local login, access-token resolution, and both initial and replayed OIDC
callbacks return all eight required `principal` fields: `user_id`,
`organization_id`, `organization_slug`, `organization_name`, `membership_id`,
`system_role`, `organization_role`, and `active`. Organization slug and name
come from Identity's Organization row; they are presentation facts, not
authorization inputs.

For [issue #3](https://github.com/tf4fun/antnest-platform/issues/3), the chosen
resolution is to implement the existing contract (option 1). Contract revision
13 stayed unchanged in that fix; it required no schema or database migration.
The authentication batch now advances the RPC envelope to revision 14.
`resolve_principal` still returns the separate, narrower
`organization_principal_binding` shape.

Consumer delivery and verification are recorded in separate service batches:

- [Edge Gateway #92](https://github.com/tf4fun/antnest-platform/issues/92):
  preserves Organization slug/name in its principal and browser sessions,
  and projects verified UTF-8 labels to Node under the revision-14 Gateway
  contract, with its own regression coverage.
- [Agent UI #93](https://github.com/tf4fun/antnest-platform/issues/93):
  consumes that projection in Node bootstrap, SSR and both frontend mappings;
  the chooser and account footer display the real Organization name, with
  its own contract, component and browser tests.
- [Integration tracked in #93](https://github.com/tf4fun/antnest-platform/issues/93):
  verified Identity → Gateway → Agent UI with real local/OIDC sessions after
  both service admissions passed, including display refresh, logout, inactive
  membership and Organization isolation. See the
  [Organization display E2E suite](../../tests/e2e/identity-closeout/README.md#organization-display-integration).

Deployment order is Identity (including #91), Gateway (including #94), then
Agent UI (including #95). See the
[release deployment notes](../../CHANGELOG.md#organization-display-deployment-order)
for the failure behavior when components are upgraded out of order.

## Configuration

| Variable | Required | Default | Description |
| --- | --- | --- | --- |
| `ANTNEST_SERVICE_AUTH_MODE` | Yes | None | Exact `token` or `mtls`; no fallback. |
| `ANTNEST_SERVICE_AUTH_CALLERS_FILE` | Token mode | None | Receiver hash JSON, read once at startup. |
| `ANTNEST_SERVICE_AUTH_ALLOW_INSECURE_TRANSPORT` | No | `false` | Exact `true` only permits disposable development HTTP in token mode. |
| `ANTNEST_TLS_CA_FILE`, `ANTNEST_TLS_CERT_FILE`, `ANTNEST_TLS_KEY_FILE`, `ANTNEST_TLS_SERVER_NAME` | Secure transport | None | Complete platform TLS configuration; exact service URI identity and DNS verification. |
| `ANTNEST_IDENTITY_CCT_SIGNING_KID`, `ANTNEST_IDENTITY_CCT_SIGNING_KEY_FILE`, `ANTNEST_IDENTITY_CCT_JWKS_FILE` | Yes | None | Exact signing ID, separate Ed25519 PKCS8 private key, bounded public JWKS. See the signing contract. |
| `ANTNEST_IDENTITY_DATABASE_URL` | Yes | None | Private PostgreSQL URL. |
| `ANTNEST_IDENTITY_ENCRYPTION_KEY` | Yes | None | Canonical base64 encoding of exactly 32 bytes; AES key for OIDC client secrets. |
| `ANTNEST_IDENTITY_PUBLIC_BASE_URL` | Yes | None | Absolute base URL for the OIDC callback and SCIM locations. No credentials, query, or fragment. HTTPS is required unless the host is `localhost`, `127.0.0.1`, or `::1`. A trailing `/` is removed. |
| `ANTNEST_IDENTITY_LISTEN` | No | `:8080` | Listen address. `--healthcheck` follows its configured host and port; missing/wildcard hosts use `127.0.0.1`. |
| `ANTNEST_IDENTITY_TOKEN_TTL` | No | `12h` | Local and OIDC access-token lifetime. Positive Go duration. |
| `ANTNEST_IDENTITY_OIDC_SESSION_TTL` | No | `10m` | OIDC login state lifetime. Positive Go duration. |
| `ANTNEST_IDENTITY_HTTP_TIMEOUT` | No | `10s` | Outbound OIDC request deadline. Positive Go duration. |
| `ANTNEST_IDENTITY_SHUTDOWN_TIMEOUT` | No | `15s` | Graceful shutdown deadline. Positive Go duration. |
| `ANTNEST_BOOTSTRAP_ORGANIZATION_SLUG` | Conditional | None | Initial Organization slug. The four bootstrap variables are all set or all empty. |
| `ANTNEST_BOOTSTRAP_ORGANIZATION_NAME` | Conditional | None | Initial Organization name. |
| `ANTNEST_BOOTSTRAP_ADMIN_EMAIL` | Conditional | None | Initial local system administrator email. |
| `ANTNEST_BOOTSTRAP_ADMIN_PASSWORD` | Conditional | None | Initial administrator password, 12 to 1024 bytes. Not trimmed. |
| `ANTNEST_ENVIRONMENT` | No | None | Recorded as the `deployment.environment.name` telemetry resource attribute. |
| `ANTNEST_TELEMETRY_CAPTURE_RPC_CONTENT` | No | `false` | `true` records RPC parameters and results, including user credentials; issued CCTs are always omitted. Must be `true` or `false`. |
| `OTEL_SDK_DISABLED` | No | None | `true` installs propagation only and exports nothing. |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | No | None | OTLP HTTP base endpoint. A signal is exported only when this or its per-signal endpoint is set, or its exporter is `otlp`. |
| `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT`, `OTEL_EXPORTER_OTLP_METRICS_ENDPOINT`, `OTEL_EXPORTER_OTLP_LOGS_ENDPOINT` | No | None | Per-signal OTLP endpoints. |
| `OTEL_TRACES_EXPORTER`, `OTEL_METRICS_EXPORTER`, `OTEL_LOGS_EXPORTER` | No | None | `otlp` or `none` per signal. |
| `OTEL_EXPORTER_OTLP_PROTOCOL` and per-signal `OTEL_EXPORTER_OTLP_<SIGNAL>_PROTOCOL` | No | `http/protobuf` | Only `http/protobuf` is supported. |
| `OTEL_SERVICE_NAME` | No | `identity-service` | Telemetry service name. Other resource attributes are read from the standard OpenTelemetry resource environment. |

`--healthcheck` uses the same configured IPv4/IPv6 address as the primary
listener, with the existing token HTTP opt-in or pinned TLS service identity.
It disables environment proxies and refuses redirects; only the local `/status`
response can report health. This follows the
[purpose-listener deployment contract](../../contracts/platform/service-authentication.md#5-networkdeployment-batch).

Bootstrap is enabled when the bootstrap variables are set. Repeated startup
verifies the same identity and never resets an existing password. See
[Operations](docs/operations.md) for bootstrap stability rules and secret
handling. Never use the Compose development defaults outside a disposable
development environment.

## Dependencies

- Private PostgreSQL database. Startup fails without it, and readiness requires
  a bounded database probe to succeed.
- External OIDC Providers. They are request-time dependencies and do not affect
  readiness.
- No other Antnest service. Agent Controller, Admin Console, and Edge Gateway
  call this service; it never calls them or reads their storage.

## Build and test

Run unit tests from `services/identity-service`:

```bash
GOWORK=off go test ./...
```

Run these commands from the repository root:

```bash
node tests/integration/go/run.mjs identity-service
make test-identity-postgres
docker compose --profile stage3 build identity-service
```

Repository and protocol integration tests live in
[`tests/integration/go/identity-service`](../../tests/integration/go/identity-service).
The root runner uses a Go overlay to compile them in their original service
packages, so they can use internal helpers without duplicating test source.
`make test-identity-postgres` starts an isolated PostgreSQL dependency and runs
the PostgreSQL suite. The suite covers workload authentication, CCT issuance/live-session revocation,
strict JSON/media types, real token-TLS/mTLS handshakes, and deterministic
login-admission races and
a local HTTPS OIDC fixture (authorization redirect, PKCE, client
authentication, signed ID token, and JWKS). It also checks completion
deadlines, immutable client registration, and secret rotation.
Real handler responses are validated against the central principal JSON
Schema. PostgreSQL tests check every principal builder, both OIDC callback
paths, fresh organization metadata on token resolution, and organization
renames during local login without weakening password/role/status checks.
`node tests/e2e/service-authentication/identity/run.mjs` checks this owning service
in an isolated Identity/PostgreSQL stack. The broader `make e2e-identity-core`
remains a final integration gate after Gateway/Console adoption; it checks token
resolution inside the disposable Docker network, before the Gateway/SCIM/OIDC
suite.

Root `make` targets that cover this service: `make fmt-check`, `make lint`,
`make test-go`, `make test-identity-postgres`, and `make docker-build-stage3`.

Test-only variables:

- `ANTNEST_IDENTITY_TEST_DATABASE_URL` points the PostgreSQL suite at a
  dedicated disposable database, for example when running
  `node tests/support/verification/go-service.mjs identity-service` against an
  existing development PostgreSQL instance. Never point tests at business data.

## Documentation

- [Architecture](docs/architecture.md) - domain model, modules, transactions, protocol boundaries, and invariants.
- [Operations](docs/operations.md) - startup, readiness, bootstrap, secrets, protocol operations, and recovery.
- [Observability](docs/observability.md) - spans, metrics, content capture, and database tracing.
- [Stage 2 identity](../../docs/stage-2-identity.md) - platform identity design.
- [Identity contracts](../../contracts/identity/README.md) - RPC schema and principal revocation feed.
- [Resource identifiers](../../contracts/resource-identifiers.md) - platform ID format.
