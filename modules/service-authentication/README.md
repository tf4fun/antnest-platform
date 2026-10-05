# Shared Go authentication

This module owns the Go implementation of the [platform authentication contract](../../contracts/platform/service-authentication.md).
Consumers retain their route caller lists and business authorization.

- `serviceauth` supplies strict JSON, bounded configuration, token/mTLS receivers and configured-origin outbound clients. `LoadOutbound` takes the caller and an explicit header policy. Every profile disables proxies and redirects and reloads its own credential per request; only Gateway may use `GatewayHeaders` for its verified hints and SCIM bearer.
- `callercontext` supplies strict signed CCT/JWKS parsing, claim verification, bounded key refresh and verified-token forwarding. Identity retains signing, session validation and revocation.
- `devsecrets` rejects published credentials and uniform encryption keys unless the exact, independent development opt-in is set. It validates PostgreSQL passwords with the driver's parser and emits variable-only warnings. See the [secret admission contract](../../contracts/platform/development-secrets.md).

Use `CallerContextHeaders` for Console, Controller and RC; use `WorkloadOnlyHeaders` for Registry. HTTP and socket setup apply the same policy. User authority cannot be inferred from unverified headers.

Run `GOWORK=off go vet ./...` and `GOWORK=off go test -race -count=1 ./...` in this directory. Common rejection vectors live in `contracts/platform/`; protocol tests live beside their implementation. Service integration and Docker E2E stay under root `tests/`.

Consumers require version `v0.0.0` with `replace github.com/tf4fun/antnest-platform/modules/service-authentication => ../../modules/service-authentication`. Container builds must copy the module and preserve that relative layout. See the [delivery boundary](../../docs/go-authentication-module.md).
