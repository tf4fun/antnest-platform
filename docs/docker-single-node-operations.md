# Docker Single-Node Operations

This runbook covers deploying, operating and removing one development or
evaluation deployment of Antnest Platform on a trusted Docker Engine. It is not
an Internet-facing production installation: TLS termination, production secret
delivery, external backup storage and high availability are outside this
profile. A healthy container alone does not prove a usable Agent; follow
section 4 to verify the full path.

## 1. Prerequisites And Ownership

- Use a Linux Docker Engine, or Linux containers in Docker Desktop/OrbStack.
  Egress and Runtime require `/dev/net/tun` and container network administration;
  the Runtime also drops privileges for Tool execution. Do not remove these
  controls to make readiness pass. Rootless Docker is not supported.
- BuildKit must support Dockerfile cache mounts. Compose must understand
  `!reset`, `!override`, `healthcheck.start_interval` and `networks.gw_priority`. Inspect
  `docker version` and `docker compose version`; a rejected Compose file is a
  prerequisite failure, not a reason to omit the `compose.stage3.yaml` override.
- The selected Docker context is the deployment target. Runtime Controller uses
  that Engine's socket, image store, networks and volumes. A local Runtime image
  on a different Engine is not available to the Controller.
- The host needs Make, Docker and Node 24.21 for builds and fresh credential
  preparation. Host-side fixture tests and E2E drivers additionally need the
  locked ACP service dependencies.
  Go/Rust/Node compilers for image builds are inside the Dockerfiles.
- Reserve ports and non-overlapping subnets before startup. Never prune the
  entire Engine to make room for this deployment.

```sh
docker context show
docker version
docker compose version
```

With the `stage3` profile enabled, one PostgreSQL container hosts six
independently owned application databases and roles:
`antnest_egress`, `antnest_runtime_controller`, `antnest_agent_acp`,
`antnest_identity`, `antnest_agent_controller`, and `antnest_skill_registry`.
Their schemas are not shared.
Each service runs its own migrations; the database initializer only creates
roles/databases and removes public connection privileges.
Temporal additionally uses `antnest_temporal` and `antnest_temporal_visibility`,
both owned by the separate `antnest_temporal` role. Temporal does not access
application tables.

## 2. Configuration Before First Start

Copy `.env.example` to the ignored `.env` and use it as the configuration
inventory.

> **Warning:** the passwords and zero-valued keys in `.env.example` and
> the Compose defaults are public, disposable local development values. Anyone
> can read them in this repository. Override every one of them before storing
> any non-disposable data or exposing the deployment beyond your workstation.

Keep `.env`, `.secret`, `auth.json` and any other credential files out of Git and
Docker build contexts. Do not publish `docker compose config` or `docker inspect`
output containing resolved environments.

For a fresh deployment, prepare the private workload credentials and independent
Identity/RC bootstrap keys before invoking Make or Compose:

```sh
node scripts/dev-service-tokens.mjs
set -a
. artifacts/service-authentication/deployment.env
set +a
```

The helper refuses existing output and does not rotate a retained deployment.
Retain this private directory and use the same settings for subsequent starts
and shutdown. Add `--with-skill-learning` to the helper on the first invocation
when automatic maintenance and dynamic discovery are wanted. See the
[provisioning contract](../contracts/platform/development-authentication.md).

Three separate 32-byte base64 keys must remain stable with the associated data:

| Variable                                  | Owner and protected data                                                                      |
| ----------------------------------------- | --------------------------------------------------------------------------------------------- |
| `ANTNEST_IDENTITY_ENCRYPTION_KEY`         | Identity's OIDC secrets                                                                       |
| `ANTNEST_AGENT_CONTROLLER_ENCRYPTION_KEY` | Model credentials                                                                             |
| `ANTNEST_ACP_CLIENT_MCP_KEY`              | ACP's persisted Session MCP revision envelope, including the current empty client-MCP profile |

Generate each independently, for example with `openssl rand -base64 32`. Back up
the resulting values securely, not in this repository. Changing a key is not a
supported way to rotate already encrypted data. Database passwords are inserted
into DSNs by Compose; use URL-safe values such as random hexadecimal strings.

Identity evaluates bootstrap on every start. Keep the organization slug/name
and administrator email stable: an existing organization's different name or
an inactive/non-admin bootstrap identity causes startup conflict; a new email
can create an additional administrator. Changing the password variable does
not reset an existing account password. Removing variables from `.env` restores
Compose's public defaults, not an empty bootstrap. To deliberately disable
bootstrap after provisioning, a Compose override must set all four bootstrap
environment entries to empty strings explicitly. Keep an independently tested
administrator login before making that change. PostgreSQL initialization
variables likewise do not rotate existing roles. Do not delete business data
to solve a login problem.

