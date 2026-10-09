# Development authentication provisioning

This deployment-owned contract implements the credential preparation part of
[#32](https://github.com/tf4fun/antnest-platform/issues/32), using the frozen
[platform profile](service-authentication.md). Its
[machine contract](development-authentication-contract.json) is version 1.
Credential preparation does not complete network isolation or cross-service
acceptance; their status remains in the [rollout ledger](service-authentication-rollout.json).

The token/bootstrap helper passed 20 contract/CLI checks and 13 isolated Docker
mount/replacement checks. PKI passed eight native/CLI/TLS tests and 18 isolated
Docker mount/TLS checks. Generated mounts remain read-only and private under
the generating user's numeric UID/GID, except Egress's root-owned bootstrap
files described below. Host-port publication/tooling passed 24
rendered configuration and related fixture tests and three real PostgreSQL/Temporal
host-protocol checks, with owned Docker resource cleanup. The subsequent
Compose cutover is deployment-admitted: 44 wiring/port/dependency/v3 HTTP checks
and 51 actual production-service checks pass without skips/failures. All 14
resident services/helpers start healthy and stop normally; private keys, unique
image tags and owned project resources are cleaned, with retained Docker
container/network/volume identities unchanged.

The subsequent [network contract](development-networks.md) is frozen with
Compose deployment and final token-profile integration admitted. It defines dedicated Gateway ingress,
opaque diagnostic forwarding and a restricted Runtime OTLP destination. The
port evidence below applies to the intermediate direct-publication overlay;
actual unicast and isolated-bridge reachability have since passed at network cutover.

## Static credentials

`scripts/dev-service-tokens.mjs` uses Node's built-in modules only. It reads each
static service's checked-in caller catalog and derives a distinct
caller/receiver pair for every `workload` grant. Multiple routes for a pair
share that pair's credential; public, health, fallback and delegate records do
not create grants. Unknown callers, catalog/service mismatches and self-calls
without an explicit workload grant fail before writing credentials.

The nine current static workloads produce 25 pairs. The count is a reviewed
result of the catalogs, not a hardcoded authorization table. No static
`antnest-runtime` token is produced: RC owns its separate per-Agent/generation
issuance under the [instance connection contract](../runtime/instance-connection.md).

Each pair receives 32 CSPRNG bytes, encoded as exactly 43 canonical unpadded
base64url ASCII bytes, with no newline. The receiver's `callers.json` stores
only the SHA256 of those ASCII bytes. A caller has only its own outgoing files;
files are named by the exact receiver service with no extension. A receiver
without incoming pairs gets `{}`; a caller without outgoing pairs gets an
empty `tokens/` directory. Receivers remain subject to their per-route allowlist.

The generated layout is:

```text
artifacts/service-authentication/
  manifest.json
  deployment.env
  <service>/
    callers.json
    tokens/<receiver>
  identity-service/
    cct-signing.pem
    cct-jwks.json
  runtime-controller/
    instance-master.key
  runtime-egress/
    tunnel-master.key
```

The root and its child directories are mode 0700; all files are mode 0600.
Generation refuses any existing output path, including an empty directory or
symlink. It never overwrites or rotates a running deployment's credentials.
Paths must stay under the ignored `artifacts/service-authentication/` tree or
the private `artifacts/verification/` tree used by isolated tests. Symlink
ancestors, `.cache`, unsafe environment-file path characters and paths outside
those trees are rejected. Add the Git ignore entries before generation; Docker
build contexts already exclude `artifacts/`.

Generation removes only its own newly created directory on failure. Its CLI
prints counts and a completion classification, never credentials, hashes,
private keys, environment contents or underlying filesystem errors. The
manifest contains the version, service names, pair identities and public key
IDs, with no raw tokens or private keys. Keep it private with the output tree.

## Independent bootstrap keys

The same fresh deployment gets an independent Ed25519 Identity CCT key, one
unencrypted PKCS8 PEM private block and a public JWKS containing its exact
generated key ID. The formats match the
[Identity signing contract](../identity/service-authentication.md). CCT
signing is not shared with workload tokens, TLS or Skill maintenance.

RC gets a separate exactly 32-byte raw CSPRNG instance sealing master. Mount
that file read-only through `ANTNEST_RUNTIME_INSTANCE_KEY_FILE`; retain it with
the RC journal and backups. Re-running the generator into a different output
is a new deployment, not a way to rotate an existing master. Replacing or losing
the master makes existing sealed instance authority unusable.

Egress gets an independent exactly 32-byte raw master for its encrypted
per-generation tunnel rows. Before startup, run
`node scripts/dev-egress-auth-owner.mjs` with the generated
`ANTNEST_SERVICE_AUTH_DIRECTORY` sourced. The one-shot, network-isolated Docker
helper mounts only `runtime-egress/callers.json` and `tunnel-master.key`, changes
their owner to UID/GID 0 and keeps mode 0600. This handles Linux bind mounts
without changing other services' owners or introducing a running service. Repeat
after restoring or replacing either file; preserve the master with its database
instead of generating a new one. See the [tunnel contract](../../docs/authenticated-runtime-tunnel.md).

`deployment.env` supplies the output directory, generating POSIX user's UID/GID,
Docker socket GID and Identity signing key ID. Compose must run nonroot
consumers, including Runtime Controller, with those numeric IDs so read-only
host bind mounts remain readable at 0700/0600; do not
make credentials world-readable or elevate those services to root. Invoke the
generator as a non-root user. Egress alone stays `0:0` to read its root-owned
tunnel master, with only `NET_ADMIN` added after dropping all capabilities.

The token CLI detects `ANTNEST_DOCKER_SOCKET_GID` using
`scripts/docker-socket-gid.mjs`: a one-shot container stats the read-only
`/var/run/docker.sock` bind mount. This observes the same group as Controller
on Linux and Docker Desktop; the macOS host socket's group is not the VM's
container-visible group. The helper is non-root, drops every capability, has
no network and a read-only rootfs, and uses `--pull=never` with the existing
`node:24.21.0-bookworm-slim` fixture image. Preload that image or explicitly set
a verified decimal `ANTNEST_DOCKER_SOCKET_GID` (group `0` is valid). Missing,
invalid or undetectable groups fail with a named error; Compose has no fallback.
The shared E2E fixtures detect the group rather than inheriting retained IDs.
Programmatic `provisionTokens` accepts `dockerSocketGid`; credential-only callers
can leave it empty but must supply a detected value before starting Controller.
The secret-only `generate-dev-env.sh` preserves an explicitly exported socket
GID without requiring Docker; normal credential provisioning supplies the
detected value in its private `deployment.env`.
Without `--with-skill-learning`, it also supplies empty Skill maintenance key
defaults. Explicit exported shell settings still take precedence in Compose;
the helper does not silently change them. With that explicit
flag, a separate Ed25519 pair supplies the existing ACP canonical base64 PKCS8
DER environment setting and the matching RC public verifier JSON. The Runtime
bootstrap still binds those public verifiers into its deployment identity;
existing maintenance rotation/rebuild rules remain unchanged. This helper does
not enable a debug learning mode or use Provider credentials.

## Mounting and startup

Use `docker compose --env-file artifacts/service-authentication/deployment.env`
after preparing credentials, or source that private file before the documented
Make/Compose commands. Use the same credential directory for subsequent starts.
The base development profile selects exactly `token` and the explicit
`ANTNEST_SERVICE_AUTH_ALLOW_INSECURE_TRANSPORT=true` HTTP opt-in. These generated
credentials are for disposable development, not a production transport policy.

Mount each receiver JSON file and each sender directory read-only at separate
paths outside the workspace and Skill volumes. Mount Identity's two CCT files
and RC's and Egress's independent masters separately; never mount the whole credential root into a
service. Bind sender directories, rather than individual token leaves, so
atomic file replacement remains visible in containers. The receiver hash file
is loaded once; a receiver restart is required after replacement.

Production and development rotation follow the same fixed order: receiver
current+next and restart, atomically replace the sender file, then remove the old
hash and restart after a deployment-defined bounded overlap/drain. The fresh
generator intentionally has no live rotation command. Do not regenerate tokens
against a retained journal or install public conformance fixture credentials.

## Host ports and explicit diagnostics

The machine contract's `host_ports` section freezes deployment publications.
The base `compose.yaml`, with every profile enabled, publishes only Edge
Gateway's browser port, bound to `127.0.0.1:8090` by default. Ports on container
networks do not imply host publication. Runtime MCP, the management network
and separate health listeners have no host-port mapping.

`compose.debug.yaml` is an explicit development-only overlay. It publishes
PostgreSQL (55432), Temporal (7233), Runtime Controller (58080), ACP's workspace
listener (58081), Identity (58082), Agent Controller (58083) and Jaeger's query
UI (16686). Every mapping is fixed to host loopback. The existing service-specific
`ANTNEST_*_HOST_PORT` setting may select a different port, including `0` for
Docker-assigned isolated-test ports; it cannot select a different host address.
Debug publication neither disables workload/CCT verification nor publishes
ACP's Controller-only control listener. It does not change Identity's public
callback URL or enable Skill learning debug settings.

`host_ports.revision` is 2 after purpose-network cutover. The sole diagnostic
publisher is `diagnostic-relay`: its fixed listener forwards opaque bytes to the
logical backend `target` in the machine contract. It has no credentials and
does not relax the receiver's route or context checks. `compose.stage3.yaml`
does not suppress explicitly selected diagnostics by file order. Startup and
shutdown must use the same ordered files, profiles, project and environment.

The disposable dependency harness must load debug explicitly, bind dependency
ports to loopback with Docker-assigned port numbers and query those published
ports. Its plans start only PostgreSQL or PostgreSQL/Temporal, never a retained
stack or an application workload. Full-stack test entry points must likewise
select their diagnostic overlay explicitly rather than relying on base ports.
This does not waive the final Gateway-only/security regression.

The contract was frozen before Compose/tooling implementation. Admission passed
rendered Compose checks for all profiles and overlay orders, a real PostgreSQL
query and Temporal's `GetSystemInfo`/`DescribeNamespace` through the dependency
harness, and cleanup of the harness's own containers, networks and volumes. At
cutover, the dependency harness also loads `tests/support/compose.dependencies.yaml`,
starts the relay alongside PostgreSQL or PostgreSQL/Temporal, discovers a free
purpose-network prefix and retrieves only the relay's assigned loopback ports.
Inactive workload declarations use inert paths that are never mounted;
no application or placeholder credential files are created. Full
cross-service authentication/network/browser acceptance subsequently passed in
the explicit integration batch.

## Current Compose cutover

The base file explicitly selects the disposable token/HTTP profile for all nine
static workloads. Each receiver JSON and outgoing directory is a separate
read-only bind with `create_host_path: false`; Identity signing/JWKS and RC's
instance master are separate owner mounts. Seven ordinary services use the
generating numeric UID/GID; RC/Egress retain their documented privileges.
Missing prepared files fail startup instead of becoming empty directories.

Identity's generated JWKS includes the issuer-required `use: sig` and
`alg: EdDSA` metadata, validated against the actual CCT JWKS schema. Merely
checking Ed25519 signature round trips does not establish issuer compatibility.

The optional maintenance signer activates learning/discovery origins. Static
source and Registry clients use their distinct receiver-specific sender files;
the four retired shared token channels are absent. Controller publication uses
the ACP control alias, while user/bridge/source reads use its workspace alias.
Provider private endpoints remain disabled by default. Exporters use Jaeger's
observation address; Runtime OTLP uses the restricted management ingress.

Run `make test-deployment-wiring` and `make e2e-deployment-wiring` for this batch.
The latter builds isolated production image tags and prepares temporary keys,
then checks actual health, owner mounts, fixed addresses, diagnostic authority,
management OTLP admission into Jaeger and normal shutdown. It removes only its
project, tags and credentials and compares retained Docker resource identities.
It performs no Provider call and is deployment evidence. Final per-network
security and browser/lifecycle/Skill acceptance separately passed through
`make e2e-service-authentication-integration`.

Jaeger 2.21 removed the legacy service-list endpoint; deployment probes use v3
services and OTLP trace responses. Exporter dependencies retain the collector
until normal SDK shutdown completes. The gate reproduces the former ACP exit 1
when the collector stopped concurrently, and now verifies every exit is zero.

## Development PKI

`scripts/dev-pki.sh` delegates to `scripts/dev-pki.mjs` using the selected Node
on `PATH` and a noninteractive OpenSSL executable. It creates a fresh ignored
`artifacts/dev-pki/` tree, or a fresh private verification subtree. It follows
the same output/alias/permission/overwrite rules as token provisioning, without
allowing token output paths as PKI destinations. Both helpers share the same
private filesystem operations; the token suite and its Docker checks also pass
after that reuse.

Run it with the selected Node (for local development, select NVM first):

```sh
sh scripts/dev-pki.sh
```

`--output PATH` chooses a fresh directory under the allowed trees. The command
prints only completion metadata. It does not restart services or replace an
existing issuer.

Each deployment has an independent ECDSA P-256 CA and nine independent P-256
leaves. Private keys are unencrypted PKCS8 PEM. The CA is valid for 365 days,
has critical CA/key-signing constraints and path length zero. Leaves are valid
for 30 days, have critical `CA:false` and digital-signature constraints, and
both `serverAuth` and `clientAuth` EKUs. Every leaf has exactly one workload URI
`antnest://service/<service>` and its canonical service DNS name. ACP also gets
the two contract-declared control/workspace DNS aliases. There are no wildcard,
loopback/IP, arbitrary user-supplied or native Runtime names.

The tree contains `ca.pem`, `ca-key.pem`, each `<service>/cert.pem` and
`<service>/key.pem`, a public-identity-only `manifest.json`, and private `pki.env`
with `ANTNEST_DEV_PKI_DIRECTORY` and the generating POSIX UID/GID. Temporary
signing requests/configuration are removed after generation. Subprocess output
and private key contents are never printed. Failure/cancellation stops and
reaps OpenSSL before removing newly generated output; it never removes a retained
deployment or parent directory.

Mount only the CA certificate and each service's own leaf/key read-only, outside
workspace/Skill volumes. The CA private key is never a service mount. Retain it
privately for that deployment's controlled renewal; a fresh generator run is a
new issuer, not an in-place CA or leaf rotation. Certificate selection and mode
changes still require coordinated deployment/restart and explicit receiver trust.
The helper does not change Compose, enable mTLS, or relax token/HTTP policy.
Native Runtime currently supports only its separate instance HTTP token profile
and must not receive a global static leaf or token.

The noninteractive CSR/root and certificate-signing interfaces follow the
[OpenSSL req](https://docs.openssl.org/4.0/man1/openssl-req/) and
[OpenSSL x509](https://docs.openssl.org/4.0/man1/openssl-x509/) documentation.

`make test-service-authentication` includes native certificate-format, strict
OpenSSL purpose, actual TLS peer rejection, overwrite/alias, inherited-umask,
failure and normal-cancellation checks. OpenSSL is required for these tests.
`node tests/e2e/service-authentication/development-pki/run.mjs` checks each
static leaf in a separate nonroot, read-only, capability-free Docker container
with no network or published ports. Only the public CA and that service's own
leaf/key are mounted. Its loopback mTLS handshake and missing-certificate/name
rejections prove the generated material works in the container, not production
route authorization or a full-platform mTLS deployment. Owned containers and
generated keys are removed; private evidence retains only source identities and
completion/cleanup metadata.

## Deployment and integration admission

Purpose networks, isolated private bridges, explicit listener bindings,
authentication/key mounts and the complete Docker security/browser/lifecycle/Skill
regression passed their separate deployment/integration gates. Final integration
uses only disposable token/HTTP credentials and a deterministic model; it makes
no full-platform mTLS claim. Gateway-only base ports and the explicit diagnostic
overlay/tooling are admitted. Credential generation never reconfigures an existing
running stack; adopt the new network creation options through that deployment's
normal stop/start procedure.
