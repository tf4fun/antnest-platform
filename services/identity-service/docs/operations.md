# Identity Service Operations

This document covers Identity Service startup, readiness, configuration,
bootstrap, secret handling, telemetry, protocol operations, revocation feed
recovery, and shutdown.

## Startup And Readiness

Startup validates configuration, connects to the private database, applies
checksummed migrations, validates the encryption key, and idempotently creates
the bootstrap Organization and local system administrator when bootstrap
variables are present.

Migration application is serialized across replicas by a PostgreSQL advisory
lock and rejects a journal entry unknown to the running binary. Bootstrap is
also serialized transactionally, so simultaneous replicas return the same
canonical identity facts and create one audit event.

`GET /status` returns `ready` only after startup completes and a bounded
database probe succeeds. External OIDC Providers are request-time dependencies
and do not affect process readiness.

## Configuration

| Variable                              | Required    | Meaning                                    |
| ------------------------------------- | ----------- | ------------------------------------------ |
| `ANTNEST_IDENTITY_LISTEN`             | no          | Listen address, default `:8080`            |
| `ANTNEST_IDENTITY_DATABASE_URL`       | yes         | Private PostgreSQL URL                     |
| `ANTNEST_IDENTITY_ENCRYPTION_KEY`     | yes         | Canonical base64 32-byte AES key           |
| `ANTNEST_IDENTITY_PUBLIC_BASE_URL`    | yes         | OIDC callback and SCIM location base       |
| `ANTNEST_IDENTITY_TOKEN_TTL`          | no          | Local/OIDC access token TTL, default `12h` |
| `ANTNEST_IDENTITY_OIDC_SESSION_TTL`   | no          | OIDC state lifetime, default `10m`         |
| `ANTNEST_IDENTITY_HTTP_TIMEOUT`       | no          | Outbound OIDC deadline, default `10s`      |
| `ANTNEST_IDENTITY_SHUTDOWN_TIMEOUT`   | no          | Graceful shutdown deadline, default `15s`  |
| `ANTNEST_BOOTSTRAP_ORGANIZATION_SLUG` | conditional | Initial organization slug                  |
| `ANTNEST_BOOTSTRAP_ORGANIZATION_NAME` | conditional | Initial organization name                  |
| `ANTNEST_BOOTSTRAP_ADMIN_EMAIL`       | conditional | Initial local system administrator         |
| `ANTNEST_BOOTSTRAP_ADMIN_PASSWORD`    | conditional | Initial administrator password             |
| `OTEL_SDK_DISABLED`                   | no          | Disable OTLP export                        |
| `OTEL_EXPORTER_OTLP_ENDPOINT`         | no          | OTLP HTTP base endpoint                    |
| `OTEL_SERVICE_NAME`                   | no          | Defaults to `identity-service`             |

