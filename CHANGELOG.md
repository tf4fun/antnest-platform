# Changelog

## Unreleased

### Upgrade requirement

**#10 requires Origin admission on every `/api/*` mutation, including login,
OIDC start and logout.** Scripted clients must send the configured public
`Origin`, or supply `Sec-Fetch-Site: same-origin` when Origin is absent.
Cross-site or same-site Fetch Metadata rejects mutations even with matching
Origin. The explicit `ANTNEST_EDGE_ALLOW_ORIGINLESS_MUTATIONS=true` compatibility
setting admits only requests where both headers are absent, logs a warning,
and retains independent CSRF and ACP WebSocket checks. Standard Compose keeps
the setting disabled. See [Gateway Origin admission](services/edge-gateway/docs/architecture.md#api-origin-admission).

**#57 requires an explicit public Origin outside a direct loopback HTTP
listener.** Existing development Compose `.env` files must set
`ANTNEST_EDGE_COOKIE_SECURE=true`. For non-loopback browser access, configure
native TLS or the trusted Caddy proxy with your certificate. Switching an
existing stack to the proxy overlay requires `down` without `-v` before `up`,
so Compose can recreate its isolated ingress network while preserving volumes.
See [Gateway HTTPS deployment](services/edge-gateway/docs/operations.md#https-compose-deployment).

**#111 requires a coordinated RC → Runtime → Egress → Controller cutover with
Agent admission stopped.** Packet revision 2 replaces raw UDP packets with the
embedded BoringTun 0.7.1 WireGuard profile; there is no revision 1 decoder or
rolling mixed-version deployment. RC inspection revision 19 and Egress control
revision 7 bind every open attachment to both the management IPv4 and prepared
generation key ID. Provision the independent private Egress master file with the
updated development credential helper and run `scripts/dev-egress-auth-owner.mjs`
before startup to set the two Egress files' root ownership on Linux bind mounts.
Disable development Agents before the
cutover and enable/rebuild them after all four components are upgraded. Old
open bindings without keys fail closed. Recovery needs matching encrypted
records and master files. See [authenticated Runtime tunnel](docs/authenticated-runtime-tunnel.md).

**#37 requires a coordinated Controller → RC → Runtime → Console cutover with
Agent admission stopped; mixed contracts are unsupported.** Reconfigure managed
MCP credentials as `secret_env`, then recreate/rebuild development Agents.
There is no heuristic migration of old public `env` values. Old snapshots,
journals and backups can still contain plaintext; discard disposable old data
and handle retained copies as secrets. Fingerprints now use opaque HMAC identifiers;
keeping a secret in a new revision may change its fingerprint. MCP HOME/TMPDIR/
XDG caches are private and ephemeral; OAuth caches may need reauthentication on
restart. MCP default files are 0600 (umask 077); explicitly grant group permissions
when sharing new MCP output in workspace. Remove overridden cache-directory
environment variables from Templates. See the
[managed MCP secret contract](contracts/runtime/managed-mcp-secrets.md).

The MCP cache tmpfs shares one `tmpfs_bytes` capacity across all servers, separate
from the equally sized `/tmp` mount. There are no per-server cache quotas;
one server can exhaust that filesystem. These are on-demand size limits, not
reserved RAM, and all actual usage shares the Runtime's existing memory limit.

**The first #42 upgrade requires downtime for Controller and Identity; rolling
old/new binaries is unsupported, even when retaining single-key configuration.**
Back up each owned database with its keys and matching binary, then stop all old
replicas before starting upgraded replicas and reopening traffic. New writes use
envelopes that old binaries cannot read; old binaries also reject the migrated
journal. **Rollback requires restoring the pre-upgrade database, keys and binary
together**, rather than only downgrading the image. This initial cutover is
separate from the subsequent online key rotation. See
[Rotating encryption keys](docs/encryption-key-rotation.md).

### Changed

Edge Gateway supports native TLS 1.2+ with SIGHUP certificate rotation and
explicitly trusted HTTPS proxies (#57). Origin checks and downstream forwarding
headers use the configured public Origin; login admission and diagnostics use
the client address resolved through the trusted CIDR boundary. HTTPS emits HSTS,
and non-loopback listeners reject insecure cookies. Native and Caddy Compose
overlays include deployment instructions and HTTPS browser/SSE/WSS acceptance.

Controller reads the current RC Runtime address before opening create/rebuild/
enable traffic or restoring a source. The observation worker rebinds changed
addresses and generation key IDs on open attachments before readiness publication
and never reopens lifecycle-closed attachments (#34, #111). Generation keys and
protocol-owned replay rejection protect the inner allocation before policy or
flow attribution. TUN and the independent nft backstop retain their roles.

Runtime health observations and journal cursors now commit independently of
Egress availability. Failed peer updates retry within one observation poll
budget, restoring work from RC inventory after startup or cursor reset. New
execution publication still requires peer confirmation. RC reports a missing
management IPv4 as one unknown-health `runtime_peer_unavailable` instance rather
than failing the whole inventory (#34).

RC issues and seals independent X25519/PSK material per compute generation and
privately registers Egress before platform mutation (#111). Runtime loads its
root-only read-only bootstrap; Egress seals its recipient keys in owned storage.
Open CAS retires previous keys under the packet-output barrier. Restarts create
fresh ephemeral WireGuard sessions. Authentication, replay and unknown-context
drops expose only aggregate metrics; private key RPC content is never captured.
The development helper now creates 25 static workload pairs and the independent
Egress master file. No WireGuard daemon, kernel WireGuard module or extra running
production service is added.

Managed MCP configuration separates public `env` from write-only `secret_env`
(#37). Console supports set/keep/clear and reads only set/fingerprint metadata.
Controller contract revision 39, RC revision 17 and Console revision 50 freeze
the boundary. RC resolves the frozen Template using its authenticated workload,
then mounts a generation-private root-only file read-only; values do not enter
Docker or launcher environments. Each managed server runs as UID 2000..2007 with
shared workspace GID 1000. Model tools remain UID 1000. Development network
contract version 2 adds RC to Controller's purpose network; regenerated private
token files include that pair. Controller rekey now covers managed MCP secrets
alongside Provider credentials.

Controller and Identity support active/decrypt-only master-key rings and online
`rekey --batch-size N` commands (#42). New writes use authenticated per-record
data-key envelopes; key IDs, service and record identity are bound to encryption.
Envelope rotation rewraps data keys; historical single-key ciphertext remains
readable as `local-v1` and is converted once. Identity adds key IDs/wrapped keys
to both OIDC tables; Controller adds wrapped keys to Provider credentials.
The shared Go module exposes a KMS adapter seam; no external adapter is shipped.

Controller and Identity share encryption configuration loading through the
dependency-free `secret-encryption` module. Each service passes its own prefix
and key-check callback; active and decrypt-only keys retain the existing
development-secret admission, sanitized errors and variable-only WARNs. The
module does not depend on `service-authentication`.

Once all replicas are upgraded, add both keys, switch all writers, run rekey until
every owned table reports zero, then remove the old key. Keep retired keys with
old backups. See
[Rotating encryption keys](docs/encryption-key-rotation.md). Single-key mode and
the existing public-secret admission gate remain; ring values/active IDs are
exact and never trimmed. ACP's client-MCP key is outside this rotation.

Development deployments require all twelve database/bootstrap passwords and
encryption keys instead of falling back to public values (#13). Controller and
Identity now validate their single-key/ring choice at startup. Compose forwards
these fields with `:-`, so `compose config` can succeed when either owner's
encryption configuration is missing or conflicting; `docker compose up --wait`
then fails because the service refuses startup. Compose's render-time
missing-secret check covers **10 of the original 12 fields**: nine passwords and
the ACP client-MCP key. This avoids Compose 2.38 evaluating `:?` inside an unused
alternative branch; all secrets remain mandatory and have no public fallback.
`.env.example` leaves secrets empty. Quick start and operations use
`scripts/generate-dev-env.sh`,
which creates independent random passwords/keys in a 0600 `.env`, refuses existing
output by default, and prints only the administrator password once.

Upgrade note: services now reject the published database passwords and uniform
32-byte encryption keys on every startup. New bootstrap administrators also
reject the published password; an existing account does not consume or reset that
unused setting. Retain keys/passwords with their data; regenerating `.env` with
`--force` does not migrate existing encrypted records or rotate database roles.
Explicit disposable fixtures can use exact `ANTNEST_ALLOW_PUBLIC_DEV_SECRETS=true`
with per-variable WARNs. Standard Compose never passes this flag; it is independent
of other development gates and cannot restore retired Registry authentication.

PostgreSQL admin and Temporal database passwords now pass the same public-secret
admission on every dependency start (#80). PostgreSQL checks before the official
entrypoint even with existing data; the derived Temporal image preserves its base
entrypoint/command/user and checks before the upstream server starts. Temporal
database/schema jobs and Skill Registry database initialization check before
using credentials. The shared POSIX shell list is checked against contract
revision 2, which adds dependency owners without changing values or opt-in
semantics. Disposable overrides now opt in every checker; private Tier A
dependency passwords keep working without the exception. Unit/component, Compose
wiring and required Tier B startup/restart regression cover these entrypoints.

Go workload authentication and CCT verification are consolidated in
`modules/service-authentication`, consumed by Identity, Gateway, Console,
Controller, RC and Registry. Services retain route and business authorization;
Identity retains issuance and live-session/revocation policy. Standalone and
container builds include the shared module; its changes run all six consumers'
CI and the module's own vector/TLS/mTLS suite. Repository checks reject restored
private copies and missing dependency, Docker or CI inputs.

The #101 / #25–#32 authentication rollout is integration-admitted. All ten
owning-service batches passed their local gates. The final token/HTTP Docker gate
passes 560 network checks on all 24 created networks and 30 actual issuer/context,
caller-role and native Runtime checks, followed by real login, model discovery,
automatic learning/notices, temporary Skill use/cancel/restart/retry, browser
promotion, frozen Templates, read-only presets and explicit two-Agent rebuild.
Business and learning Trace topology passes; no external Provider is called.
The production deployment gate was repeated after private-bridge hardening:
51 checks across 14 healthy services/helpers pass, including actual Jaeger
ingestion and every normal exit zero. Owned resources, candidate tags and keys
are cleaned; retained Docker identities remain unchanged.

All private bridges now use `gateway_mode_ipv4=isolated` with `internal: true`.
Docker Engine 28+ is required. Integration reproduced cross-network HTTP access
with default/`nat` multihomed bridges and confirms rejection with `isolated`.
Recreate an existing deployment's own networks through its normal stop/start
procedure; this creation option cannot update an existing network in place.

This is a coordinated cutover: prepare credentials/issuer/master mounts first;
Identity must precede Gateway and CCT consumers, RC/native Runtime must precede
Controller's private relay and ACP adoption, and Controller revision 38 must
precede Console's model-only discovery. Remove retired shared token settings.
The admitted full-platform profile is disposable token/HTTP; service-local mTLS
evidence does not claim a full-platform mTLS deployment. Independent #35, #58
and #77 remain outside this rollout.

Fresh development deployments must prepare private per-pair workload credentials,
Identity CCT keys and an RC instance master with `scripts/dev-service-tokens.mjs`,
then load its private `deployment.env` before Make/Compose. Read-only owner mounts
and generating UID/GID replace shared bearer defaults. Existing issuer/master
material is never overwritten; retain it with the corresponding deployment data.
The optional `--with-skill-learning` profile generates a separate signer/verifier
pair and activates pinned learning/discovery origins. No Provider key is generated.

Purpose-only listeners, canonical client addresses, owner database/outbound
networks and a separate ACP Controller control listener replace the shared
development network. Jaeger is outside Runtime management; bounded OTLP ingress
supplies its fixed Runtime destination. Health follows the configured listener
and bypasses proxies/redirects, with RC/Egress's separate loopback probes retained.

Base Compose publishes only Gateway. Host-port contract revision 2 selects an
opaque diagnostic relay for explicit loopback diagnostics, retaining the existing
port defaults. Product stage3 overlay order no longer suppresses a selected debug
overlay. Dependency-only tooling uses its own relay-port override. Startup and
shutdown must retain the same files, profiles, environment and project.

The development PKI helper generates a fresh private CA and independent P-256
leaves with exact service identities and both TLS usages. Native/TLS and isolated
read-only Docker mount checks pass. It does not reconfigure a running stack;
native Runtime retains its separate per-instance token profile.

### Fixed

Runtime survives connected UDP `ConnectionRefused` while Runtime Egress restarts
(#219). Established sessions count refused sends and receives as dropped traffic
and recover through WireGuard's existing timers. Readiness remains fail-closed;
other socket errors, write timeouts and incomplete writes remain fatal. The bounded
network snapshot and OTLP metrics now include the aggregate refusal count.

Identity Service SERVER spans now report the contract RPC route, for example
`/rpc/identity/issue-scim-token`, for Admin Console calls and for calls that
service authentication rejects. Before this fix they reported the
`/rpc/identity/` mount prefix (#158).

The ACP MCP input PostgreSQL test waits for the Agent's final update to reach
the client instead of asserting it as soon as the Run commits (#135).

The Skill Registry Admin Console discovery E2E runner uses unified service
authentication: the Console receives an Edge Gateway service token and signed
caller context, and calls the Registry with its own service credential instead
of the removed `ANTNEST_SKILL_REGISTRY_API_TOKEN` (#119).

The Runtime Controller observation retry E2E runs on the current development
topology again. Its fault proxy uses a private fixture network instead of the
removed `development` network, it reaches Runtime Controller through the
diagnostics relay with Agent Controller's service credential, it reads
loopback-only readiness from a probe in the controller's network namespace,
and it opens the Egress attachment with an authenticated probe. The suite is
enabled in integration CI again (#139).

Agent TCP through the Runtime tunnel now completes on hosts with strict or
loose reverse-path filtering (`rp_filter=1` or `2`, the Ubuntu default that
container namespaces inherit). Previously the kernel dropped every reply
arriving on `antnest0` because its reverse-path lookup carries no Agent uid
and found no route; a Tunnel IPv4 source rule now resolves it through the Agent
table (#114).

The Agent UI receipt contract E2E reads ACP's wire through the pinned
`agent-acp-workspace` address with Agent UI's service credential and an
Identity-issued workspace caller context. Previously it used the ambiguous
`agent-acp-service` name and identity hint headers that ACP ignores (#120).

The Skill Registry temporary runtime and skill learning runtime preparation
E2E runners start the Runtime the way Runtime Controller does again. They
install a private service caller receiver and send `Antnest-Service-Authorization`
on every Runtime call, publish the Runtime listen port unchanged so the `Host`
header passes admission, and the learning runner mounts the private managed MCP
HOME tmpfs. Both suites are enabled in integration CI again (#136).

Runtime tests that capture tracing spans no longer lose spans or deadlock when
run in parallel with other tests, a test-only workaround for
[tokio-rs/tracing#3611](https://github.com/tokio-rs/tracing/issues/3611) (#123).

The development Runtime telemetry ingress now reliably answers an oversized or
otherwise rejected upload with its status (for example `413`). It sends the
empty response at once and drains the rest of the upload, bounded to 8 MiB and
the exchange deadline, before closing. Previously, closing with unread bytes
reset the connection and clients saw `ECONNRESET`/`EPIPE` instead (#116).

The authenticated stage 1 shell E2E cleans up on a native Linux Docker daemon:
a short-lived root container clears the Agent-owned workspace before the host
directory is removed. The Runtime candidate build timeout is now 30 minutes, so
a cold build on a 2-core CI runner is not cancelled (#122).

Runtime process scans (background bash groups, managed MCP work, orphan
collection) treat a process that exits mid-scan as gone instead of failing the
whole scan on `ESRCH` (#115).

The Agent UI workspace bridge browser test waits until the selected-view
request is held before answering it, instead of racing the browser and
sometimes never rendering the timeout state it then clicks (#121).

Identity Service PostgreSQL revocation tests pass on Linux: their fixtures now
create versions at PostgreSQL's microsecond precision instead of the Linux
clock's nanoseconds, which failed later optimistic checks (#117).

The Runtime Egress service-authentication E2E fixture makes its credentials
group-readable and adds the capability-dropped Egress container to that group,
so the suite passes on a native Linux Docker daemon (#118).

Runtime Egress rejects tunnel datagrams from an outer IPv4 other than the
Agent's bound Runtime peer, before policy checks or victim-attributed flows.
An aggregate `antnest.egress.peer_mismatch.drops` counter records these drops.
Independent nft destination rules block special-use ranges, the tunnel pool
and all connected IPv4 subnets, even if userspace permits a packet (#34).
TUN input admits DNS only to the virtual resolver; rule/subnet discovery
failures prevent startup.

Managed MCP credentials no longer enter Template/Agent snapshots as plaintext
or appear in configuration reads (#37). Encrypted immutable revisions bind
organization, Template, revision, server and name; keeping a value reseals it
at the new location. Private Runtime bootstrap and distinct managed-process
UIDs prevent direct credential inspection by ordinary model tools. Each server
now has private 0700 HOME/TMPDIR/XDG cache directories; umask 077 also protects
default shared `/tmp` files. Public secret fingerprints and secret-bearing
Template request receipts use protected envelope-keyed HMAC, preventing offline
plaintext guessing and preserving replay after master-key rotation. List reordering
no longer changes server UIDs. The secret editor browser test is registered in
package scripts and root `test-integration-node`, covering desktop/mobile keep,
replace and clear operations.

Controller bounds credential identity fields to 1024 bytes before AAD encoding,
removing unchecked allocation arithmetic and length-prefix conversion reported
by CodeQL. Existing valid AAD encoding, encrypted records and HMAC identifiers
remain unchanged (#37).

Standard Compose single-key configuration now also renders with Compose 2.38.2,
used by repository CI. Removed nested required-value interpolation that evaluated
the unused ring branch. The existing service startup checks still reject missing
keys, conflicting modes and invalid ring members before admitting traffic (#42).

Stored Provider and OIDC secrets no longer depend on one irreplaceable master
key (#42). Bounded row-locked rekey batches resume after interruption and preserve
business revisions, timestamps, pending callbacks and Runtime identity. Identity
metadata updates also rewrap a retained secret under the active key instead of
writing the decrypt-only key back. Unknown keys and tampering fail closed.

Unconfigured deployments can no longer start with the repository's publicly
known credentials or all-zero keys (#13). PostgreSQL password checks use each
driver's parser, including supported URL escaping/query and keyword forms,
without exposing credentials in rejection messages or startup warnings.

The Chinese quick start now includes both private development provisioners and
the generated administrator password. ACP operations no longer describe a
usable all-zero example key. Identity/Controller authentication fixtures use
their random secrets without the public-secret exception. Stage1, Stage2 and
RC's older shell acceptance entrances now provision workload/Runtime credentials
and use the current private listeners and approved image references. These
targets and Lifecycle build isolated candidate images from the checkout and
verify cleanup; Stage1 no longer selects debug Compose by default.

Gateway and Console private authenticated HTTP requests now bypass environment
and default-transport proxies, including Gateway's ACP WebSocket handshakes.
Console removes unrelated `X-Antnest-*`, Cookie and Authorization headers while
preserving verified CCT and replacing workload credentials. Gateway preserves
its own verified presentation hints and SCIM protocol bearer; Registry's
workload-only source requests remove CCT.

ACP and Agent UI now return `401 caller_context_required` when CCT is absent.
Empty, duplicate and invalid CCT still return `401 caller_context_invalid`
before dispatch.

Development credential generation includes the mandatory `use: sig` and
`alg: EdDSA` Identity JWKS fields (#32). The previous public key could verify
Ed25519 signatures but failed the actual issuer's startup contract. A schema
regression reproduces that mismatch; service verification remains strict.

Compose exporters now declare an optional Jaeger dependency, so normal shutdown
keeps the collector alive until exporter flushes finish (#32). The Runtime OTLP
ingress likewise stops before its collector. Jaeger v3 deployment probes replace
the service-list endpoint removed in Jaeger 2.21.

Skill Registry's health probe follows its configured IPv4/IPv6 listener
(#32 deployment follow-up), preserving wildcard loopback behavior and the
existing TLS identity, proxy isolation and redirect rejection checks.

Agent Controller's health probe follows its configured IPv4/IPv6 listener
(#32 deployment follow-up). An empty TLS CA variable keeps the explicit
token/HTTP development transport; TLS identity, proxy isolation and redirect
rejection remain enforced.

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
and actual Controller-to-Egress/full-platform token-profile E2E passed; packet/DNS
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
coordinated deployment and complete token-profile business/security E2E passed.

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
token-profile business/security E2E passed the final integration batch.

Controller now resolves and verifies RC-issued Runtime instance authority on every
accepting execution publication (#30), including equal-revision resends and
restart. The relay remains private to ACP's control origin; credentials never enter
Controller tables, ordinary projections or Trace. Mismatched/unavailable authority
prevents publication and acknowledgement. Closed Agents need no resolution and
carry no credentials, preserving Drain/revocation/disable during Runtime outages.
Private dependency transports now explicitly bypass environment proxies. RC
revision 16 and this relay must precede the ACP instance clients described above;
final token-profile cross-service acceptance passed.

The #30 private execution publication contract now requires verified Runtime
connection identity and ACP authority for accepting Agents. Closed publications
carry only execution fences and never depend on a healthy resolver; revocation,
Drain and settlement cannot be blocked by missing Runtime credentials. Controller
relay and ACP private/public separation are delivered above; final token-profile integration passed.

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
deployment/business E2E passed their separate gates.

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
and full token-profile business/security E2E passed.

The #30 private Runtime instance connection contract is frozen before service implementation. RC owns per-caller, per-Agent/generation CSPRNG tokens and sealed records; Controller privately relays ACP authority. Receiver volumes contain only root-only SHA256 configuration; public bindings/Run snapshots never contain tokens. The contract defines authenticated full status, identity-free liveness, exact Host admission, preserved execution fences/tickets and service-owned producer/consumer batches. RC producer, native Runtime receiver, Controller relay and ACP adoption are described above; final token-profile integration passed.

Runtime Controller now admits only verified Controller workloads on every control route, including all three Skill preparation routes (#29). Control revision 15 adds exact token/mTLS admission and strict JSON errors, an explicit unicast control address (default `127.0.0.1:8080`), and a separate loopback health listener (default `127.0.0.1:8082`). Operators must supply authentication configuration, bind the Controller-purpose address, and remove nonempty `ANTNEST_SKILL_REGISTRY_API_TOKEN`. Registry downloads use per-receiver credentials without proxies or redirects. `ANTNEST_RUNTIME_ALLOWED_IMAGES` accepts exact repository or SHA256-manifest allowlists; the default Runtime repository is the only allowed repository when unset. Disallowed new selections return `422 image_not_allowed` before Docker or journal effects; accepted recovery retains its frozen image ID. Cross-package exported Go route wrappers cannot forward route-pattern parameters to Handle/HandleFunc without failing catalog checks. RC still holds host-equivalent Docker-socket authority; final network deployment, Runtime instance credentials and token-profile cross-service E2E passed their separate gates.

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
ACP service gates have passed; coordinated deployment and full token-profile E2E
passed the final integration batch.

Admin Console model discovery is now a thin, authenticated Controller proxy (#28).
Saved keys never leave Controller; draft keys are forwarded once. The Provider
HTTP client and plaintext `/access` consumer are removed. Browser revision 49
remains unchanged: model metadata is allowlisted and upstream failures use static
safe messages without private addresses or credentials. Controller revision 38
and this Console update must deploy together; final token-profile integration passed. ACP's
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
Controller and Console discovery changes require a coordinated upgrade;
final token-profile integration passed.

The shared Provider destination policy and IPv4/IPv6/DNS fixtures are frozen for
#28 before Controller, Console and ACP adoption. The policy specifies private
endpoint opt-in, checked literal-IP dialing, disabled proxies/redirects and
bounded errors that exclude credentials. Controller, Console and ACP adoption is
recorded above; final token-profile cross-service E2E passed.

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
ACP destination policy, remaining receivers, deployment and final token-profile
cross-service E2E passed their separate gates.

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
custom ports. Controller/deployment admission and final token-profile integration
passed on `feat/service-authentication`; #58 owns long-lived renewal.

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
token-profile integration passed their separate gates.

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
token-profile cross-service acceptance passed their separate gates.

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
consumers, deployment credentials and final token-profile integration passed.
#58 separately owns long-lived renewal.

Identity now rejects administrative calls based only on a body-selected actor
([#25](https://github.com/tf4fun/antnest-platform/issues/25)). RPC revision 14
requires verified workload identity, route allowlists and a signed caller context
whose live session, subject and organization match the operation. It adds a
protected public JWKS endpoint and CCT issuance to access-token resolution.
JSON RPC media types and exact-case/duplicate member rules are enforced before
effects. Missing workload/TLS/signing configuration fails startup. Provision
credentials before the coordinated Identity → Gateway → Console rollout;
complete token-profile Docker integration passed.

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
Compose now requires generated private credentials; upgrading only Registry
with the retired shared-token defaults is unsupported.

Froze the interim service-token configuration and wire profile for
[#101](https://github.com/tf4fun/antnest-platform/issues/101): explicit shared
mode/file variables, canonical per-pair credentials, receiver SHA-256 hash
arrays, strict duplicate-header handling, outcomes and file rotation. Added
public synthetic conformance vectors for Go/TypeScript/Rust adoption. Service
implementations passed their separate owning-service gates on
`feat/service-authentication`, followed by the admitted final cross-service
Docker token-profile acceptance before the branch merges into `main`.

Defined the platform service-authentication foundation for
[#32](https://github.com/tf4fun/antnest-platform/issues/32): workload identity,
Identity-issued caller-context schemas and public verification vectors,
per-service route caller catalogs, and repository checks that detect missing
caller policies or unreviewed custom matchers. Added a shared negative JSON
media-type probe adopted by service-owned tests. Subsequent authentication
middleware, network/port changes and full token-profile Docker security acceptance
are admitted in the rollout ledger; reachable internal peers are no longer trusted.
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
