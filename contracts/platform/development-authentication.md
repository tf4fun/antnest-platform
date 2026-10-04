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
the generating user's numeric UID/GID. Compose/network admission remains pending.

## Static credentials

`scripts/dev-service-tokens.mjs` uses Node's built-in modules only. It reads each
static service's checked-in caller catalog and derives a distinct
caller/receiver pair for every `workload` grant. Multiple routes for a pair
share that pair's credential; public, health, fallback and delegate records do
not create grants. Unknown callers, catalog/service mismatches and self-calls
without an explicit workload grant fail before writing credentials.

The nine current static workloads produce 23 pairs. The count is a reviewed
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

`deployment.env` supplies the output directory, generating POSIX user's UID/GID
and Identity signing key ID. Compose must run nonroot Node consumers with those
numeric IDs so read-only host bind mounts remain readable at 0700/0600; do not
make credentials world-readable or elevate those services to root. RC and Egress
retain their existing separately justified Docker/kernel privileges.
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
after preparing credentials. Compose wiring is a subsequent deployment batch.
The base development profile selects exactly `token` and the explicit
`ANTNEST_SERVICE_AUTH_ALLOW_INSECURE_TRANSPORT=true` HTTP opt-in. These generated
credentials are for disposable development, not a production transport policy.

Mount each receiver JSON file and each sender directory read-only at separate
paths outside the workspace and Skill volumes. Mount Identity's two CCT files
and RC's master separately; never mount the whole credential root into a
service. Bind sender directories, rather than individual token leaves, so
atomic file replacement remains visible in containers. The receiver hash file
is loaded once; a receiver restart is required after replacement.

Production and development rotation follow the same fixed order: receiver
current+next and restart, atomically replace the sender file, then remove the old
hash and restart after a deployment-defined bounded overlap/drain. The fresh
generator intentionally has no live rotation command. Do not regenerate tokens
against a retained journal or install public conformance fixture credentials.

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

## Pending deployment and integration work

Purpose networks, explicit listener bindings, Gateway-only base ports, the debug
overlay and the full Docker security/browser/lifecycle/Skill regressions remain
separate deployment/integration admission work. No existing running stack is
reconfigured by credential generation.
