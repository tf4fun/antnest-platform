# Docker Single-Node Operations

This runbook covers one development/acceptance deployment on a trusted Docker
Engine. It is not an Internet-facing production installation: TLS termination,
production secret delivery, external backup storage and HA are outside this
profile. [The closeout checklist](docker-single-node-closeout.md) remains the
acceptance authority; a healthy container alone does not prove a usable Agent.

## 1. Prerequisites And Ownership

- Use a Linux Docker Engine, or Linux containers in Docker Desktop/OrbStack.
  Egress and Runtime require `/dev/net/tun` and container network administration;
  the Runtime also drops privileges for Tool execution. Do not remove these
  controls to make readiness pass. Rootless Docker is not an accepted profile.
- BuildKit must support Dockerfile cache mounts. Compose must understand
  `!reset`, `healthcheck.start_interval` and `networks.gw_priority`. Inspect
  `docker version` and `docker compose version`; a rejected Compose file is a
  prerequisite failure, not a reason to omit the Stage 3 override.
- The selected Docker context is the deployment target. Runtime Controller uses
  that Engine's socket, image store, networks and volumes. A local Runtime image
  on a different Engine is not available to the Controller.
- The host needs Make and Docker for image builds. Host-side fixture tests and
  E2E drivers additionally need Node and the locked ACP service dependencies.
  Go/Rust/Node compilers for image builds are inside the Dockerfiles.
- Reserve ports and non-overlapping subnets before startup. Never prune the
  entire Engine to make room for this deployment.

```sh
docker context show
docker version
docker compose version
```

One PostgreSQL container hosts five independently owned service databases and roles:
`antnest_egress`, `antnest_runtime_controller`, `antnest_agent_acp`,
`antnest_identity`, and `antnest_agent_controller`. Their schemas are not shared.
Each service runs its own migrations; the database initializer only creates
roles/databases and removes public connection privileges.
Stage 2/3 additionally uses `antnest_temporal` and `antnest_temporal_visibility`,
both owned by the separate `antnest_temporal` role. Temporal does not access
application tables.

## 2. Configuration Before First Start

Copy `.env.example` to the ignored `.env` and use it as the configuration
inventory. Its passwords and zero-valued keys are deliberately public synthetic
development values. Replace them before storing any non-disposable data.
Keep `.env`, `.secret`, `auth.json` and nested credential copies out of Git and
Docker build contexts. Do not publish `docker compose config` or `docker inspect`
output containing resolved environments.

Three separate 32-byte base64 keys must remain stable with the associated data:

| Variable | Owner and protected data |
| --- | --- |
| `ANTNEST_IDENTITY_ENCRYPTION_KEY` | Identity's OIDC secrets |
| `ANTNEST_AGENT_CONTROLLER_ENCRYPTION_KEY` | Model credentials |
| `ANTNEST_ACP_CLIENT_MCP_KEY` | ACP's persisted Session MCP revision envelope, including the current empty client-MCP profile |

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
names together, plus host ports and both subnets. Egress and Jaeger static IPs
must be inside their corresponding networks. The disposable test runners choose
these values automatically; operators should not copy their transient IDs.
Also update `ANTNEST_EDGE_PUBLIC_BASE_URL` to the selected Gateway port/domain
(Identity uses it for OIDC callbacks), and
`ANTNEST_RUNTIME_OTEL_EXPORTER_OTLP_ENDPOINT` to the selected Jaeger management
IP and collector port. These example values are literal URLs, not dynamically
derived from the port/subnet variables.

## 3. Build And Start

Build all ten project images from the current source, serially:

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

The Temporal image `antnest/temporal:local` keeps server 1.31.0 and adds the
same-version official `tdbg` binary plus a read-only readiness probe. Its health
check requires frontend initialization and nonempty frontend/history/matching
gossip rings. A listening 7233 port alone does not establish readiness after
restart. The local HTTP probe port 7243 is not published. See the
[readiness repair](temporal-readiness-revalidation.md) for scope and evidence.

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

Always include `compose.stage3.yaml`. It removes the debug host ports of the
internal application services. Expected host bindings with the example config:

| Entry | Default address | Purpose |
| --- | --- | --- |
| Edge Gateway | `127.0.0.1:8090` | Console `/` and Agent UI `/workspace/`; all browser API/ACP traffic |
| PostgreSQL | `127.0.0.1:55432` | Local development/backup access, not a product API |
| Temporal | `127.0.0.1:7233` | Local SDK/workflow diagnostics, not a product API |
| Jaeger | `127.0.0.1:16686` | Local trace inspection; not an authenticated public dashboard |

No Runtime, ACP, Identity, Controller or BFF host port should be published.
The loopback defaults and insecure-cookie setting are for local HTTP only.
Do not merely bind them to `0.0.0.0` for public deployment.

The Stage 3 observability deployment has eleven resident containers.
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
   password. The example uses `engineering` / `admin@example.com` /
   `antnest-admin-dev`; these are not recommended production credentials.
2. Add a Model Profile with an available model and credential. Add an active
   organization member when testing the end-user role.
3. Create a Template using that model revision and the built Runtime image tag.
   System Skill Registry is deferred; no default Template or provider is assumed.
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
It does not perform browser actions.
Keep only its successful final metrics; a failed or interrupted run is not
acceptance. The [lifecycle profile](../tests/e2e/lifecycle-closeout/README.md)
also documents loss/network/crash subcases, which must run separately.

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
network absence. Retained human-acceptance stacks are not theirs to remove.
