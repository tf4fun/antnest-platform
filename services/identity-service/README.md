# Identity Service

Identity Service is the enterprise identity authority for Antnest. It resolves
local login, OIDC federation, and SCIM 2.0 provisioning into stable Antnest
principals and opaque access credentials, so that no other service stores
people, organizations, or credentials. It is written in Go.

The global User is a stable subject with no profile or credential attributes.
Organization-scoped profiles, group edges, local passwords, external OIDC
identities, and tokens are separate records that point at that subject.

Workload authentication and CCT parsing/verification use the
[shared Go module](../../modules/service-authentication/README.md). Identity owns
signing keys, issuance, live-session authorization and revocation; library
verification failures are mapped to Identity domain errors.

Startup rejects published database passwords and 32-byte uniform encryption
keys under the [development secret policy](../../contracts/platform/development-secrets.md).
The exact independent `ANTNEST_ALLOW_PUBLIC_DEV_SECRETS=true` opt-in logs one WARN
per affected variable. A published bootstrap password is rejected only when
creating a new administrator under the bootstrap lock; existing accounts are
not rejected or reset by that unused value.

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
- Browser activity, public session inventory, scoped session revocation and
  atomic password/session rotation, with a separate Gateway-only
  `list_session_revocations` feed. These follow the
  [browser session contract](../../contracts/identity/browser-sessions.md).
  Gateway, Console, Workspace and script consumers use these controls;
  `make e2e-browser-sessions-https` verifies the deployed browser lifecycle.
- Its private PostgreSQL schema and migrations.

## Non-responsibilities

- Agent access policy, Agent lifecycle, Templates, or Provider model secrets.
- Channel connectors, webhook signatures, or external conversations.
- Runtime deployment, workspace data, network rules, or Tool execution.
- Public gateway sessions, page state, or another service's database.

## Interfaces

| Direction | Interface                                           | Purpose                                                                                               |
| --------- | --------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| Inbound   | `GET /status`                                       | Liveness and readiness                                                                                |
| Inbound   | `/rpc/identity/*` JSON RPC                          | Authenticated internal identity commands and queries, including current-account capability projection |
| Inbound   | `GET /protocol/oidc/callback`                       | Standard Authorization Code callback                                                                  |
| Inbound   | `/scim/v2/*`                                        | SCIM 2.0 discovery and directory provisioning                                                         |
| Outbound  | OIDC discovery, token, UserInfo, and JWKS endpoints | Federated login                                                                                       |
| Owned     | Private PostgreSQL                                  | Identity facts, credentials, events, and migrations                                                   |

Internal requests require the configured workload identity and exact route
caller policy. Administrator bodies carry an audit echo of the Identity-signed
CCT subject; Identity checks the live session, scope and its own role facts
before effects. The [authentication contract](../../contracts/identity/service-authentication.md)
defines token/mTLS, signing keys, JWKS, errors and rotation. Gateway, Console
and deployment adoption are separate pending batches. The internal RPC schema is
[`contracts/identity/identity-contract.json`](../../contracts/identity/identity-contract.json).

### Principal response contract

Identity revision 18 implements [SCIM token lifecycle and resource versions](../../contracts/identity/scim-lifecycle.md).
Issuance accepts optional `expires_in_days` (1–365, default 90); issuance and
inventory return `expires_at`, `issued_by` and `issuer_review_required` without
exposing stored hashes. Expired credentials are rejected, issuer authority loss
revokes or flags tokens, and User/Group responses expose ETag and `meta.version`
with conditional PUT/PATCH/DELETE. Stale conditions return 412 and retain the safe
`precondition_failed` code in request spans, error events and completion logs
without exporting credentials. Rotation issues an independent credential; the
original remains usable until expiry or explicit revocation. Console 54
provides lifecycle display and rotation controls; current consumer references
are aligned. The separate HTTPS acceptance batch exercises real Console issuance,
overlapping credentials, conditional writes, expiry, issuer loss and organization
isolation against the production Identity image.

The revision-16 Provider policy batch defaults new OIDC registrations to no
automatic email linking. Explicit domain/email trust and an additional
authoritative flag govern first-time administrator linking. Migration preserves
historical member linking with a durable review warning. Existing issuer/subject
bindings do not depend on email claims or UserInfo. Optional profile claim
type errors are treated as absence; they never become verified email authority.
SCIM token metadata returns its immutable `oidc_provider_id`, or explicit null
for directory-only credentials. A paired token requires an exact opaque
`externalId` on User creation and atomically binds that subject with a notice.
Identity also owns explicit administrator binding/restoration, self and exact
Membership inventories, atomic unbinding/session revocation, and durable
notice acknowledgment by ID. Revoked subjects remain reserved and cannot be
restored by an ordinary callback. These five RPCs require both their exact
workload grant and a live browser Caller. SCIM reprovisioning preserves the
confirmed owner's pairing, activation history and any explicit revocation.
Gateway and browser consumers are delivered in separate batches; see the
[OIDC linking contract](../../contracts/identity/oidc-linking.md).

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

