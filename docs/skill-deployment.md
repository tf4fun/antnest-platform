# Deploying Skill Learning And Dynamic Propagation

This document describes how to enable automatic personal Skill maintenance and
dynamic Skill source discovery in the standard Docker deployment.

The standard `compose.yaml` and `compose.stage3.yaml` already wire signed
maintenance, learning policy reads, automatic source projection and dynamic
discovery. No configuration override from the test directories is needed. The
interfaces and permissions are defined by the
[deployment contract](../contracts/skill-registry/deployment.md).

## Configuration

When all of the following values are empty, personal Skill maintenance and
dynamic source discovery stay off. Registry package hosting, Template references
and read-only preset delivery remain available. The operator provides stable
values explicitly:

| Variable                                      | Used by                                                                                   |
| --------------------------------------------- | ----------------------------------------------------------------------------------------- |
| `ANTNEST_ACP_SKILL_MAINTENANCE_SIGNING_KID`   | ACP signing key ID                                                                        |
| `ANTNEST_ACP_SKILL_MAINTENANCE_SIGNING_KEY`   | ACP Ed25519 PKCS8 DER private key, standard base64                                        |
| `ANTNEST_RUNTIME_SKILL_MAINTENANCE_VERIFIERS` | Runtime Controller public current/next verifier set; frozen into a Runtime on create/rebuild |
| `ANTNEST_SKILL_REGISTRY_SOURCE_TOKEN`         | Separate source-read bearer shared by ACP and Registry; at least 32 printable characters  |

The Registry API bearer remains the existing `ANTNEST_SKILL_REGISTRY_API_TOKEN`
and must differ from the source bearer. From the source bearer, Compose sets the
private addresses and tokens on both sides. Setting the signing private key also
connects ACP to the existing Controller learning policy endpoint. Each Agent's
maintenance policy still decides whether automatic learning is on, when it
triggers and its budget; there is no separate user learning command.

Registry shares `OTEL_SDK_DISABLED`, `OTEL_TRACES_EXPORTER`,
`OTEL_EXPORTER_OTLP_ENDPOINT` and the `http/protobuf` protocol with the other
services, and also supports trace-specific endpoint/protocol settings. Export is
off by default and the service name is fixed to `skill-registry`. With export
off, W3C context propagation is retained. HTTP spans do not capture bodies,
query strings or credentials. See the
[trace boundaries contract](../contracts/skill-registry/trace-boundaries.md).

Use existing keys if you have them. For a first, empty development deployment
you can generate a `.env.skills` file with a local Node installation. Keep the
file out of Git and Docker build contexts. The command does not print the
private key and does not overwrite an existing file:

```sh
node --input-type=module <<'JS'
import { generateKeyPairSync, randomBytes } from 'node:crypto';
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
  ANTNEST_SKILL_REGISTRY_SOURCE_TOKEN: randomBytes(32).toString('base64url'),
};
writeFileSync('.env.skills', Object.entries(values).map(([k, v]) => `${k}=${v}`).join('\n') + '\n', { mode: 0o600, flag: 'wx' });
JS
```

Keep these values stable and include them in the existing protected
configuration backup. Do not paste the resolved Compose environment into
tickets, screenshots or public logs. The command only generates new maintenance
credentials; it does not read, decrypt or replay model Provider credentials.

## Start And Apply

Prepare `.env`, images and networks as described in the
[single-node operations runbook](docker-single-node-operations.md), then start
with the standard configuration. The two env files are read in order; the
second only adds the Skill options:

```sh
docker compose --env-file .env --env-file .env.skills \
  -f compose.yaml -f compose.stage3.yaml --profile stage3 up -d --build --wait
```

Changing the Runtime Controller configuration does not modify the public key
set of a running Runtime. New Agents use the current configuration; existing
Agents pick it up only through the normal Template and explicit rebuild flow.
Do not change the verifier set while a lifecycle operation is in flight.
Rotation and compromise handling follow the
[learning key contract](../contracts/skill-learning/learning-api.md).
To enable only personal automatic learning, leave the source bearer unset and
configure the signing key and public verifier set.

## Verification

`make test-skill-deployment` renders the standard configuration with synthetic
temporary keys and checks the independent switches, the bearers on both sides,
consistent private addresses, private-key isolation, and that the standard build
includes Registry.

`make e2e-skill-deployment` builds isolated candidate services and, using these
standard environment variables, runs real learning, source projection,
temporary use, browser promotion, and Template create/rebuild/Run. Its
configuration override selects only candidate images, network ranges and a
local model. It does not use the real `.env`, consumes no real model quota, and
removes all of its resources when it finishes.
