# Changelog

## Unreleased

### Changed

The deployment contract now requires primary-listener health probes to follow
configured purpose addresses, preserve TLS identity checks, and bypass proxies
and redirects (#32). Controller and Registry need
separate owning-service health follow-ups before the unicast Compose wiring.
RC/Egress keep their existing separate loopback health listeners.

The development PKI helper now generates a private fresh CA, independent
per-service P-256 leaves, exact URI/DNS identities and both TLS usages (#32).
Existing issuers are never overwritten; normal cancellation reaps OpenSSL before
cleaning candidate output. Native OpenSSL/TLS and isolated nonroot Docker
read-only mount/TLS checks passed. Native Runtime remains on its separate
per-instance token profile. Purpose-network wiring and full acceptance remain
tracked deployment/integration batches; generation does not reconfigure a stack.

Development authentication provisioning now generates catalog-derived per-caller
credentials, separate Identity CCT and RC instance sealing keys, and optional
independent Skill maintenance keys (#32). Output is private and ignored; existing
credentials are never overwritten. Generating UID/GID metadata lets nonroot Node
services read 0700/0600 bind mounts without granting root or world access. Native
contract/CLI and isolated Docker read-only/rotation checks passed. All ten service
batches are admitted; network/Compose wiring and full cross-service acceptance
remain deployment/integration work. No live stack is reconfigured by the helper.

### Fixed

Admin Console's health probe follows its configured IPv4/IPv6 listener and
refuses environment proxies and redirects (#32 deployment follow-up). Existing
TLS service identity checks and wildcard loopback behavior remain in force.

Gateway's local HTTP health probe follows its configured IPv4/IPv6 listener,
bypasses environment proxies and rejects redirects (#32 deployment follow-up).
Wildcard listeners retain loopback probing; public readiness still describes
Gateway itself without requiring downstream readiness.

Identity's `--healthcheck` now probes its configured IPv4/IPv6 listener rather
than an unrelated loopback address (#32 deployment follow-up). Wildcard listeners
keep their existing loopback probe. Environment proxies and redirects cannot
report a different endpoint healthy; existing TLS identity checks remain required.

Runtime Egress now authenticates all eight control method/route combinations
and fallbacks before parsing or effects (#32). Only verified Controller token
or mTLS authority is admitted; user/context headers cannot grant permission or
enter content capture. Control, Runtime UDP and loopback health use distinct
purpose addresses. Strict JSON/media/query/no-body checks retain CAS, replay,
allocation and flow/conntrack semantics. Native and Linux HTTP/TLS, isolated
PostgreSQL and production Docker gates passed, including current/next rotation,
database-loss health and normal SIGTERM/SIGINT recovery. Coordinated deployment
and actual Controller-to-Egress/full-platform E2E remain pending; packet/DNS
issues #34/#36 are independent.

Skill Registry now verifies per-caller token/mTLS authority and exact route
grants (#31). Console operations require a Registry-audience administrator CCT;
organization and actor are taken from verified claims, with forged echoes
rejected before publication, replay or source reads. Controller resolves fixed
references, RC downloads artifacts, and ACP updates projections or searches/loads
without gaining Console publication authority. Strict JSON/multipart carriers
reject ambiguous media and duplicate metadata. JWKS and ACP source transports
use receiver-specific credentials with no proxies, redirects or forwarded user
authority. Unit, contract, real HTTP/PostgreSQL and isolated Docker gates passed;
coordinated deployment and complete business/security E2E remain pending.

ACP now uses RC-issued per-instance authority for all Runtime MCP, status and
private Skill clients (#30). Private publications stage verified 0700/0600
sender files before database CAS; database, Run, audit, model and Trace
projections exclude Runtime tokens. Same connection ID cannot change its token.
Accepted work retains its original reference through closure; missing authority
fails closed and cannot clear an unknown-effect barrier. Cold restart requires
Controller to republish the verified private reference. Normal shutdown removes
owned sender files. Maintenance intents now retain public revision/connection
identity, and regenerated schema preserves the frozen admission conditions.
The current native Runtime profile requires explicit HTTP token opt-in and
rejects unsupported TLS/mTLS composition. RC revision 16, native receiver and
Controller relay must precede ACP adoption; coordinated deployment and complete
business/security E2E remain the final integration batch.

Controller now resolves and verifies RC-issued Runtime instance authority on every
accepting execution publication (#30), including equal-revision resends and
restart. The relay remains private to ACP's control origin; credentials never enter
Controller tables, ordinary projections or Trace. Mismatched/unavailable authority
prevents publication and acknowledgement. Closed Agents need no resolution and
carry no credentials, preserving Drain/revocation/disable during Runtime outages.
Private dependency transports now explicitly bypass environment proxies. RC
revision 16 and this relay must precede the ACP instance clients described above;
final cross-service acceptance remains pending.

The #30 private execution publication contract now requires verified Runtime
connection identity and ACP authority for accepting Agents. Closed publications
carry only execution fences and never depend on a healthy resolver; revocation,
Drain and settlement cannot be blocked by missing Runtime credentials. Controller
relay and ACP private/public separation are delivered above; final integration remains pending.

Native Runtime now enforces the RC-issued instance authority before the entire
MCP/private Skill mount and full status (#30). Anonymous Docker liveness moves
to identity-free `GET/HEAD /status/live`. Only the owned alias and loopback with
the exact port pass Host checks; execution fences and independently signed Skill
tickets remain required. Learning and temporary artifact uploads retain their
multipart format. Root-only receiver permissions, owners, complete digest and
strict caller JSON are checked before networking/HTTP; malformed, missing,
ambiguous or unsupported TLS/mTLS configuration fails startup. Operators must
use RC's prepared read-only receiver volume and exact token/HTTP opt-in.
Controller relay and ACP private clients are delivered above; coordinated
deployment/business E2E remain separate batches.

RC revision 16 now issues and atomically seals separate per-generation RC/ACP
Runtime credentials (#30). Exact retry and restart retain authority; new compute
rotates it. A verified root-only, read-only named volume carries hashes only,
with actual post-create/pre-start mount validation. Private Controller connection
resolution checks the current revision/execution, exports only ACP authority,
uses no-store and disables debug content capture. Ordinary projections remain
unchanged. Operators must retain a private 0600, exactly 32-byte raw master file
via `ANTNEST_RUNTIME_INSTANCE_KEY_FILE`. This first native instance profile
requires explicit internal-HTTP token opt-in; TLS/mTLS is unsupported and fails
startup. ACP adoption is described above; coordinated deployment
and full business/security E2E remain subsequent batches.

The #30 private Runtime instance connection contract is frozen before service implementation. RC owns per-caller, per-Agent/generation CSPRNG tokens and sealed records; Controller privately relays ACP authority. Receiver volumes contain only root-only SHA256 configuration; public bindings/Run snapshots never contain tokens. The contract defines authenticated full status, identity-free liveness, exact Host admission, preserved execution fences/tickets and service-owned producer/consumer batches. RC producer, native Runtime receiver, Controller relay and ACP adoption are described above; final integration is still pending.

Runtime Controller now admits only verified Controller workloads on every control route, including all three Skill preparation routes (#29). Control revision 15 adds exact token/mTLS admission and strict JSON errors, an explicit unicast control address (default `127.0.0.1:8080`), and a separate loopback health listener (default `127.0.0.1:8082`). Operators must supply authentication configuration, bind the Controller-purpose address, and remove nonempty `ANTNEST_SKILL_REGISTRY_API_TOKEN`. Registry downloads use per-receiver credentials without proxies or redirects. `ANTNEST_RUNTIME_ALLOWED_IMAGES` accepts exact repository or SHA256-manifest allowlists; the default Runtime repository is the only allowed repository when unset. Disallowed new selections return `422 image_not_allowed` before Docker or journal effects; accepted recovery retains its frozen image ID. Cross-package exported Go route wrappers cannot forward route-pattern parameters to Handle/HandleFunc without failing catalog checks. RC still holds host-equivalent Docker-socket authority; final network deployment, Runtime instance credentials and cross-service E2E remain separate batches.

ACP now enforces the shared Provider destination policy for foreground,
permission-judge and Skill-learning model calls (#28). All DNS answers are
checked before sending the key; connections use a verified literal IP with the
original TLS/SNI/Host identity. Redirects, environment proxies and private service
credentials are excluded. Streamed bodies retain cancellation and size limits,
and each completion closes its bounded transport. Destination failures use
`provider_endpoint_forbidden` or `provider_endpoint_unavailable` in Run receipts
and Trace, without keys, rejected URLs or raw DNS details. Operators must set the
same exact `ANTNEST_PROVIDER_ALLOW_PRIVATE_ENDPOINTS` policy in Controller and ACP
when explicitly enabling private/local model endpoints. Controller, Console and
ACP service gates have passed; coordinated deployment and full E2E remain the
final integration batch.

Admin Console model discovery is now a thin, authenticated Controller proxy (#28).
Saved keys never leave Controller; draft keys are forwarded once. The Provider
HTTP client and plaintext `/access` consumer are removed. Browser revision 49
remains unchanged: model metadata is allowlisted and upstream failures use static
safe messages without private addresses or credentials. Controller revision 38
and this Console update must deploy together after final integration. ACP's
actual-model destination guard is delivered above.

Controller model discovery now runs next to encrypted credentials (#28).
Control contract revision 38 removes the plaintext `/access` export and adds
saved/draft model-only discovery. Creation and discovery enforce the shared
destination policy: all DNS answers checked, literal-IP dial with original
TLS/Host, disabled redirects/proxies, bounded deadlines and response sizes.
The exact operator-only `ANTNEST_PROVIDER_ALLOW_PRIVATE_ENDPOINTS` option defaults
false; present empty, padded or other spellings fail startup. Explicit true permits
local/private LLM endpoints and metadata ranges and is unsafe for multi-tenant use.
Console thin-proxy and ACP model-call adoption are delivered above;
Controller and Console discovery changes must be deployed together after final
integration. No intermediate business E2E completion is claimed.

The shared Provider destination policy and IPv4/IPv6/DNS fixtures are frozen for
#28 before Controller, Console and ACP adoption. The policy specifies private
endpoint opt-in, checked literal-IP dialing, disabled proxies/redirects and
bounded errors that exclude credentials. Controller, Console and ACP adoption is
recorded above; final cross-service E2E remains pending.

Controller now authenticates every business route and rejects forged Organization,
actor and Agent scope before effects (#32 / #28 prerequisite). Console management
requires a signed administrator CCT; Gateway/UI workspace discovery requires the
signed subject and Organization. ACP learning-policy reads resolve persisted owner
authorization instead of inventing user delegation. Dependency clients use private
receiver credentials, pinned origins and no redirects/proxies. Control contract
revision 37 adds admission errors and strict UTF-8 JSON. Deployments must configure
the shared exact authentication settings and `ANTNEST_AGENT_ACP_CONTROL_URL`;
nonempty legacy ACP workspace URL or Registry API token now fails startup.
Controller discovery/address policy and Console adoption are delivered above;
ACP destination policy is delivered above; remaining receivers/deployment and
final cross-service E2E remain separate batches.

Agent UI now verifies Gateway workload credentials and Identity-signed CCT before
Workspace handling ([#26](https://github.com/tf4fun/antnest-platform/issues/26)).
Signed subject, Organization, roles and Agent scope replace authority from raw
identity hints; display labels and browser JSON stay unchanged. HTML/bootstrap
retain Organization-scoped discovery, while Agent APIs require signed `agt`.
Bridge forwards CCT unchanged with UI's own rotating workload credentials.
Malformed media, UTF-8 and duplicate JSON members fail before business effects.
Expiry denies new operations without cancelling accepted Runs. Startup requires
the shared exact authentication settings and `ANTNEST_AGENT_UI_IDENTITY_URL`,
with distinct pinned dependency origins; container health supports TLS/mTLS and
custom ports. Controller/deployment admission and final integration remain later
batches on `feat/service-authentication`; #58 owns long-lived renewal.

ACP now verifies workload credentials and Identity-signed caller context before
protocol, workspace or audit handling ([#26](https://github.com/tf4fun/antnest-platform/issues/26),
[#27](https://github.com/tf4fun/antnest-platform/issues/27)). Controller publication
and settlement move to `ANTNEST_ACP_CONTROL_LISTEN` (default `:8081`); workspace
returns 404 for those paths. Signed claims determine identity, including Unicode
and punctuation; raw identity headers grant nothing. Strict JSON rejects ambiguous
media types, duplicate members and malformed UTF-8 before effects. Expired CCTs
reject new operations without cancelling accepted model work; #58 owns renewal.
Authenticated Identity, optional learning-policy and Registry clients validate
credentials at startup and reread token files per request. Deploy with the new
mandatory service-authentication settings and `ANTNEST_ACP_IDENTITY_URL`; nonempty
legacy Registry/source bearer settings now fail startup. Controller/Registry
consumers, private Runtime instance credentials, network deployment and final
integration remain later batches on `feat/service-authentication`.

Gateway preserves the existing account-switch CAS guard for network-policy
writes while stripping browser identity headers ([#26](https://github.com/tf4fun/antnest-platform/issues/26)).
It validates the one expected organization/user pair against authenticated
Identity facts and regenerates it only for the specific Console operation;
stale, duplicate or malformed guards return `409 principal_changed` before
forwarding. Signed CCT remains the delegated authority.

Admin Console now authenticates Gateway and verifies Identity-signed caller
context before administrative effects ([#25](https://github.com/tf4fun/antnest-platform/issues/25),
[#26](https://github.com/tf4fun/antnest-platform/issues/26)). BFF revision 49 uses
signed actor, organization, roles and actual Agent scope; unsigned identity
headers cannot grant access. Protected JWKS trust expires after 30 seconds,
unknown-key refreshes are limited, and unavailable expired trust fails closed.
Every internal dependency uses exact per-receiver token/mTLS credentials, with
unchanged CCT forwarding and no browser credentials or legacy audit identity
headers. JSON parsing rejects ambiguous media types, duplicate members and case
aliases. Console's old `ANTNEST_SKILL_REGISTRY_API_TOKEN` setting is removed;
a nonempty value fails startup. Deploy Identity, Gateway, then Console with the
new credentials. Controller/ACP/Registry consumers, deployment and final
cross-service acceptance remain pending on `feat/service-authentication`.

Gateway now authenticates each internal dependency with the exact token/mTLS
contract and forwards Identity revision-14 signed caller context selected by
the actual route ([#26](https://github.com/tf4fun/antnest-platform/issues/26)).
It removes browser service/CCT credentials and all `X-Antnest-*` headers,
validates CSRF privately, and regenerates only verified presentation hints.
Token files are validated before startup and re-read per HTTP request or
WebSocket connection; invalid replacements fail closed without stale fallback.
Internal origins, TLS DNS/service identities and redirects are constrained.
Gateway session contract revision 15 keeps browser JSON unchanged and rejects
new direct WebSocket messages after the handshake CCT expires; reconnect does
not cancel accepted Runs. Identity must upgrade first; Controller
consumers, deployment credentials and final integration remain pending on
`feat/service-authentication`. #58 separately owns long-lived renewal.

Identity now rejects administrative calls based only on a body-selected actor
([#25](https://github.com/tf4fun/antnest-platform/issues/25)). RPC revision 14
requires verified workload identity, route allowlists and a signed caller context
whose live session, subject and organization match the operation. It adds a
protected public JWKS endpoint and CCT issuance to access-token resolution.
JSON RPC media types and exact-case/duplicate member rules are enforced before
effects. Missing workload/TLS/signing configuration fails startup. Deploy only
after the matching Gateway/Console and credential-provisioning batches; the
complete coordinated rollout and Docker E2E remain pending on
`feat/service-authentication`.

Runtime release images now use a feature-free default Docker target, while the
test-only Skill commit gate requires an explicit `--target e2e` build
([#12](https://github.com/tf4fun/antnest-platform/issues/12)). Supplying
`ANTNEST_RUNTIME_FEATURES` to the default target cannot enable test features.
Test binaries reject `serve` unless `ANTNEST_RUNTIME_ALLOW_TEST_FEATURES` is
exactly `true`, then emit one startup warning listing the compiled features.
E2E images carry the `dev.antnest.runtime.test-features` label and set that
explicit opt-in; release images have an empty label and no opt-in.

ACP's development-only Skill learning debug Agent now requires the explicit
`ANTNEST_ACP_ALLOW_DEVELOPMENT_SETTINGS=true` gate
([#11](https://github.com/tf4fun/antnest-platform/issues/11)). The gate defaults to
`false` and accepts only exact `true` or `false` values. Existing deployments
that supply a debug Agent without the gate now fail configuration at startup.
The debug Agent ID retains its existing normalization: surrounding whitespace is
trimmed, and empty or whitespace-only values mean unset. The gate performs no
trimming or case conversion; padded or differently capitalized booleans fail
configuration.
Enabled debug learning emits one startup warning identifying the Agent. Standard
Compose no longer passes either setting from the operator's environment; both
are confined to the Skill learning E2E override. Normal learning policy, budgets
and foreground priority remain unchanged.

Edge Gateway now supplies security headers only when absent from the final
response ([#1](https://github.com/tf4fun/antnest-platform/issues/1)). Proxied
Agent UI documents retain their exact nonce-bearing CSP, allowing streaming
scripts and `blob:` image/media previews without an additional conflicting
Gateway policy. Gateway-generated responses and upstream assets without a
policy retain the existing defaults. SSE flushing and ACP WebSocket upgrades
remain supported; this change needs no API revision or coordinated rollout.
Agent UI also initializes browser schema validation in Zod's `jitless` mode
before constructing schemas, preventing its caught eval probe from emitting a
CSP violation during hydration or reload. The document CSP remains unchanged.

ACP Workspace Bridge's shared schema now requires the `errorClass` already
emitted on intent receipts and nested execution observations
([#4](https://github.com/tf4fun/antnest-platform/issues/4)). ACP normalizes invalid
stored classifications to `internal_error` at the read boundary, with a bounded
server diagnostic, and emits `null` for non-failure phases. Agent UI preserves
the required value and validates both response paths with the same rules.
Unknown valid codes retain the generic failed-turn presentation.
Run setup errors also validate raw codes before persistence, storing
`run_setup_failed` for malformed codes such as `ECONNREFUSED` or `40001`.
This avoids repeated normalization warnings when observing new setup failures.

Edge Gateway now preserves Identity's Organization slug/name in local-login,
token-resolution and OIDC principals and browser session responses
([#92](https://github.com/tf4fun/antnest-platform/issues/92)). Agent UI's Node
bootstrap, SSR and frontend mappings consume the verified metadata, so the
chooser and account footer display the real Organization name instead of
`Organization workspace`
([#93](https://github.com/tf4fun/antnest-platform/issues/93)). IDs, roles and
active state remain the authorization inputs.

Identity Service now includes the required `organization_slug` and
`organization_name` in local-login, access-token-resolution, and initial and
replayed OIDC callback principals
([#3](https://github.com/tf4fun/antnest-platform/issues/3)). It implements the
existing revision-13 contract without a migration. Organization display
changes do not invalidate password verification; authorization IDs, roles,
active state, and the password hash are still revalidated before token
issuance. Gateway and Agent UI now consume these fields through the
[verified projection](contracts/agent-ui/organization-projection.md), with the
complete display workflow verified in the separate
[#93 integration batch](https://github.com/tf4fun/antnest-platform/issues/93).

Runtime Controller now retries transient observation leadership/readiness
queries and initial reconciliation failures instead of exiting
([#17](https://github.com/tf4fun/antnest-platform/issues/17)). Observation retries
use capped exponential backoff with jitter; operators can set
`ANTNEST_RUNTIME_CONTROLLER_MONITOR_MAX_RETRY_DELAY` (default `30s`, minimum
`1s`). Failed initial attempts release leadership and keep Watch readiness
withdrawn until recovery. Standard Compose also uses `restart: unless-stopped`
for the Controller. See the
[recovery and readiness semantics](services/runtime-controller/docs/operations.md#observation-dependency-recovery).

### Changed

**Egress deployment change (#32):** control contract revision 5 requires exact
`ANTNEST_SERVICE_AUTH_MODE=token|mtls`. Provision a read-only receiver hash file
and TLS profile; isolated development HTTP needs exact insecure-transport opt-in.
Missing, ambiguous or invalid authority/transport configuration fails before
database/kernel/listener startup. Bind control to a private IP different from
Runtime UDP. Move local status probes to `ANTNEST_EGRESS_HEALTH_LISTEN`
(default `127.0.0.1:8082`) or `runtime-egress --healthcheck`; control `/status`
is no longer a health route. JSON mutations are bounded to 4 KiB and five
seconds; Ensure retains its empty request. Receiver rotation requires restart.
Deploy together with Controller's admitted sender and the final purpose-network
configuration; local service admission does not update an existing deployment.

**Registry deployment change (#31):** `ANTNEST_IDENTITY_URL` and the shared
service authentication profile are mandatory. Nonempty
`ANTNEST_SKILL_REGISTRY_API_TOKEN` or `ANTNEST_SKILL_REGISTRY_SOURCE_TOKEN` now
fails startup. Replace shared bearers with read-only receiver hash and per-pair
sender files (or the complete mTLS profile) before deploying the new service.
The existing Compose defaults are being replaced in the deployment batch;
upgrading only Registry with those defaults is unsupported.

Froze the interim service-token configuration and wire profile for
[#101](https://github.com/tf4fun/antnest-platform/issues/101): explicit shared
mode/file variables, canonical per-pair credentials, receiver SHA-256 hash
arrays, strict duplicate-header handling, outcomes and file rotation. Added
public synthetic conformance vectors for Go/TypeScript/Rust adoption. Service
implementations remain pending; batches commit to `feat/service-authentication`
with local service gates and one final cross-service Docker acceptance before
the branch merges into `main`.

Defined the platform service-authentication foundation for
[#32](https://github.com/tf4fun/antnest-platform/issues/32): workload identity,
Identity-issued caller-context schemas and public verification vectors,
per-service route caller catalogs, and repository checks that detect missing
caller policies or unreviewed custom matchers. Added a shared negative JSON
media-type probe for later service-owned tests. This is a contract-only batch:
authentication middleware, network/port changes and Docker security acceptance
remain pending in the rollout ledger; internal listeners are not yet secured.
Go route checks include wrapper calls across files in the same package and
reject unresolved arguments alongside known calls. Runtime Controller's Skill
preparation routes allow Agent Controller only, matching the actual HTTP client.

Runtime `/status` now requires `test_features: string[]`, including unavailable
responses; release binaries report `[]`. Upgrade Runtime Controller's status
reader before deploying the new Runtime images, because older strict readers
reject the added field. The updated reader accepts both shapes during rollout
and retains existing identity/readiness checks. Image admission policy remains
separate work in [#29](https://github.com/tf4fun/antnest-platform/issues/29).
Local E2E builds that previously supplied only `ANTNEST_RUNTIME_FEATURES` must
now select `--target e2e`; the feature argument must be nonempty.

Bridge receipt error classes must be `null` or a 1–128 character ASCII code
matching `^[a-z][a-z0-9_]*$`; only `failed`, `cancelled` and `unknown` phases may
carry non-null codes. The vocabulary remains open and `intentReceipt: 1` stays
unchanged. Deploy the ACP producer normalization before the stricter Agent UI
consumer when upgrading separately, so malformed stored codes do not cause
observation parsing failures. See the
[receipt failure contract](contracts/agent-acp/workspace-bridge.md#receipt-failure-classification).

Gateway's browser session contract advances to revision 14. Authenticated
Workspace API and SSR requests now carry `X-Antnest-Organization-Slug` and
`X-Antnest-Organization-Name`, each containing one canonical unpadded Base64URL
value over the exact UTF-8 label. Gateway strips browser-supplied values; Agent
UI requires the verified projection before discovery or rendering. See the
[Organization projection contract](contracts/agent-ui/organization-projection.md).

Runtime Controller control contract revision 14 adds the required boolean
`monitor_ready` to both `/status` response shapes
([#88](https://github.com/tf4fun/antnest-platform/issues/88)). After startup,
monitor retries and Watch reconnection now return HTTP 503 with `live: true`
and `monitor_ready: false`, returning to HTTP 200 after recovery. The process
keeps running, and `/status` reads cached state without probing Docker. The
Controller's own status-code-only healthcheck needs no parser change. Existing
probe failure thresholds absorb short reconnect windows.

ACP now reads `ANTNEST_ACP_SKILL_MAINTENANCE_SIGNING_KID` exactly as supplied,
without trimming whitespace, as part of the unified Skill maintenance key ID
validation ([#5](https://github.com/tf4fun/antnest-platform/issues/5)). This affects
existing deployments in two cases:

- A value with leading or trailing whitespace, such as `" key"` or `"key "`,
  was previously trimmed and accepted when paired with a valid signing key.
  It now causes ACP startup to fail.
- A whitespace-only value previously counted as unconfigured when no signing
  private key was configured. It now causes ACP startup to fail.

Before upgrading or restarting, remove whitespace from the signing key ID in
environment variables and deployment secrets. The ID must match
`^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$` and exactly match a trusted Runtime verifier ID.
To leave signing unconfigured, keep both `ANTNEST_ACP_SKILL_MAINTENANCE_SIGNING_KID`
and `ANTNEST_ACP_SKILL_MAINTENANCE_SIGNING_KEY` unset or exactly empty; do not use
spaces as an empty value. These configuration errors are rejected at startup,
before ACP begins serving requests.

See the [Skill deployment guide](docs/skill-deployment.md) for configuration and
key rotation instructions.

### Organization display deployment order

Complete each component's rollout before starting the next:

1. **Identity Service**: deploy a build containing
   [#91](https://github.com/tf4fun/antnest-platform/pull/91), which supplies the
   required Organization slug/name in revision-13 principals.
2. **Edge Gateway**: deploy a build containing
   [#94](https://github.com/tf4fun/antnest-platform/pull/94), which implements
   the revision-14 session contract and verified display headers.
3. **Agent UI**: deploy a build containing
   [#95](https://github.com/tf4fun/antnest-platform/pull/95), which requires
   those headers for Workspace bootstrap and SSR.

Deploying the new Gateway against Identity without #91 makes login unavailable:
otherwise valid local logins and session resolution return
`503 identity_unavailable`, and OIDC callbacks redirect to the login failure page
without establishing a browser session. Deploying the new Agent UI against
Gateway without #94 leaves Workspace bootstrap and SSR returning
`401 unauthenticated`. Re-authentication cannot repair missing server-side
projection headers; complete the upstream rollout first.