The default operator stack is `antnest-platform`, with management network
`antnest-runtime-management` and system Skill volume `antnest-system-skills`.
For another stack, change project, Controller scope, network and Skill-volume
names together, plus host ports, `ANTNEST_SERVICE_NETWORK_PREFIX`, the control
and management subnets, fixed infrastructure addresses and the management dynamic
allocation range. The disposable test runners choose
these values automatically; operators should not copy their transient IDs.
Also update `ANTNEST_EDGE_PUBLIC_BASE_URL` to the selected Gateway port/domain
(Identity uses it for OIDC callbacks), and
`ANTNEST_RUNTIME_OTEL_EXPORTER_OTLP_ENDPOINT` if overriding the default Runtime
ingestion address. Jaeger belongs only to observability; Runtime OTLP uses the
restricted management ingress, default `172.30.255.4:4318`. Keep its fixed address
outside the dynamic allocation range. See the
[purpose-network contract](../contracts/platform/development-networks.md).

Optional automatic Skill maintenance and dynamic source discovery are configured
as described in the [Skill deployment guide](skill-deployment.md).
The ACP private signer and Runtime Controller public verifier set are separate
from workload credentials. Registry/ACP now reject the old shared source/API
bearer settings; discovery uses pinned origins and per-pair file/TLS authority.
Compose now mounts each service's prepared credentials and binds its purpose
addresses. Actual deployment admission has passed in the
[authentication rollout ledger](../contracts/platform/service-authentication-rollout.json).
Isolated Registry service gates have passed; complete workflow E2E remains pending. Existing
Runtimes acquire new verifier configuration only through explicit rebuild.

## 3. Build And Start

Build all project images from the current source, serially:

```sh
COMPOSE_PARALLEL_LIMIT=1 make -j1 docker-build-stage3
docker image inspect antnest/antnest-runtime:local --format '{{.Id}}'
```

BuildKit may reuse unchanged layers. This verifies source-to-image construction,
not a bit-for-bit reproducible or cache-free build. A private registry is not
required: Runtime Controller resolves the local image through the same Engine.
Console accepts the image tag and records the resolved immutable image ID.
Rebuilding the tag does not silently replace existing Agents or Template
revisions; publish the intended revision and explicitly rebuild the Agent.

The Temporal image `antnest/temporal:local` uses server 1.32.0 and adds the
same-version official `tdbg` binary plus a read-only readiness probe. Its health
check requires frontend initialization and nonempty frontend/history/matching
gossip rings. A listening 7233 port alone does not establish readiness after
restart. The local HTTP probe port 7243 is not published.

The all-in-one Temporal service advertises `127.0.0.1` for internal membership
so a normal stop/start cannot leave it trying a reallocated Docker interface
address. Its frontend still binds `0.0.0.0` and clients use `temporal:7233`.
This assumes all server roles share one container; split-role or multi-node
deployments require mutually reachable node addresses.

Enable telemetry and retain these settings for subsequent `up` commands:

```sh
export OTEL_SDK_DISABLED=false
docker compose -f compose.yaml -f compose.stage3.yaml \
  --profile stage3 --profile observability config --quiet
docker compose -f compose.yaml -f compose.stage3.yaml \
  --profile stage3 --profile observability up -d --wait --wait-timeout 180 --no-build
docker compose -f compose.yaml -f compose.stage3.yaml \
  --profile stage3 --profile observability ps
```

The base Compose file publishes only Gateway, including when the observability
profile is enabled. Expected host binding with the example config:

| Entry        | Default address  | Purpose                                                             |
| ------------ | ---------------- | ------------------------------------------------------------------- |
| Edge Gateway | `127.0.0.1:8090` | Console `/` and Agent UI `/workspace/`; all browser API/ACP traffic |

For explicit local diagnostics, use this ordered selection for both startup
and shutdown:

```sh
docker compose -f compose.yaml -f compose.debug.yaml -f compose.stage3.yaml \
  --profile stage3 --profile observability up -d --wait --no-build
```

It explicitly enables the credential-free diagnostic relay, publishing
PostgreSQL `127.0.0.1:55432`, Temporal `127.0.0.1:7233`, Jaeger
`127.0.0.1:16686` and RC/ACP/Identity/Controller at ports 58080–58083.
Product overlay order does not suppress explicitly selected diagnostics.
These opaque forwarded connections require the receivers' normal workload/CCT
credentials, and ACP's
Controller-only listener is never published. Debug does not enable model-learning
debug settings or change Identity's public callback URL.

