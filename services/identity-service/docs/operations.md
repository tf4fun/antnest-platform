# Identity Service Operations

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

Bootstrap variables are all-or-none. Repeated startup verifies the same
organization/admin identity and never resets an existing password.

## Secret Handling

- Database URLs and URL credentials are redacted from diagnostics.
- Passwords, raw API/SCIM tokens, OIDC client secrets, state, code, ID/access
  tokens, PKCE verifiers, claims, email, and SCIM bodies are excluded from
  logs/traces.
- `start_oidc_login` returns an authorization URL containing the one-time state
  query value. Treat the entire URL as a secret; do not place it in logs,
  analytics, support tickets, or telemetry.
- Token hashes and encrypted payloads are not returned by list/query methods.
- Online encryption-key rotation is not implemented in Stage 2. Replacing the
  key without first re-provisioning encrypted Provider/session data makes that
  data intentionally unreadable and is therefore a planned maintenance
  operation, not a supported live command.

## Telemetry

Inbound HTTP spans propagate W3C trace context and structured completion logs
record only method, route template, status, and result. Outbound OIDC requests
inject trace context. Every public repository command and query has a client
span and bounded result/error metric; transaction internals are represented by
their owning operation rather than SQL-level child spans. Startup and shutdown
failures log a stable stage class such as `database_migration`, `listener`, or
`http_shutdown`, never the underlying error text. The implemented metrics use
bounded labels:

- `antnest.identity.http.requests` and `antnest.identity.http.duration` by HTTP
  method, route template, status, and result;
- `antnest.identity.repository.operations` and
  `antnest.identity.repository.duration` by operation, result, and bounded
  error class;
- standard `otelhttp` client telemetry for OIDC discovery, token, UserInfo,
  and JWKS requests.

User, organization, subject, Provider, SCIM resource, token, request, event,
and raw URL path values are never metric labels. SQL text, bind values, and
protocol bodies are never telemetry.

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

## Shutdown

SIGINT/SIGTERM clears readiness, stops accepting new requests, drains HTTP,
closes PostgreSQL, and flushes telemetry within the shutdown deadline. An
incomplete shutdown exits non-zero for platform replacement.
OIDC callback failure finalization ignores caller cancellation so it can write
the terminal fact, but has its own five-second deadline and stores only a
stable stage summary.
