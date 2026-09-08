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
- ACP v1 Streamable HTTP routing with per-request session and Agent admission;
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
tests organization isolation and natural expiry. `make e2e-acp-session` uses
the separate disposable ACP fault profile for post-upgrade expiry, dependency
outage/recovery and durable Run completion after browser logout/disconnect.

See [architecture](docs/architecture.md) and [operations](docs/operations.md).

## ACP HTTP

`POST`, `GET` (SSE), and `DELETE` on `/api/app/agents/{agent_id}/v1/acp`
and its `/acp` alias relay the official SDK transport to `/v1/acp`. The draft
v2 endpoint remains WebSocket-only. No ACP method is interpreted by Gateway.

HTTP clients use the existing login cookies. POST and DELETE also send
`X-Antnest-CSRF-Token` from the CSRF cookie. A supplied Origin must match the
Gateway origin; HTTP clients without Origin still require valid cookies and
CSRF for writes. WebSocket continues to require Origin. No new login or bearer
API is introduced by this transport change.

Only Content-Type, Accept, Acp-Connection-Id and Acp-Session-Id are forwarded
from the client. Gateway injects the authoritative Agent access subject and
trace context; cookies, authorization and forged internal headers never reach
ACP Service. Responses preserve ACP routing headers and SSE is flushed without
buffering. POST/DELETE admission uses the message limit, separate from long-lived
GET/WebSocket connections, so an open receive stream does not block cancel.

Each new HTTP request revalidates the original identity and current Agent
access. As with WebSocket, already admitted work can finish and deliver output
on an existing receiver; there is no idle authorization polling or automatic
Run cancellation. Closing the receiver cancels its upstream HTTP request, not
the durable Run. ACP Service owns reconnect/load and connection expiry.