`ANTNEST_IDENTITY_SCIM_REVOKE_ON_ISSUER_LOSS` defaults to `true`. Setting it to
`false` records a durable review flag instead of revoking tokens when their
issuer loses effective administration authority; invalid Boolean values fail
startup. All instances must use the same policy. See the
[SCIM deployment and recovery procedure](docs/operations.md#scim-lifecycle-deployment).

Password hashing and verification share one process engine. Optional
`ANTNEST_IDENTITY_ARGON2_MEMORY_KIB` (65536),
`ANTNEST_IDENTITY_ARGON2_ITERATIONS` (3),
`ANTNEST_IDENTITY_ARGON2_PARALLELISM` (2),
`ANTNEST_IDENTITY_ARGON2_MEMORY_BUDGET_KIB` (131072), and
`ANTNEST_IDENTITY_ARGON2_MAX_CONCURRENT` (bounded GOMAXPROCS default)
are validated at startup. See [password resource admission](docs/operations.md#password-resource-admission)
for bounds, queue limits, stored-hash compatibility and cancellation behavior.
Identity revision 17 returns `credential_busy`/503 for resource admission and
`credential_rate_limited`/429 for persisted login and password-change backoff, with bounded
`Retry-After` and `Cache-Control: no-store`. Migration `0009` stores private
attempt keys. Login holds ordered attempt and authority locks through password
verification, optional policy rehash, account reset and token/event commit.
Password changes use the global User counter across Organizations and commit
verification, rotation, all-session revocation and User-counter reset atomically.
The original signed Caller is revalidated after waits and KDF work. Each instance
cleans at most 500 expired attempt rows after an initial minute and waits another
minute after each pass. Shutdown cancels and joins that worker before closing
the database. Gateway 22 and Console 53 consume the typed password failures.
The HTTPS integration suite verifies two Identity instances, competing attempts,
transactional rehash/rotation, browser Cookie preservation and explicit recovery.

| Variable                                                                                                        | Required         | Default            | Description                                                                                                                                                                                         |
| --------------------------------------------------------------------------------------------------------------- | ---------------- | ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ANTNEST_SERVICE_AUTH_MODE`                                                                                     | Yes              | None               | Exact `token` or `mtls`; no fallback.                                                                                                                                                               |
| `ANTNEST_SERVICE_AUTH_CALLERS_FILE`                                                                             | Token mode       | None               | Receiver hash JSON, read once at startup.                                                                                                                                                           |
| `ANTNEST_SERVICE_AUTH_ALLOW_INSECURE_TRANSPORT`                                                                 | No               | `false`            | Exact `true` only permits disposable development HTTP in token mode.                                                                                                                                |
| `ANTNEST_TLS_CA_FILE`, `ANTNEST_TLS_CERT_FILE`, `ANTNEST_TLS_KEY_FILE`, `ANTNEST_TLS_SERVER_NAME`               | Secure transport | None               | Complete platform TLS configuration; exact service URI identity and DNS verification.                                                                                                               |
| `ANTNEST_IDENTITY_CCT_SIGNING_KID`, `ANTNEST_IDENTITY_CCT_SIGNING_KEY_FILE`, `ANTNEST_IDENTITY_CCT_JWKS_FILE`   | Yes              | None               | Exact signing ID, separate Ed25519 PKCS8 private key, bounded public JWKS. See the signing contract.                                                                                                |
| `ANTNEST_IDENTITY_DATABASE_URL`                                                                                 | Yes              | None               | Private PostgreSQL URL.                                                                                                                                                                             |
| `ANTNEST_IDENTITY_ENCRYPTION_KEY`                                                                               | Single-key mode  | None               | Canonical padded Base64 for exactly 32 bytes; maps to `local-v1`. Cannot coexist with the ring.                                                                                                     |
| `ANTNEST_IDENTITY_ENCRYPTION_KEYS`                                                                              | Ring mode        | None               | Comma-separated exact `kid:base64key` entries. Retain old keys for decrypting OIDC client and login-session secrets.                                                                                |
| `ANTNEST_IDENTITY_ENCRYPTION_ACTIVE_KID`                                                                        | Ring mode        | None               | Exact member of the ring; only this key wraps new secrets.                                                                                                                                          |
| `ANTNEST_IDENTITY_PUBLIC_BASE_URL`                                                                              | Yes              | None               | Absolute base URL for the OIDC callback and SCIM locations. No credentials, query, or fragment. HTTPS is required unless the host is `localhost`, `127.0.0.1`, or `::1`. A trailing `/` is removed. |
| `ANTNEST_IDENTITY_LISTEN`                                                                                       | No               | `:8080`            | Listen address. `--healthcheck` follows its configured host and port; missing/wildcard hosts use `127.0.0.1`.                                                                                       |
| `ANTNEST_IDENTITY_SESSION_IDLE_TTL`                                                                             | No               | `30m`              | Positive browser inactivity duration; background reads never extend it.                                                                                                                             |
| `ANTNEST_IDENTITY_SESSION_ABSOLUTE_TTL`                                                                         | No               | `12h`              | Positive maximum lifetime for local and OIDC browser credentials.                                                                                                                                   |
| `ANTNEST_IDENTITY_TOKEN_TTL`                                                                                    | No               | Unset              | Absolute-TTL alias for one release. Unequal explicit alias/new durations fail startup.                                                                                                              |
| `ANTNEST_IDENTITY_OIDC_SESSION_TTL`                                                                             | No               | `10m`              | OIDC login state lifetime. Positive Go duration.                                                                                                                                                    |
| `ANTNEST_IDENTITY_HTTP_TIMEOUT`                                                                                 | No               | `10s`              | Outbound OIDC request deadline. Positive Go duration.                                                                                                                                               |
| `ANTNEST_IDENTITY_SHUTDOWN_TIMEOUT`                                                                             | No               | `15s`              | Graceful shutdown deadline. Positive Go duration.                                                                                                                                                   |
| `ANTNEST_BOOTSTRAP_ORGANIZATION_SLUG`                                                                           | Conditional      | None               | Initial Organization slug. The four bootstrap variables are all set or all empty.                                                                                                                   |
| `ANTNEST_BOOTSTRAP_ORGANIZATION_NAME`                                                                           | Conditional      | None               | Initial Organization name.                                                                                                                                                                          |
| `ANTNEST_BOOTSTRAP_ADMIN_EMAIL`                                                                                 | Conditional      | None               | Initial local system administrator email.                                                                                                                                                           |
| `ANTNEST_BOOTSTRAP_ADMIN_PASSWORD`                                                                              | Conditional      | None               | Initial administrator password, 12 to 1024 bytes. Not trimmed.                                                                                                                                      |
| `ANTNEST_ENVIRONMENT`                                                                                           | No               | None               | Recorded as the `deployment.environment.name` telemetry resource attribute.                                                                                                                         |
| `ANTNEST_TELEMETRY_CAPTURE_RPC_CONTENT`                                                                         | No               | `false`            | `true` records RPC parameters and results, including user credentials; issued CCTs are always omitted. Must be `true` or `false`.                                                                   |
| `OTEL_SDK_DISABLED`                                                                                             | No               | None               | `true` installs propagation only and exports nothing.                                                                                                                                               |
| `OTEL_EXPORTER_OTLP_ENDPOINT`                                                                                   | No               | None               | OTLP HTTP base endpoint. A signal is exported only when this or its per-signal endpoint is set, or its exporter is `otlp`.                                                                          |
| `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT`, `OTEL_EXPORTER_OTLP_METRICS_ENDPOINT`, `OTEL_EXPORTER_OTLP_LOGS_ENDPOINT` | No               | None               | Per-signal OTLP endpoints.                                                                                                                                                                          |
| `OTEL_TRACES_EXPORTER`, `OTEL_METRICS_EXPORTER`, `OTEL_LOGS_EXPORTER`                                           | No               | None               | `otlp` or `none` per signal.                                                                                                                                                                        |
| `OTEL_EXPORTER_OTLP_PROTOCOL` and per-signal `OTEL_EXPORTER_OTLP_<SIGNAL>_PROTOCOL`                             | No               | `http/protobuf`    | Only `http/protobuf` is supported.                                                                                                                                                                  |
| `OTEL_SERVICE_NAME`                                                                                             | No               | `identity-service` | Telemetry service name. Other resource attributes are read from the standard OpenTelemetry resource environment.                                                                                    |

`--healthcheck` uses the same configured IPv4/IPv6 address as the primary
listener, with the existing token HTTP opt-in or pinned TLS service identity.
It disables environment proxies and refuses redirects; only the local `/status`
response can report health. This follows the
[purpose-listener deployment contract](../../contracts/platform/service-authentication.md#5-networkdeployment-batch).

Choose exactly one encryption configuration. Every key, including decrypt-only
members, passes development-secret admission. `identity-service rekey
[--batch-size N]` rotates both OIDC tables without changing provider revisions
or pending login state; it requires only database and encryption configuration.
See [rotation operations](docs/operations.md#encryption-key-rotation) and the
[shared contract](../../contracts/platform/encryption-key-rotation.md). New
envelopes require this version of the binary; do not downgrade after new writes.

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
node tests/e2e/service-authentication/identity/run.mjs
docker compose --profile stage3 build identity-service
```

Repository and protocol integration tests live in
[`tests/integration/go/identity-service`](../../tests/integration/go/identity-service).
The root runner uses a Go overlay to compile them in their original service
packages, so they can use internal helpers without duplicating test source.
`make test-identity-postgres` starts an isolated PostgreSQL dependency and runs
the PostgreSQL suite. The suite covers workload authentication, CCT issuance/live-session revocation,
strict JSON/media types, real token-TLS/mTLS handshakes, browser session
activity/inventory/rotation, atomic lifecycle feeds, legacy reactivation, and
deterministic login/password/role/startup lock races. It includes
a frozen nanosecond-clock RPC regression that compares returned login and
activity deadlines exactly at PostgreSQL's stored microsecond precision, and
a local HTTPS OIDC fixture (authorization redirect, PKCE, client
authentication, signed ID token, and JWKS). It also checks completion
deadlines, immutable client registration, secret rotation, policy/domain/role
admission, raw subject encoding, migration-review persistence and Provider-first
locking. Role changes during actual database waits are revalidated before linking.
SCIM lifecycle coverage includes migration and pre-listen reconciliation,
issuer loss under both policies, expiry after actual row/audit/feed waits,
atomic usage and rollback, ordered caller/target session locks, consistent
User/Group versions and independent If-Match/CAS conflicts. The service-owned
Docker fixture exercises the production Identity image, PostgreSQL and a signed
HTTPS IdP; it is separate from the later cross-service HTTPS acceptance.
Real handler responses are validated against the central principal JSON
Schema. PostgreSQL tests check every principal builder, both OIDC callback
paths, fresh organization metadata on token resolution, and organization
renames during local login without weakening password/role/status checks.
Password resource component tests share one real engine across bootstrap,
dummy preparation, login, user creation and password change. They exercise
200 independent unknown-account RPCs, reconcile busy responses with KDF
rejections, and verify budget drain and subsequent successful login. The local
fixture warms 48 PostgreSQL connections (above two active plus 32 queued KDFs),
leaving schema administration room under the diagnostic relay's 64-connection
ceiling. Historical/malformed hashes and stopped admission are covered; full-row
snapshots check that rejected work preserves credentials, tokens and revocation
feeds. Production-container RSS requires its separate Docker pressure gate.
Attempt-state PostgreSQL tests cover migration preservation, shared counters
across Store instances, fifth/sixth serialization, blocked-Organization row
growth, fresh time after lock waits, bounded cleanup and transaction rollback.
They also verify pool/row wait exhaustion and release when BEGIN has succeeded
but its caller's admission expires.
The real service startup test holds a cleanup query behind a PostgreSQL table
lock, then verifies shutdown returns with its connection closed and preserves
the held state. Unit tests cover first-pass delay, completion-based scheduling,
no overlap or catch-up, bounded failure logs, and cancel/join with a live parent.
Service-entry tests separately exercise
login and password-change fifth/sixth races across Stores, global User counters
across Organizations, Caller expiry/logout during verification and lock waits,
and complete rollback of counters with failed issuance or rotation. Real
PostgreSQL COMMIT acknowledgements are dropped to verify zero credentials,
one attempt and no compensation of durable outcomes. These component checks
do not replace final container or browser-consumer integration admission.
Dummy preparation reserves the same configured capacity but generates a random
salt and rejection target without computing a startup hash. Unknown-account
verification still runs one full-cost Argon2 operation and always rejects.
`node tests/e2e/service-authentication/identity/run.mjs` checks this owning service
in an isolated Identity/PostgreSQL stack with a test-only HTTPS IdP. It checks
200 concurrent independent unknown-account logins at the default Argon2 cost,
attributing every busy response to an actual KDF queue rejection. A nonroot
sampler shares the original Identity PID namespace, reads raw `/proc` high-water
and current RSS through pressure and real-login recovery, and rejects missing
sources, restarts or an exceeded memory allowance. Numeric shutdown receipts
prove that work joined and all permits drained before the original container is
replaced. The baseline is sampled before any business password RPC, after normal
bootstrap and dummy preparation. A fresh container using the same immutable
image then runs the remaining authentication and key-rotation checks.
These measurements are evidence for this run, not a
universal or byte-exact RSS bound. The suite also checks
real policy-gated callbacks and review persistence through rotation, toggles
and service restart. The broader `make e2e-identity-core`
is an integration gate after Gateway/Console adoption; it checks token
resolution inside the disposable Docker network, before the Gateway/SCIM/OIDC
suite.
`make e2e-browser-sessions-https` additionally exercises real Console pre-binding,
paired SCIM and two-browser account controls through the reference TLS proxy.
It proves default-policy refusal, exact notice acknowledgment, explicit restore,
last-method confirmation and remote session/stream retirement while an accepted
Run continues on the same Runtime.

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