The full variable list, including OpenTelemetry exporter settings and
`ANTNEST_ENVIRONMENT`, is in the [service README](../README.md#configuration).
Duration values must be positive Go durations.

Bootstrap variables are all-or-none. The bootstrap password must be 12 to 1024
bytes; no other complexity rule is applied. Repeated startup verifies the same
organization/admin identity and never resets an existing password.
Keep the configured slug/name and email stable: an existing Organization with
a different name or inactive state fails bootstrap; a new unmatched email can
create an additional administrator. Disabling bootstrap requires all four
values to be empty in the service environment. Removing them from the root
`.env` alone restores Compose defaults. The
[deployment runbook](../../../docs/docker-single-node-operations.md) describes
the explicit override and credential/data ownership precautions.

## Secret Handling

- Database URLs and URL credentials are redacted from diagnostics.
- Passwords, raw API/SCIM tokens, OIDC client secrets, state, code, ID/access
  tokens, PKCE verifiers, claims, email, and SCIM bodies are excluded from
  logs/traces.
- `start_oidc_login` returns an authorization URL containing the one-time state
  query value. Treat the entire URL as a secret; do not place it in logs,
  analytics, support tickets, or telemetry.
- Token hashes and encrypted payloads are not returned by list/query methods.
- Online encryption-key rotation is not implemented. Replacing the
  key without first re-provisioning encrypted Provider/session data makes that
  data intentionally unreadable and is therefore a planned maintenance
  operation, not a supported live command.

## Telemetry

Inbound HTTP spans propagate W3C trace context and structured completion logs
record only method, route template, status, and result. Outbound OIDC requests
inject trace context. PostgreSQL connections use the default otelpgx v0.12.0
driver tracer installed by `repository.ParsePoolConfig`. SQL execution, batches
and transaction statements are observed automatically under a recording parent;
repository methods do not add CLIENT wrappers or create SQL root spans. Startup
and shutdown failures log a stable stage class such as `database_migration`, `listener`, or
`http_shutdown`, never the underlying error text. The implemented metrics use
bounded labels:

- `antnest.identity.http.requests` and `antnest.identity.http.duration` by HTTP
  method, route template, status, and result;
- `db.client.operation.duration` and `db.client.operation.errors` from otelpgx,
  with database system and pgx operation type labels; the old
  `antnest.identity.repository.operations` / `antnest.identity.repository.duration`
  business-operation series are removed;
- one shared HTTP transport for OIDC discovery, token, UserInfo, and JWKS
  requests, plus semantic validation at the existing OIDC adapter boundary.

User, organization, subject, Provider, SCIM resource, token, request, event,
and raw URL path values are never metric labels. SQL text with placeholders is
recorded as `db.query.text`, but bind values, result sets, full connection strings
and ordinary HTTP bodies are not captured. Driver error status/exception messages
are not bounded protocol summaries and may include server-supplied text; SQLSTATE
is `pgx.sql_state`. The shared boolean
`ANTNEST_TELEMETRY_CAPTURE_RPC_CONTENT` defaults to `false`; enabling it records
complete RPC parameters and results, including credentials they contain.
There is no per-field filtering or bespoke payload size limit. See
[Identity observability](observability.md) for the development-data warning.

## Protocol Operations

- SCIM Bearer scope is checked before request-body parsing.
- Identity's OIDC callback returns a bounded JSON result to Edge Gateway.
  Gateway establishes its browser session and redirects to the application;
  the browser must use Gateway's callback URL, not the internal Identity host.
- The first successful callback returns the raw access token once. Replaying a
  completed callback returns only principal, token ID, expiry, and
  `already_completed=true`; it never returns the raw token again.
- Browser logout revokes by the presented opaque access token. Identity returns
  `revoked` when it commits revocation and `already_invalid` for an unknown,
  expired, or previously revoked credential; repeating the request is safe.
- Provider issuer and Client ID are immutable for an existing Organization/name.
  Create a replacement registration under a new Provider name; in-place Client
  ID replacement returns `oidc_provider_client_id_immutable` (`409`). Secret
  rotation remains an ordinary Provider update. Provider
  deletion is intentionally absent so existing external identities remain
  auditable. Use `set_oidc_provider_enabled` for enable/disable; this local,
  idempotent operation remains available when the external IdP is unavailable.
- The OIDC callback is fixed from `ANTNEST_IDENTITY_PUBLIC_BASE_URL`; Provider
  configuration cannot supply another redirect URI. An in-flight session is
  rejected after any Provider revision change and must be restarted.
- An OIDC exchange that reaches the login deadline before issuing its token
  fails with `oidc_session_expired` (`410`), records an `expired` failure stage,
  and cannot be retried under the same login state. Start a new login instead.
- Local login revalidates the password hash and active principal during token
  issuance. If they changed during password verification, login returns the
  same `unauthenticated` (`401`) as invalid credentials and commits no token.
  Password rotation itself does not revoke previously issued access tokens;
  logout revokes the presented token and global User disable revokes all of
  that User's tokens. Organization Membership deactivation blocks resolution
  while inactive without revoking another Organization's access.
- OIDC issuer and discovered endpoints must use HTTPS. The client rejects
  redirects, bounds discovery/token/UserInfo/JWKS responses to 1 MiB, preserves
  opaque subjects exactly, and exchanges each authorization code once using the
  discovered client-secret authentication method. Restrict reachable IdP hosts
  with deployment egress policy when private-network destinations are not
  intended.
- SCIM User `active=false` deactivates the SCIM-owned Membership without
  deleting it. DELETE tombstones and hides that SCIM resource; reprovisioning
  with the same external ID creates a fresh Membership on the same global User
  and repoints its OIDC identity while audit history remains. POST never
  overwrites an active User or Group; use PUT/PATCH for updates.
  SCIM Group DELETE removes the Group and its owned edges; it does not expose a
  nonstandard Group `active` state.
- Multiple SCIM bearer tokens for an Organization are rotating credentials for
  the same logical directory authority. Operators must not connect competing
  provisioning authorities to the same Organization.
- Protocol request bodies and responses are bounded. Unknown fields are
  rejected on internal RPC and tolerated only where the standards require
  extensibility.
- SCIM mutations accept exactly one JSON object up to 1 MiB and reject empty
  Group member references instead of silently discarding them.

## Revocation Feed Recovery

`list_principal_revocations` is private trusted-network RPC and must not be
forwarded by Gateway. It uses the same route and automatic driver spans and
metrics as other RPC queries; completion logs do not contain event payloads.
The existing RPC content switch still controls complete RPC parameters/results.
The stored W3C trace parent lets the Controller consumer correlate asynchronous Disable work with
the originating request, without persisting baggage or credentials.

Back up `principal_revocations` with the rest of the Identity database. Do not
truncate it, reset its sequence, change sequence caching, or manually insert
rows outside the producer's transaction lock. A consumer begins at zero and
persists only sequences of actually received records. There is no automatic
feed retention or compaction. Consumers own retries and cursors;
Identity never writes their databases. Database rollback/replacement requires
coordinated consumer recovery, not silently reusing a cursor from another
history. Existing inactive identities predating this feed have no synthetic
revocation events; a nonempty upgrade needs explicit reconciliation before
claiming offboarding coverage.

## Shutdown

SIGINT/SIGTERM clears readiness, stops accepting new requests, drains HTTP,
closes PostgreSQL, and flushes telemetry within the shutdown deadline. An
incomplete shutdown exits non-zero for platform replacement.
OIDC callback failure finalization ignores caller cancellation so it can write
the terminal fact, but has its own five-second deadline and stores only a
stable stage summary.
