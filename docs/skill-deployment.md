# Deploying Skill Learning And Dynamic Propagation

This document describes how to enable automatic personal Skill maintenance and
dynamic Skill source discovery in the standard Docker deployment.

Service authentication is being rolled out on `feat/service-authentication`.
The owning-service gates have passed for Registry and its consumers, but the
standard `compose.yaml` now uses per-pair private file mounts and purpose-address
listeners. Actual deployment admission has passed; complete workflow E2E
belongs to the final integration batch in the
[rollout ledger](../contracts/platform/service-authentication-rollout.json).
The required interfaces and permissions are defined by the
[deployment contract](../contracts/skill-registry/deployment.md).

## Configuration

The following values configure automatic personal Skill maintenance. Without
the signing/verifier profile, maintenance stays off. Registry hosting and
Template delivery require their own service authentication regardless of whether
maintenance or discovery is enabled. The operator provides stable values:

| Variable                                      | Used by                                                                                      |
| --------------------------------------------- | -------------------------------------------------------------------------------------------- |
| `ANTNEST_ACP_SKILL_MAINTENANCE_SIGNING_KID`   | ACP signing key ID                                                                           |
| `ANTNEST_ACP_SKILL_MAINTENANCE_SIGNING_KEY`   | ACP Ed25519 PKCS8 DER private key, standard base64                                           |
| `ANTNEST_RUNTIME_SKILL_MAINTENANCE_VERIFIERS` | Runtime Controller public current/next verifier set; frozen into a Runtime on create/rebuild |

