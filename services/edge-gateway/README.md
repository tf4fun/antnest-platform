# Edge Gateway

Edge Gateway is Antnest Platform's sole external application entry. It turns
an Identity Service access credential into one trusted internal principal and
routes the request without owning the requested business operation.

## Status

Implemented for Stage 3A. The canonical cross-service behavior is
[`../../docs/stage-3-admin-control-plane.md`](../../docs/stage-3-admin-control-plane.md).

## Owns

- public HTTP listener and route policy;
- browser cookie and CSRF policy;
- access-token resolution and administrator admission;
- trusted principal headers, security headers, request limits, and tracing;
- explicit reservation of OIDC and SCIM public path prefixes;
- proxy availability and external error projection.

## Does Not Own

- users, organizations, credentials, or authorization facts;
- Models, Templates, Agents, lifecycle operations, or Runtime state;
- Admin Console page state or view aggregation;
- any PostgreSQL schema.

## Dependencies

- Identity Service for login, token resolution, token revocation, and readiness;
- Admin Console for the application and `/api/admin/*` BFF;
- OTLP collector when observability is enabled.

## Interfaces

See [`../../contracts/edge-gateway/session-contract.json`](../../contracts/edge-gateway/session-contract.json).
All other service interfaces remain private deployment details.

## Local Verification

```sh
go test ./...
golangci-lint run ./...
```

See [architecture](docs/architecture.md) and [operations](docs/operations.md).
