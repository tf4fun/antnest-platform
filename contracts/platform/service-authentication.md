# Service authentication and caller context

Status: foundation contract for [#32](https://github.com/tf4fun/antnest-platform/issues/32).
The interim token wire/configuration profile is frozen by
[#101](https://github.com/tf4fun/antnest-platform/issues/101).
The schemas, caller catalogs and repository admission checks are delivered by
the foundation. Identity now enforces workload/CCT admission and provides the
issuer/JWKS. Remaining service adoption, deployment changes and Docker security
E2E are tracked in the [rollout ledger](service-authentication-rollout.json).
This document does not describe the current unauthenticated listeners as secure.

Provider URLs use the separate [destination policy](provider-destination-policy.md)
for #28. Workload authentication authorizes internal callers; it does not authorize
an arbitrary outbound Provider address or permit secrets to be sent there.

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
and a request-body classification. `status: planned` means a listener has not
yet adopted its policy. `status: enforced` records adoption after the owning
service gates pass; it does not claim final cross-service integration has passed.

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

#### Startup configuration

Each process uses the following exact, shared environment names. There are no
service-specific prefix substitutions or inline caller/token values.

| Variable | Contract |
| --- | --- |
| `ANTNEST_SERVICE_AUTH_MODE` | Required, exactly `token` or `mtls`, with no default. Unknown, empty, differently cased or whitespace-padded values fail startup. An unimplemented selected mode also fails startup. |
| `ANTNEST_SERVICE_AUTH_ALLOW_INSECURE_TRANSPORT` | Absent means `false`; only the exact values `false` and `true` are valid. `true` permits token mode over HTTP only in an explicitly opted-in disposable development deployment. It is invalid in `mtls` mode. Production deployment policy must reject this opt-in. |
| `ANTNEST_SERVICE_AUTH_CALLERS_FILE` | Required in token mode: a nonempty path to this receiver's read-only UTF-8 JSON hash file. Read and validate once at startup; replacing it requires receiver restart. No inline JSON or environment secret fallback. |
| `ANTNEST_SERVICE_AUTH_TOKEN_DIR` | Required when token mode has configured outbound business dependencies: a nonempty path to this caller's read-only secret directory. Validate every configured dependency's file before opening the listener. A receiver with no outbound dependencies may omit it. |

Do not trim or case-normalize these values. File paths are used as supplied,
without shell expansion. Missing/unreadable files, malformed credentials and
partial selected-mode configuration fail startup without exposing their contents.
Token mode over HTTPS still verifies the server trust chain, DNS/expected
identity and validity using the TLS configuration above; it does not require a
client certificate. Plain HTTP requires the separate exact opt-in. Neither
mode falls back to the other, to plaintext or to the legacy service-wide tokens.
Public/health routes retain their explicit catalog policy; the opt-in never
turns an internal business route into a public route.

#### Receiver file

The [receiver schema](service-token-callers.schema.json) defines one JSON
object keyed by the exact service names in the caller catalogs. Each value is
an array of one or two strings, each exactly `sha256:` followed by 64 lowercase
hexadecimal characters. Hash the outgoing token's **ASCII file bytes**, not its
decoded random bytes, including no newline. A one-element array is the current
hash; during rotation, two elements are current and next. Both authenticate the
same caller; array order never changes authorization.

Reject non-object roots, unknown service/member names, non-array values,
empty/oversized arrays, malformed hashes, duplicate hashes within or across
callers, duplicate JSON member names (including escaped equivalents), BOM and
multiple JSON documents. Normal JSON framing whitespace is allowed. Schema
validation alone cannot detect duplicate JSON members or hashes across callers:
owning services MUST also perform those semantic checks before constructing an
identity map. Do not decode directly into a map and silently keep the last
duplicate member. Reject the receiver's own service name unless an exact
workload route in its caller catalog explicitly permits that self-call. The
shared self-grant vector is synthetic; it adds no grant to the current catalogs.

An empty object grants no workload identities. It is valid for an outbound-only
process such as Gateway; internal requests to such a receiver still fail
authentication. Configuring a peer's hash establishes its identity only: every
request must still pass the selected route's separate caller allowlist. Raw
tokens never appear in a receiver file.

#### Outgoing files, token bytes and rotation

For static dependencies the layout is
`ANTNEST_SERVICE_AUTH_TOKEN_DIR/<receiver-service-name>`. Each file is named
exactly by the receiver catalog's service name, without an extension. The
directory belongs to one calling service; tokens differ for every
caller/receiver pair and deployment. A caller with several dependencies has
several files, not a shared token. Resolve the file from a server-owned
dependency identity, never from a URL, request header or body supplied by a user.
Send it only to the configured receiver origin; do not forward it across origins
on redirects. Keep these mounts outside workspace and Skill volumes.

Managed Runtimes are distinct receiver instances, not one platform-wide
`antnest-runtime` identity. #29/#30 must provision a separate instance-scoped
secret directory and receiver hash file for each Agent/generation. A Runtime
client uses the same `antnest-runtime` filename **inside that instance's
directory**, selected by trusted RC-owned connection metadata. It must never
use a process-wide token shared by all Runtimes. Dynamic instances are validated
when their connection is installed, rather than pretending they exist at ACP
startup. The owning Runtime connection contract must define delivery of that
private reference before RC/ACP consumers adopt it; the execution ID fence and
signed maintenance/temporary tickets remain independent requirements.

A token is canonical unpadded base64url of **32–64 cryptographically random
bytes**: 43–86 ASCII characters from `[A-Za-z0-9_-]`. Decode and re-encode to
prove canonical spelling and unused bits; the alphabet/length check alone is
insufficient. Padding, impossible base64url lengths, `+`, `/`, quotes, Unicode,
NUL, spaces, BOM, LF and CRLF are invalid. A file contains only those bytes;
trailing newline is **rejected**, never stripped. Generation uses a CSPRNG and
emits 32 random bytes (256 bits) as 43 characters with no newline. Parsers cannot
prove entropy; generators and provisioning must not reuse constants or the
public synthetic fixture credentials. There is no working default.

Read and validate the applicable file at startup and **again for every new
outbound request/connection**. No watcher, permanent raw-token cache or repair
logic is required. Replace a whole file atomically, preserving the read-only
service mount; in-place partial writes are prohibited. A later unreadable,
missing or malformed file blocks that outbound call with the owning service's
dependency/configuration error; never reuse a previous token or make an
unauthenticated call. An already authenticated stream need not reread a file on
every frame; renewal/new connections reauthenticate, with #58 owning long-lived
connection policy.

Rotation order is fixed: publish current+next in the receiver file and restart
the receiver, atomically replace the caller file, then remove current and
restart the receiver after the deployment's explicitly bounded overlap and any
admitted request drain. The overlap deadline is deployment-owned, not an
unbounded retention policy. Receiver restart reloads hashes; caller restart is
not needed to notice the new token. After removal the old token returns 401.

#### Header grammar and outcomes

Send exactly one field line:
`Antnest-Service-Authorization: Bearer <token>`. Header names and the `Bearer`
scheme are ASCII case-insensitive; token bytes are case-sensitive. The sender
uses the shown casing and exactly one ASCII space between scheme and token.
On the uncombined field values supplied to authentication, require exactly one
value with this grammar. Do not trim it, split comma lists, accept quoted tokens
or coerce whitespace. Reject duplicate field lines, including identical values
and differently cased field names, before an accessor drops or comma-joins them.
Use Go `Header.Values`, Node `rawHeaders` (not only `headers`/`Headers.get`) and
Rust `HeaderMap::get_all`, or an equivalent adapter preserving all occurrences.
Apply the same rule to HTTP upgrade/SSE establishment where applicable.

HTTP parsing removes framing optional whitespace at field edges; this is
separate from application-level token normalization. Leading/trailing whitespace
still present in an adapter-supplied value is rejected. The shared vectors use
these supplied values, not raw HTTP framing. Service HTTP adapter tests must
exercise real duplicate field lines and comma-joined values; this contract does
not require a second HTTP parser to recover whitespace already removed by the
transport. Scheme matching and framing follow
[RFC 9110 §§5.5 and 11.1](https://www.rfc-editor.org/rfc/rfc9110.html#section-11.1).
The canonical token profile is deliberately narrower than generic `token68`.

Hash the accepted token bytes and compare every configured digest in constant
time. Derive the caller only from the receiver's hash map, then check the exact
route allowlist. A name in another header/body cannot select or change it.

| Result | HTTP/classification | Challenge |
| --- | --- | --- |
| Missing, empty, duplicate, malformed, unknown or removed token | `401 service_unauthenticated`, `retryable: false` | Exactly `WWW-Authenticate: Bearer realm="antnest-service"` |
| Verified caller absent from the selected route's allowlist | `403 caller_not_allowed`, `retryable: false` | No workload challenge |
| Verified and allowlisted caller | Continue to CCT/business authorization; no new response envelope | None from workload authentication |

The realm identifies the dedicated service header; a client must not respond by
moving this credential into `Authorization`. That existing header remains
available for end-user access, SCIM and signed Runtime tickets, and never serves
as a fallback workload credential. Gateway strips browser-supplied service
credentials and sends its own. A BFF similarly supplies its own immediate-hop
credential instead of forwarding the incoming peer's token. Never capture the
raw token in logs, traces, RPC content or errors.

The [shared token fixtures](service-token-fixtures.json) cover receiver schema
and semantic rejection, canonical file bytes, uncombined headers, rotation and
mode/transport selection. A fixture's success status 200 means workload
admission only; real handlers retain their existing response statuses. Every
owning service batch consumes applicable vectors through its production parser
and authenticating handler. These repository oracles freeze the format; passing
them alone does not prove deployed listener authentication.

#### Development provisioning ownership

The deployment batch owns `scripts/dev-service-tokens.mjs`, per-pair generation,
receiver hash files and Compose secret mounts. Output belongs in
`artifacts/service-authentication/`; add its Git ignore rule before generation
(Docker already excludes `artifacts/`). No provisioning helper or real secret
is introduced by #101. Before deployment wiring lands, each owning service's
isolated test harness generates temporary CSPRNG credentials/hash files in its
private test directory and cleans them up. It uses the same profile and never
installs shared public fixture values as a running service's secrets. Such local
tests do not substitute for the final cross-service Docker acceptance.

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
The JWKS callers are exactly `edge-gateway`, `admin-console`, `agent-ui`,
`agent-acp-service`, `agent-controller` and `skill-registry`, all with workload
authentication and no CCT. #25 owns that registration in Identity's catalog
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
The Go scanner parses all non-test Go files in each directory/package and uses
the standard AST to expand static tables, loops and wrappers. Wrapper calls in
other files are included even if those files have no direct mux registration.
Unresolved arguments fail even when the same wrapper has other known calls;
different packages do not share argument lists. TypeScript custom path matchers
and Rust routers have reviewed route catalogs plus SHA-256 source guards: changes/new matcher
files require catalog review. These conservative guards are verification
metadata, not copies of service source or a production authorization library.
Replacing a custom matcher with a declarative registration in its owning batch
can remove its guard after equivalent route-coverage tests pass.

The current Go scan resolves wrapper arguments only within their owning
directory/package; it does not follow imported calls such as
`probe.Reg(mux, "POST /internal/x")`. Current route wrappers are unexported
methods or local closures. [#29](https://github.com/tf4fun/antnest-platform/issues/29)
must add an admission rule rejecting any exported function or method that uses
its own parameter, or a value derived from it, as the route pattern passed to
`Handle` or `HandleFunc`. Reject the definition even when an in-package call is
known. This rule is pending, not enforced by the foundation. Its regression
must cover an in-package known route plus an unlisted imported call. Fixed
literal registrations and a constructor's local closure parameters are not
exported pattern parameters.

Within the supported registration patterns, admission checks reject omitted
caller policies, missing `callers`, public internal business routes and stale
policies. They still require
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

Work for #101 and the service adoption batches is committed and pushed to
`feat/service-authentication`. Each service implementation commit changes only
one owning service, its contracts/documentation and tests, and passes that
service's unit/contract/component and applicable isolated Docker gates before
commit. Do not create intermediate PRs. Current CI triggers on `main` pushes or
PRs, so a push to this branch without a PR does not run it; local gates are
mandatory. Run cross-service Docker E2E only in the explicit final integration
batch, after all service/deployment batches pass, and before the final PR/merge
to `main`. Record partial progress without claiming a secured complete workflow.

This is the code-review/delivery order, not permission to deploy a strict issuer
before its clients can authenticate. Deploy the coordinated credential/header
changes after the integration batch; a partially upgraded chain must fail
closed. Do not add body-only/header-only identity fallback. The disposable
development HTTP opt-in relaxes transport only; workload credentials, required
CCTs and actor checks remain mandatory. Controller's general route
authentication and Egress control authentication remain #32-owned follow-ups;
#28's discovery fix and #34/#36's network work alone do not complete them.
