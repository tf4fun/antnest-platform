# Controller service authentication

Control contract revision 38 implements the exact
[platform token/mTLS and CCT profile](../platform/service-authentication.md).
There is no network-trust, shared bearer, raw identity-header or mode fallback.

## Admission

The [caller catalog](callers.json) is the complete route policy:

| Routes                                                                          | Verified workload          | User context                                                                                                                                       |
| ------------------------------------------------------------------------------- | -------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| Management/catalog, authorization defaults, lifecycle, events and policy writes | `admin-console`            | CCT for `agent-controller`; signed system or Organization administrator; requested Organization/actor must match signed `org`/`sub`                |
| `POST /rpc/agent-controller/list-workspace-agents`                              | `edge-gateway`, `agent-ui` | Organization-scoped CCT; body Organization/principal match signed claims                                                                           |
| `GET /internal/agents/{agent_id}/skill-learning-policy`                         | `agent-acp-service`        | Accepted service operation: persisted Agent, exact owner/access revision and live Identity membership; request hints cannot manufacture delegation |
| `GET /status`, `GET /rpc/agent-controller/status` (also HTTP HEAD)              | Minimal health exception   | No CCT; only `status` is returned                                                                                                                  |

Agent routes require the exact signed `agt`, including body-scoped
`set-agent-authorization`. Catalog/workspace discovery has no Agent scope.
The transport strips raw `X-Antnest-*`, user Authorization, cookies and credentials
before business handlers. Verified CCT is private request context and is forwarded
unchanged only when resolving Template Skills at Registry. Provider credentials
and CCT never enter response projections, events, logs or trace content.

JSON mutations require one `application/json` Content-Type, optionally UTF-8
charset, identity encoding and a 2 MiB limit. UTF-8 errors, BOM, duplicate decoded
members, unknown/case-aliased fields, multiple documents and duplicate query fields
are rejected before effects. JSON mutation routes accept no query parameters.

Missing/invalid workload credentials return `401 service_unauthenticated` with the
service Bearer challenge. A valid foreign workload returns `403 caller_not_allowed`.
Missing/invalid CCT returns `401 caller_context_required|caller_context_invalid`;
Identity key unavailability returns retryable `503 identity_dependency_unavailable`.
Signed scope mismatches return `403 organization_mismatch|actor_mismatch`;
insufficient signed administrator role returns `403 forbidden`. Invalid JSON/query,
unsupported media and excess body size return 400, 415 and 413 respectively.
These errors retain the common `{code,message,retryable}` shape.

## Composition and operations

Startup requires exact `ANTNEST_SERVICE_AUTH_MODE=token|mtls` and the platform
profile's credentials/TLS settings. Token mode checks every configured receiver's
token file at startup and rereads it for each request. Receivers load current and
optional next hashes once; reload requires restart. Production requires TLS 1.3,
CA/DNS/exact workload URI verification; insecure token/HTTP requires an explicit
development opt-in. Health checks honor TLS/mTLS and custom listen ports.

Identity, ACP control, Runtime Controller, Runtime Egress and optional Registry
origins are distinct and server configured. Private transports pin both URL origin
and Host, disable redirects/proxies and replace untrusted workload/user headers.
Workload authentication is sufficient for already accepted lifecycle, publication,
revocation/observation and settlement operations; their scope comes from owned
records. They do not store or replay the initiating user's expiring CCT.

Controller uses `ANTNEST_AGENT_ACP_CONTROL_URL`, never the ACP workspace listener.
Nonempty `ANTNEST_AGENT_ACP_SERVICE_URL` or `ANTNEST_SKILL_REGISTRY_API_TOKEN` fails
startup. Registry's URL is optional; when set it uses its private outgoing
receiver token or mTLS identity, with verified CCT for Template resolution.

## Delivery boundary

Controller has passed its owning authentication and Provider discovery gates.
Revision 38 removes `/access`, adds saved/draft model-only discovery, and enforces
the shared [Provider destination policy](../platform/provider-destination-policy.md)
at creation and discovery. Console/ACP consumer and RC/Registry/Egress receiver
batches, deployment wiring and final token-profile business/security E2E have
passed their gates, recorded in the
[rollout ledger](../platform/service-authentication-rollout.json).
