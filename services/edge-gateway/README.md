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
- browser-safe Agent workspace bootstrap and per-Agent access admission;
- same-origin Agent UI and ACP v1/v2 WebSocket routing with per-message browser
  session revalidation;
- trusted principal headers, security headers, request limits, and tracing;
- browser OIDC discovery/start/callback and transparent SCIM protocol ingress;
- proxy availability and external error projection.

## Does Not Own

- users, organizations, credentials, or authorization facts;
- Models, Templates, Agents, lifecycle operations, or Runtime state;
- Admin Console page state or view aggregation;
- ACP Session state, messages, model execution, or Tool dispatch;
- any PostgreSQL schema.

## Dependencies

- Identity Service for login, token resolution, token revocation, and readiness;
- Admin Console for the application and `/api/admin/*` BFF;
- Agent Controller for the principal-scoped workspace Agent projection;
- Agent UI for `/workspace/*` static application routes;
- Agent ACP Service for admitted `/api/app/agents/{agent_id}/v1/acp` (stable)
  and `/api/app/agents/{agent_id}/v2/acp` (draft) WebSockets; the Workspace
  `/api/app/agents/{agent_id}/acp` alias retains v1 behavior;
- OTLP collector when observability is enabled.

## Interfaces

See [`../../contracts/edge-gateway/session-contract.json`](../../contracts/edge-gateway/session-contract.json).
All other service interfaces remain private deployment details.

## Local Verification

```sh
go test ./...
golangci-lint run ./...
```

Gateway-owned unit tests are complemented by the real-stack
[Identity closeout client](../../scripts/identity-closeout/README.md), run by
`make e2e-stage3`. It checks browser HTTP and existing ACP v1/v2 logout
revocation, SCIM provisioning, controlled OIDC and Console projections through
the public entry, plus causal Jaeger spans. The separate HTTP access profile
tests organization isolation and natural expiry; post-upgrade ACP expiry and
dependency-outage recovery still need their own integration acceptance.

See [architecture](docs/architecture.md) and [operations](docs/operations.md).
