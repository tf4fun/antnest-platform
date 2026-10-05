# Skill Registry service authentication (#31)

This owning-service profile applies the frozen [platform token and CCT
contract](../platform/service-authentication.md). The [caller catalog](callers.json)
is authoritative. The original Issue #31 permission table predates the actual
projection/promotion flow and does not add permissions.

## Operations

| Operation           | Route                                                       | Immediate callers                 | User context                              |
| ------------------- | ----------------------------------------------------------- | --------------------------------- | ----------------------------------------- |
| `create`            | POST /internal/skills                                       | admin-console                     | required CCT                              |
| `append`            | POST /internal/skills/{skill_id}/versions                   | admin-console                     | required CCT                              |
| `list`              | GET /internal/skills                                        | admin-console                     | required CCT                              |
| `versions`          | GET /internal/skills/{skill_id}/versions                    | admin-console                     | required CCT                              |
| `artifact`          | GET /internal/skills/{skill_id}/versions/{version}/artifact | admin-console, runtime-controller | Console CCT; RC-owned preparation         |
| `resolve`           | POST /internal/skill-versions/resolve                       | agent-controller                  | Controller-owned Template/Agent operation |
| `projection.update` | PUT /internal/skill-projections                             | agent-acp-service                 | ACP-owned durable source event            |
| `discovery.search`  | POST /internal/skill-discovery/search                       | admin-console, agent-acp-service  | Console CCT; ACP-owned accepted Run       |
| `discovery.load`    | POST /internal/skill-discovery/load                         | admin-console, agent-acp-service  | Console CCT; ACP-owned accepted Run       |
| `promote`           | POST /internal/skill-projections/promote                    | admin-console                     | required CCT                              |

RC cannot publish or resolve. ACP cannot publish or promote. Controller cannot
list, download or update projections. Unknown routes and method fallbacks never
grant business permission. Only exact GET/HEAD /status is an identity-free,
minimal database readiness probe. Authentication runs before mux redirects,
route permissions, body decoding, capacity slots and database/source effects.

## Configuration and rotation

Use `ANTNEST_SERVICE_AUTH_MODE`, `ANTNEST_SERVICE_AUTH_CALLERS_FILE`,
`ANTNEST_SERVICE_AUTH_TOKEN_DIR`, the exact development-only
`ANTNEST_SERVICE_AUTH_ALLOW_INSECURE_TRANSPORT` flag and the shared TLS variables.
Token mode uses one canonical CSPRNG credential for each caller/receiver pair,
one dedicated `Antnest-Service-Authorization` field, and a receiver file
containing only one or two SHA-256 hashes per caller. Exact file/header grammar,
semantic duplicate rejection, mTLS identities and bounded overlap follow the
platform contract. No inline operation list may override the route catalog.

Identity is a mandatory configured dependency for authenticated JWKS retrieval:
`ANTNEST_IDENTITY_URL`. `ANTNEST_SKILL_REGISTRY_SOURCE_URL` optionally configures
the ACP source reader. In token mode validate `identity-service` and, when
enabled, `agent-acp-service` outgoing files before listening; reread the applicable
file on every new request. Pin each configured receiver origin and TLS service
identity, ignore environment proxies, refuse redirects, and send neither user
Authorization/Cookie nor incoming workload/CCT credentials on source/JWKS calls.
JWKS trust expires after 30 seconds, with one throttled unknown-key refresh and a
bounded request timeout; unavailable expired trust fails closed.

`ANTNEST_SKILL_REGISTRY_API_TOKEN` and `ANTNEST_SKILL_REGISTRY_SOURCE_TOKEN` are
retired; a nonempty legacy setting fails startup. There is no credential fallback.
The deployment batch owns random provisioning, secret mounts and removal of
Compose defaults. Owning-service tests generate disposable credentials; final
cross-service E2E remains a separate integration batch.

## Tenant, actor and publication permission

Console routes require one valid Identity-signed CCT, audience `skill-registry`,
organization scope (no `agt`), and system-admin or organization-admin role.
Registry derives organization and actor from verified `org` and `sub`.
Existing body/query identity fields remain mandatory audit echoes, never
authorization inputs: mismatched organization returns 403 `organization_mismatch`,
mismatched actor returns 403 `actor_mismatch`, before publication, receipt replay,
source lookup or artifact download. Publish and promote pass the verified values
to the application/store. Read queries likewise use the verified organization.
No role grants cross-organization access. Browser identity headers are ignored.

Service-operation routes do not require or replay a user's expiring CCT. Their
allowlisted service owns the accepted operation and derives its organization,
actor/owner and Agent from that record: Controller from Template/Agent state, RC
from prepared fixed references, ACP from its accepted Run or durable source
event. Registry does not read those services' databases or treat supplied actor
fields as a delegated user. Existing organization-scoped lookups, owner-scoped
projections and ACP's live source authorization remain mandatory. An operation
credential grants only its exact routes; it cannot acquire Console authority.

## Wire hygiene and failures

Every JSON route requires exactly one UTF-8 `application/json` Content-Type
(optional charset), identity/no Content-Encoding, one object, valid UTF-8, no
duplicate members or unknown fields and the existing 4/16 KiB bound. JSON
mutations do not accept query fields; read queries reject malformed encoding
and repeated fields. Multipart publish retains its two-part ZIP contract and
4 KiB strict JSON metadata rules. Authentication/CCT carriers are never copied
into business requests, durable receipts, logs or Trace content.

Errors retain `{error:{code,message}}`; boundary errors additionally contain
`retryable`. Missing/malformed/unknown workload credentials return 401
`service_unauthenticated`, `retryable:false`, and exactly
`WWW-Authenticate: Bearer realm="antnest-service"`. A verified caller outside
the selected route returns 403 `caller_not_allowed` without challenge. Missing
CCT returns 401 `caller_context_required`; duplicate, invalid, expired or scoped
CCT returns 401 `caller_context_invalid`. Scope and role denials are 403;
unsupported media is 415; all are nonretryable. JWKS transport/trust unavailability
is 503 `identity_dependency_unavailable`, `retryable:true`, with no upstream
body, URL, raw claims, key or token. Existing resource 404 and package/CAS errors
keep their mappings.
