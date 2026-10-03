# Service authentication and caller context

Status: foundation contract for [#32](https://github.com/tf4fun/antnest-platform/issues/32).
The schemas, caller catalogs and repository admission checks are delivered in
this batch. Service enforcement, deployment changes and Docker security E2E
remain pending in the [rollout ledger](service-authentication-rollout.json).
This document does not describe the current unauthenticated listeners as secure.

## 1. Two independent identities

Every internal business request MUST establish both its immediate calling
workload and, when its route requires one, the end user on whose behalf it acts.
Network membership, loopback publication, `X-Antnest-*` headers, Agent IDs and
body fields such as `actor_principal_id` do not establish either identity.

The receiver first validates request metadata and workload credentials, then
checks its route's exact caller allowlist, then verifies the Caller Context
Token (CCT), then applies its existing organization, role, owner and lifecycle
checks. Authentication never grants every action available to that service.
No database ownership or business authorization moves into shared middleware.

Each service owns a `callers.json` alongside its wire contract. Every route has
`callers`, an authentication mode, caller-context requirements **per caller**,
and a request-body classification. These catalogs describe the required future
policy; `status: planned` means it is not yet enforced by that listener.

| Authentication mode | Meaning |
| --- | --- |
| `workload` | Verify the peer and require membership in `callers`. |
| `public` | External Gateway route. The route still requires its documented session, OIDC state or SCIM credential. |
| `health` | Explicit minimal `/status` or `/live` probe; no credentials, configuration, user content or business actions. Restrict deployment exposure. |
| `deny` | Unknown-route or method fallback; always reject, with no business effects. |
| `delegate` | Outer mux forwarding only. Enforce the inner exact route policy; this is not a wildcard authorization grant. |

Go `GET` registrations also accept `HEAD` by Go ServeMux semantics. `*` records
a real method-independent mux registration, not permission for arbitrary new
methods. ACP `UPGRADE` records a WebSocket handshake separately from HTTP.

## 2. Workload credentials

### Target: mutual TLS

The platform CA issues a distinct private key and certificate to each service.
The certificate contains exactly one workload URI SAN:
`antnest://service/<service-name>`, using the service names in the caller
catalogs. Validate the trust chain, validity, client/server usage and exact URI;
do not infer identity from the subject CN, remote IP or a caller-name header.
Clients also verify the expected server identity and DNS SAN. Authentication
material is mounted read-only, outside the Runtime workspace and Skill volumes.

Configuration names reserved for service-owned implementations are
`ANTNEST_TLS_CA_FILE`, `ANTNEST_TLS_CERT_FILE`, `ANTNEST_TLS_KEY_FILE` and
`ANTNEST_TLS_SERVER_NAME`. Partial TLS configuration, missing files or an
unverifiable identity MUST fail startup. No TLS failure may fall back to a token
or an unauthenticated connection. The CA private key is not a service mount.

`antnest://` is the platform's URI profile, **not a SPIFFE ID**. A SPIRE deployment
needs an explicit reviewed mapping from `spiffe://<trust-domain>/service/<name>`
to the same service identity and must pin its trust domain. Issuing a certificate
with any URI does not make that URI a trusted workload. See the
[SPIFFE X.509 specification](https://spiffe.io/docs/latest/spiffe-specs/x509-svid/).

Runtime certificates/credentials must belong to the particular managed
instance and must never grant a Runtime the identity of RC, ACP or Controller.
#30 must bind the verified server endpoint to the expected Agent, generation
and execution. The execution fence and existing maintenance tickets remain
mandatory; a workload certificate alone does not authorize a maintenance action.

Compose PKI generation (`scripts/dev-pki.sh`), certificate mounting and helper
implementations belong to later owning-service/deployment batches. Generated
development PKI must live in ignored `artifacts/dev-pki/`, excluded from images,
and contain no checked-in private keys. The deployment batch must add its Git
ignore entry before generating any files (Docker already excludes `artifacts/`).
Production issuers and rotation remain
deployment-owned; cert-manager/SPIRE are options, not mandatory dependencies.

### Allowed interim: a distinct token for each caller/receiver pair

A service may explicitly choose token mode before its mTLS batch. Its receiver
configuration `ANTNEST_<SVC>_CALLERS` maps allowed service names to at most two
SHA-256 token hashes (current and next); receivers do not store raw tokens.
Callers read their outgoing token from a read-only mounted secret file. Each
caller/receiver pair has a different random token with at least
256 bits of entropy, no working default and no trim/case normalization.

Send exactly one `Antnest-Service-Authorization: Bearer <token>` header. The
receiver hashes the presented token, compares digests in constant time and derives the caller from its own
configuration. A name in a body or another header cannot select the identity.
Reject duplicate credentials, shared hashes mapped to multiple callers, empty
tokens and partial configuration. Publish the next hash before changing the
caller's secret; remove the prior hash after the bounded rollout overlap.
A configured but non-allowlisted caller gets
`caller_not_allowed`; an unknown/missing credential gets `service_unauthenticated`.

This dedicated header leaves `Authorization` available for end-user access
tokens, SCIM tokens and signed Runtime maintenance tickets. Token and TLS modes
are selected at startup; neither is an automatic fallback from the other.
Bearer tokens require TLS in non-development deployments. Disposable Compose
HTTP, if explicitly enabled as development mode, is a temporary limitation and
is not evidence of production confidentiality.

## 3. Caller Context Token

Identity alone issues compact Ed25519 JWS CCTs. The private key is separate from
workload keys and Runtime maintenance signing keys. Gateway obtains a CCT via
the authenticated `resolve-access-token` RPC and forwards it unchanged in one
`Antnest-Caller-Context` header. CCTs never enter browser-visible session JSON,
URLs, persistent transcripts, logs or RPC-content/trace capture.

- [Protected header schema](caller-context-header.schema.json): exact
  `typ: antnest-cct+jwt`, `alg: EdDSA`, and a nonblank printable ASCII `kid`.
  Compare `kid` exactly; no whitespace repair, key-selection URLs or algorithm
  negotiation. The verification key's curve MUST be Ed25519.
- [Claims schema](caller-context-claims.schema.json): `iss`, `sub` (user), `org`,
  `mbr`, `sys_role`, `org_role`, `sid`, `aud`, `iat`, `exp`, `jti`, optional `agt`,
  and reserved `act`. Roles use existing Identity values: system `user|admin`,
  organization `member|admin`. `iss` is exactly
  `antnest://service/identity-service`; trust keys belong to one deployment.
- `aud` is a nonempty unique **array** of consuming service names. Each consumer
  requires its exact name to be present. There is no wildcard/all-services
  audience or string/array compatibility coercion.
- Numeric dates are integer UTC seconds. Independently of schema validation,
  require `exp > iat` and `exp - iat <= 60`. Clock tolerance is at most 30 seconds;
  reject `iat > now + tolerance` and `now >= exp + tolerance`. This permits up
  to 90 seconds of acceptance, not indefinite reuse by a bridge.
- Require `agt` for Agent-scoped requests and compare it and `org` with the
  actual target. Body/header IDs cannot widen token scope. No `agt` means an
  organization-scoped discovery/admin request, not access to every Agent.
- `act: { sub: "antnest://service/<delegator>" }` is reserved for #77. Current
  issuers MUST NOT mint it and current verifiers MUST reject any token with it.
  Channel Manager and Task Scheduler receive no authority in this batch.

### Multiple hops without audience confusion

Gateway selects a server-owned profile based on the actual route. Identity
permits only the [listed profiles](service-authentication-rollout.json), after
verifying the Gateway and user session:

| Profile | Audience chain |
| --- | --- |
| `console` | Console → Identity/Controller/Registry/ACP |
| `workspace` | Agent UI → ACP/Controller |
| `acp` | ACP direct transport |

The console profile includes only its five named consumers; workspace includes
only its three. Every hop authenticates its **immediate** calling service as
well as the CCT. For example Identity still allows administrative RPCs only
from Console even if a workspace CCT's claims identify an administrator.

No BFF rewrites or re-signs `aud`, roles or Agent scope. A new route needing
another audience must have its profile reviewed by Identity and its caller
catalog updated. This fixes the conflicting proposal to issue a single-audience
UI token and then forward it to an ACP verifier that requires a different `aud`.
Audience and explicit token typing follow
[RFC 7519 §4.1.3](https://www.rfc-editor.org/rfc/rfc7519.html#section-4.1.3) and
[RFC 8725 §§3.9–3.12](https://www.rfc-editor.org/rfc/rfc8725.html#section-3.9).

### Verification and JWKS

Identity publishes `GET /rpc/identity/jwks` to authenticated, explicitly listed
consumer services in #25. It needs workload authentication but no CCT, avoiding
bootstrap recursion. Pin the Identity URL and deployment trust; never follow
`jku`, `x5u`, arbitrary issuer URLs or unbounded redirects supplied by a token.
The planned JWKS callers are exactly `edge-gateway`, `admin-console`, `agent-ui`,
`agent-acp-service`, `agent-controller` and `skill-registry`, all with workload
authentication and no CCT. #25 adds that new registration to Identity's catalog
when it implements the issuer; RC, Runtime and Egress receive no JWKS grant.

The [JWKS schema](caller-context-jwks.schema.json) contains only public
`OKP/Ed25519` signing keys (`x` canonical base64url, 32 bytes); no `d`. Require
unique exact `kid` values. See
[RFC 8037](https://www.rfc-editor.org/rfc/rfc8037.html). Rotate by publishing the
next public key before issuing with it, keeping the previous key through the
last issued token's maximum lifetime plus tolerance and cache propagation.
Give JWKS caching a finite service-defined bound; refresh once on an unknown
`kid` with request deduplication and a timeout, not on every forged request.
Never accept an unknown key or stale keys after their configured trust expiry.

Require three canonical base64url JWS segments, a 64-byte signature, UTF-8 JSON
objects and no duplicate members or extra protected-header/claim fields. Bound
the header carrier to 8 KiB before decoding. Check schema **and** signature
**and** temporal/audience/scope rules; shape validation is not authentication.
Use maintained JOSE libraries in the owning-service batches. The shared
[fixtures](caller-context-fixtures.json) include stateless verification vectors;
revoked-session and handler authorization tests remain service-owned.

Identity rechecks `sid` against its session store before administrative effects
and derives the actor from `sub`. A body actor is only an audit echo; mismatch
returns Identity's `403 actor_mismatch`. Other consumers must not promise instant
session revocation from offline signature verification: their bound is the
token lifetime plus tolerance unless they implement revocation observation.
Long-lived connection renewal/revalidation remains #58; expiry does not cancel
already accepted model work. It does prevent a new user operation being admitted
with an expired token.

### User actions and service operations

`caller_context` in the catalogs distinguishes:

- `required`: verify the forwarded CCT and derive the actor and scope from it.
- `operation`: an allowlisted service owns an already authorized operation,
  execution snapshot or lifecycle action. Resolve its Agent/organization from
  that owned record; never upgrade an arbitrary body actor into a CCT.
- `none`: login/session resolution, key bootstrap, non-user control or probes;
  still enforce workload authentication on internal business routes.
- `session` / `scim-token`: external Gateway routes use their browser session or
  SCIM credential; SCIM remains a separate protocol, not a CCT issuer.

These distinctions allow a long-running Run and automatic Skill learning to
continue under their accepted owner without storing/replaying an expired CCT.
They do not authorize an external peer to fabricate a background operation.

### Reconcile earlier issue recommendations with the current call graph

The caller catalogs take precedence over illustrative matrices in the older
issues. In particular:

- #27's `apply-execution-snapshot` and `settle-agent` are Controller-only.
  `get-agent-execution-state` and `watch-agent-execution-state` are currently
  called by Gateway and Agent UI. They require those workloads plus a CCT;
  moving them exclusively behind Controller's listener would break the
  Workspace. The later listener split must preserve this user observation path.
- #31's existing projection writer is ACP; promotion is an explicit Console
  action. Console can upload/list/download/search/load/promote, Controller can
  resolve frozen versions, RC can download artifacts, and ACP can update its
  projections/search/load. RC cannot resolve or publish; ACP cannot promote or
  publish. A future workflow must update the catalog before gaining a grant.
- #30's workload credential uses the dedicated service header, leaving
  `Authorization` for existing signed maintenance/temporary tickets. Any
  Runtime interim token must also be bound to its Agent/generation, not shared
  among all Runtime instances. The execution ID remains a fence, not a secret.
- #28 will remove Controller's current credential-returning `/access` route
  while moving discovery into its owner. This foundation catalogs the current
  route as Console-only with a CCT; it does not claim that returning plaintext
  Provider credentials has been fixed.

## 4. Errors and JSON request hygiene

[Error classification schema](service-authentication-error.schema.json):

| Code | HTTP | Meaning |
| --- | --- | --- |
| `service_unauthenticated` | 401 | Missing, duplicate, malformed or unverified workload credential. |
| `caller_not_allowed` | 403 | Verified workload is not listed for the exact route. |
| `caller_context_required` | 401 | Required CCT is absent. |
| `caller_context_invalid` | 401 | CCT is malformed, expired, unverified, out of scope or unsupported. |

All four have `retryable: false`; transport/JWKS outages use the owning service's
503 dependency error and fail closed. The schema describes the classification,
not a replacement for each service's JSON/MCP error envelope. TLS handshake
failure can close the connection before HTTP exists. Do not expose key material,
raw claims, peer-controlled text or credentials in error messages/telemetry.

Every JSON RPC/request-body route MUST require one valid
`Content-Type: application/json`, permitting an optional UTF-8 charset. Missing,
duplicate, malformed, `text/plain`, form or multipart content types get **415**
before JSON decoding or effects. Do not accept `+json` by accident. Enforce the
existing request-size limit and single-document/unknown-field rules as well.
The [shared negative probe](../../tests/support/json-rpc-security.mjs) supplies
otherwise-valid caller credentials so an auth failure cannot mask missing 415
handling. Per-service implementations must run it against every JSON route.

SCIM's `application/scim+json`, Skill multipart uploads, archive transfers and
protocol handshakes keep their explicit content rules. Bodyless GET/DELETE/SSE
do not acquire a JSON requirement. The caller catalogs classify these exceptions
so the shared probe does not send a JSON body to a binary/upload endpoint.
MCP `POST` JSON RPC still requires `application/json`; its `protocol` catalog
classification describes the mixed methods on the SDK mount, not a JSON bypass.

## 5. Network/deployment batch

Authentication is the primary control. The later deployment batch replaces
`development` with purpose-specific **internal** networks, based on actual
caller edges: `edge`, `controller-acp`, `controller-runtime`,
`controller-identity`, `registry-clients` and the Controller/Egress control
path. Preserve the existing service-owned database networks. Model/provider
Internet access uses a separate explicit outbound path; making all networks
internal without providing that path would break model inference.

`runtime-management` retains RC/ACP outbound Runtime probes/tools, Runtime Egress
and managed Runtimes. Jaeger and business/administrative listeners must not be
reachable there. Split/bind listeners explicitly: network attachment alone
cannot isolate a wildcard listener on a multi-homed container. Observability
is an exporter destination, not an authorization bypass back into control APIs.

Base `compose.yaml` must ultimately publish only Gateway's 8090. Move service,
Postgres and Temporal diagnostic ports into an explicit `compose.debug.yaml`
override, and update owned E2E/dependency tooling before changing that default.
Debug publication never bypasses credentials. Until that batch ships, the
current shared network and loopback ports remain an open release blocker.

## 6. Admission and ownership

Run `make test-service-authentication` for schema/vector tests and route coverage.
The Go scanner uses the standard AST to expand static tables, loops and wrappers;
unresolved registrations fail. TypeScript custom path matchers and Rust routers
have reviewed route catalogs plus SHA-256 source guards: changes/new matcher
files require catalog review. These conservative guards are verification
metadata, not copies of service source or a production authorization library.
Replacing a custom matcher with a declarative registration in its owning batch
can remove its guard after equivalent route-coverage tests pass.

Caller catalogs cannot silently omit current registrations, omit `callers`,
add public internal business routes or leave stale policies. They still require
human review for the correctness of each caller/context grant. Passing this
repository check does **not** prove middleware enforcement.

Follow the [rollout ledger](service-authentication-rollout.json): contract first,
Identity issuer, Gateway, individual consumers, Controller, RC, Registry,
Runtime/Egress, deployment, then explicit cross-service integration. #25–#31
implement the owning surfaces; they must link this contract rather than invent
another token/header/audience mechanism. #32 stays open for its aggregate
acceptance. The final `tests/e2e/security/` suite must probe every joined network,
reject missing credentials/forged headers/body actors and prove normal browser,
Agent lifecycle and Skill flows still work before #80 can close.

This is the code-review/delivery order, not permission to deploy a strict issuer
before its clients can authenticate. Deploy the coordinated credential/header
changes after the integration batch; a partially upgraded chain must fail
closed. Do not add body-only/header-only compatibility fallback outside an
explicit disposable development configuration. Controller's general route
authentication and Egress control authentication remain #32-owned follow-ups;
#28's discovery fix and #34/#36's network work alone do not complete them.