No Runtime MCP or separate health listener is published by either file. The
loopback defaults and insecure-cookie setting are for local HTTP only. Do not
bind them to `0.0.0.0` for public deployment. Follow the
[port contract](../contracts/platform/development-authentication.md#host-ports-and-explicit-diagnostics).

With the `stage3` and `observability` profiles, the deployment runs one
resident container per service plus PostgreSQL, Temporal, Jaeger and the
restricted Runtime telemetry ingress. Explicit debug also starts the diagnostic
relay; both helpers are read-only, nonroot and have no workload credentials.
Exporter dependencies keep Jaeger alive until their normal shutdown finishes;
use the same Compose selection for stop/down instead of stopping the collector first.
`temporal-databases`, `temporal-schema`, and `temporal-namespace` are additional
one-shot initialization jobs, not resident workers: they provision databases,
apply engine schemas, and register the `antnest` namespace, respectively.
Successful exited initialization containers can be removed after startup without
deleting their databases. Compose may recreate/rerun them on a subsequent `up`.
After those jobs are removed, `compose start temporal` can fail while traversing
the absent initialization dependencies. For same-container maintenance, start
the existing Temporal container directly and wait for its Docker health to become
`healthy` before starting Controller. For controlled image synchronization, use
separate `up --no-deps --no-build --pull never --wait --wait-timeout 180` commands
for Temporal and then Controller, with the same project, environment and Compose
overlays. Confirm initialization already completed; this is not first deployment.

## 4. Empty Instance To A Usable Agent

1. Log in to Console with the configured bootstrap organization, email and
   password. The disposable local defaults are `engineering` /
   `admin@example.com` / `antnest-admin-dev`. They are public; override them in
   `.env` for any deployment that is not a throwaway local environment.
2. Add a Model Profile with an available model and credential. Add an active
   organization member when testing the end-user role.
3. Create a Template using that model revision and the built Runtime image tag.
   Optionally select published immutable Registry Skill versions. Later model or
   preset changes require a new Template revision and explicit Agent rebuild.
   No default Template or provider is assumed.
4. Create an Agent for the member. Admission returns a durable operation; wait
   for its completed state and Agent `available`, not just HTTP 202.
5. Sign in as that member at `/workspace/`, open the Agent, create a conversation
   and send a prompt. A real Tool result proves the Runtime path, while a text
   reply alone does not. Provider failures remain visible errors.

For reproducible verification without an external model account:

```sh
npm --prefix services/agent-acp-service ci
make test-lifecycle-fixtures
make e2e-lifecycle
```

The runner creates a new scope, empty databases and local deterministic model;
all lifecycle business commands still pass through Gateway and real services.
It checks real Runtime tools, immutable image resolution, persistent workspace,
replay, startup failure and Jaeger linkage. It also inspects exact built-image
identity, service health and loopback-only host bindings, rejecting accidental
publication of internal application ports. Its extra model port is test-only.
It does not perform browser actions. A failed or interrupted run is not a
passing result. The [lifecycle profile](../tests/e2e/lifecycle-closeout/README.md)
also documents loss/network/crash subcases, which run separately.

## 5. Diagnose Before Retrying

- A failed readiness check: inspect the named service and its dependency, using
  bounded `docker compose ... logs --tail 100 SERVICE`. Never paste credential
  values or full environment dumps into a report.
- An admitted lifecycle operation still running: read its operation ID, phase,
  failure detail and Agent events in Console. Repeating the same request key
  retrieves the same operation; it is not a request for a second build.
- Agent unavailable after Runtime loss: use explicit Rebuild after correcting
  the cause. The old workspace and history are retained. Temporary processes
  and `/tmp` are not. Do not recreate an Agent by editing database rows.
- An unknown Tool side effect: do not infer failure from a missing reply or
  replay a write automatically. The conservative admission fence remains a
  distinct state; follow the documented lifecycle recovery.
- Jaeger: administrative calls start at Gateway and reach Console/Controller;
  asynchronous worker spans link to the admission. Prompt traces reach ACP and
  Runtime. Egress packets have no per-packet traces. Runtime telemetry uses its
  management-network collector address, not a host loopback address.

## 6. Stop, Backup And Remove

Follow the [offline backup/restore runbook](docker-backup-restore.md) before
upgrades or destructive maintenance. Disable Agents and wait for their durable
operations to finish before quiescing the services. That preserves workspace
while releasing Runtime compute. Stopping Compose alone does not disable Agents
or stop dynamically created Runtime containers.

Normal Compose `stop`/`down` does not delete the PostgreSQL or workspace data.
Do not add `-v` unless the exact project is disposable and removal is intended.
For intentional permanent removal, delete each Agent through its normal
lifecycle first; verify completion and its Runtime/workspace removal. Then stop
the stack and remove only that stack's remaining named volumes/networks.
Never use global Docker prune as an application cleanup procedure.

Disposable E2E runners own their cleanup on success, failure and interruption;
they stop resource creators first and verify exact-label container, volume and
network absence. They never remove stacks they did not create.