The signing and verifier `kid` use one exact ASCII identity:
`^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$` (1–64 characters, letter or digit first,
then letters, digits, `_` or `-`). Dots, non-ASCII characters and whitespace
are rejected, without trimming. ACP's signing `kid` must exactly match a
trusted Runtime verifier. The authoritative definition is in
[RuntimeSpec](../contracts/runtime/runtime-spec.schema.json#/$defs/maintenanceKid);
the schema, RC, Runtime and ACP share the
[accept/reject fixtures](../contracts/runtime/maintenance-kid-fixtures.json).

Before upgrading an existing deployment, check the
[signing key ID compatibility notice](../CHANGELOG.md#unreleased). ACP now
rejects signing key IDs with leading or trailing whitespace, as well as
whitespace-only values, at startup; previous versions trimmed them.

Dynamic discovery uses ACP's `ANTNEST_ACP_SKILL_REGISTRY_URL` and Registry's
`ANTNEST_SKILL_REGISTRY_SOURCE_URL`, with separate credentials for ACP → Registry
and Registry → ACP. Registry also requires `ANTNEST_IDENTITY_URL` and its own
Identity sender credential for Console CCT verification. All services use the
shared [file/TLS profile](../contracts/platform/service-authentication.md):
receiver files hold hashes, sender files hold per-pair credentials, and token
files are validated at startup and reread per request. Nonempty legacy
`ANTNEST_SKILL_REGISTRY_API_TOKEN`, `ANTNEST_SKILL_REGISTRY_SOURCE_TOKEN`,
`ANTNEST_ACP_SKILL_REGISTRY_TOKEN` or `ANTNEST_ACP_SKILL_SOURCE_TOKEN` fails the
corresponding service startup. No shared bearer enables discovery.

Setting the signing private key also enables ACP's configured Controller
learning policy reader. Each Agent's
maintenance policy still decides whether automatic learning is on, when it
triggers and its budget; there is no separate user learning command.

Registry shares `OTEL_SDK_DISABLED`, `OTEL_TRACES_EXPORTER`,
`OTEL_EXPORTER_OTLP_ENDPOINT` and the `http/protobuf` protocol with the other
services, and also supports trace-specific endpoint/protocol settings. Export is
off by default and the service name is fixed to `skill-registry`. With export
off, W3C context propagation is retained. HTTP spans do not capture bodies,
query strings or credentials. See the
[trace boundaries contract](../contracts/skill-registry/trace-boundaries.md).

For a first, empty development deployment, use the standard provisioning helper:

```sh
node scripts/dev-service-tokens.mjs --with-skill-learning
set -a
. artifacts/service-authentication/deployment.env
set +a
```

It generates independent per-pair workload authority, Identity/RC bootstrap keys
and the separate maintenance signer/verifiers. It refuses existing output and
does not rotate a retained deployment. Its private signer enables the configured
Controller policy reader and both pinned discovery origins in standard Compose;
a public verifier alone does not activate learning or discovery.

Use existing maintenance keys if you have them. When preparing a separate signer,
you can generate a `.env.skills` file with a local Node installation. Keep the
file out of Git and Docker build contexts. The command does not print the
private key and does not overwrite an existing file:

```sh
node --input-type=module <<'JS'
import { generateKeyPairSync } from 'node:crypto';
import { writeFileSync } from 'node:fs';
const kid = 'development-1';
const pair = generateKeyPairSync('ed25519');
const signing = pair.privateKey.export({ type: 'pkcs8', format: 'der' }).toString('base64');
const publicKey = pair.publicKey.export({ type: 'spki', format: 'der' }).subarray(-32).toString('base64url');
const verifiers = JSON.stringify({ keys: [{ kid, algorithm: 'Ed25519', public_key_base64url: publicKey }] });
const values = {
  ANTNEST_ACP_SKILL_MAINTENANCE_SIGNING_KID: kid,
  ANTNEST_ACP_SKILL_MAINTENANCE_SIGNING_KEY: signing,
  ANTNEST_RUNTIME_SKILL_MAINTENANCE_VERIFIERS: verifiers,
};
writeFileSync('.env.skills', Object.entries(values).map(([k, v]) => `${k}=${v}`).join('\n') + '\n', { mode: 0o600, flag: 'wx' });
JS
```

Keep these values stable and include them in the existing protected
configuration backup. Do not paste the resolved Compose environment into
tickets, screenshots or public logs. The command only generates new maintenance
credentials; it does not read, decrypt or replay model Provider credentials.

## Start And Apply

Prepare `.env`, private deployment credentials and images as described in the
[single-node operations runbook](docker-single-node-operations.md). After sourcing
the helper's private `deployment.env`, start with:

```sh
docker compose \
  -f compose.yaml -f compose.stage3.yaml --profile stage3 up -d --build --wait
```

Changing the Runtime Controller configuration does not modify the public key
set of a running Runtime. New Agents use the current configuration; existing
Agents pick it up only through the normal Template and explicit rebuild flow.
Do not change the verifier set while a lifecycle operation is in flight.
Rotation and compromise handling follow the
[learning key contract](../contracts/skill-learning/learning-api.md).
To enable only personal automatic learning, use an explicit Compose override
that sets ACP's Registry origin and Registry's source origin to empty strings;
standard Compose supplies both when the signer is configured. Mandatory service
and Runtime instance authentication still applies. If using a separate
`.env.skills`, supply it as an additional env file while retaining the sourced
deployment credentials.

## Verification

`make e2e-skill-discovery-registry` is the current Registry-owned gate. It builds
the production image, runs unit/contract/real HTTP/PostgreSQL checks and validates
workload grants, signed Console scope, live discovery, promotion and restart.
Its Identity and source peers implement the required protocols but are not the
actual cross-service implementations. Temporary CSPRNG credentials and Docker
resources are cleaned after the run.

`make test-skill-deployment` covers the new configuration and key/source separation.
`make e2e-skill-deployment` still needs its legacy fixtures replaced in the
integration batch. The final gate
must exercise actual learning, projection, temporary use, browser promotion and
Template create/rebuild/Run with the admitted service authentication profile.
Until then, those complete workflows remain pending; no real Provider credential
or model quota is needed for the isolated model fixture.
