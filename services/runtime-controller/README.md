# Runtime Controller

Runtime Controller owns the platform lifecycle of one logical Runtime
Environment per Agent. Agent Controller issues explicit Initialize, Update,
Disable, Enable, and Delete commands; Runtime Controller realizes them as
private Docker compute and workspace resources and reports a platform-neutral
result. It is written in Go.

The cross-service identity is `agent_id` plus an opaque `runtime_revision`.
Physical generations, deployment digests, container IDs, and volume names stay
private to this service. Docker is the only implemented platform adapter; a
Kubernetes adapter is planned and would be added in-process, not as a separate
service.


Workload authentication and configured Registry transport use the
[shared Go module](../../modules/service-authentication/README.md), with the
caller-context forwarding policy. RC retains its Controller-only route grants,
Docker boundary and separate Runtime instance credential lifecycle.

## Responsibilities

- Issue and atomically seal distinct RC/ACP Runtime tokens with each private
  compute generation. Deliver only caller hashes through a verified root-only,
  read-only receiver volume; exact recovery retains credentials. Privately
  resolve ACP's current connection for Controller; ordinary projections remain
  secret-free. See [the instance connection contract](../../contracts/runtime/instance-connection.md).

- Idempotently `Initialize`, `Update`, `Disable`, `Enable`, `Inspect`, and
  `Delete` one Agent Runtime Environment.
- Allocate internal immutable compute generations and expose only an opaque
  Runtime revision to callers.
- Map one language-neutral Runtime configuration to deterministic Docker
  compute and workspace resources, and bind each generation permanently to one
  deployment digest.
- Resolve an installed image reference to an immutable image ID through a
  read-only platform query; never build or implicitly pull images.
- Complete creation after confirmed platform create/start, without waiting for
  health (see [creation and observation](docs/creation-and-observation.md)).
- Consume platform health and List/Watch events, verify Runtime `/status` on
  Healthy observations and explicit reads, and normalize the facts into an
  ordered, time-retained observation journal.
- Create and retain the Agent workspace as part of lifecycle commands;
  workspace operations are never exposed as a cross-service API.
- Prepare per-Agent system Skill volumes from exact Skill Registry versions and
  mount them read-only into Runtime containers.
- Freeze the Runtime Skill maintenance verifier keys into each accepted
  lifecycle operation. Key IDs follow the shared
  [RuntimeSpec grammar](../../contracts/runtime/runtime-spec.schema.json#/$defs/maintenanceKid)
  and [fixtures](../../contracts/runtime/maintenance-kid-fixtures.json);
  invalid operator configuration fails at startup before creating Runtimes.
- Serialize all mutations for one Agent across Controller replicas, and elect
  one platform-Watch consumer.
- Emit structured logs, traces, and low-cardinality metrics.

## Non-responsibilities

- It does not decide when an Agent is initialized, updated, disabled, enabled,
  or deleted.
- It does not own Agent desired state, active binding, or Run admission.
- It does not dispatch Runs or proxy MCP Tool calls.
- It does not allocate Tunnel IPs, persist Egress policy, or call Runtime
  Egress. Agent Controller supplies the Egress attachment in the Runtime
  configuration.
- It does not run a Runtime reverse-connection server.
- It does not authenticate end users or expose a public API.

## Runtime instance bootstrap

`ANTNEST_RUNTIME_INSTANCE_KEY_FILE` is required: a private regular mode-0600
file containing exactly 32 raw CSPRNG bytes, mounted read-only by deployment.
Retain it with RC's journal across restarts. It is separate from Controller's
credential key and the workload-token directory; losing or changing it makes
existing instance authority unavailable. There is no automatic reissue during
recovery. Development has no legacy data to migrate; rebuild a fresh test stack.

The first instance receiver supports token mode with the explicit
`ANTNEST_SERVICE_AUTH_ALLOW_INSECURE_TRANSPORT=true` opt-in on its isolated
internal network. Native Runtime TLS/mTLS is unsupported and unsupported profiles
fail RC startup; no opt-in is synthesized. The control-service TLS library still
validates TLS when configured. Production transport expansion is separate work.
Runtime, Controller relay and ACP consumption remain the next #30 owning batches.

- It does not read another service's database.
- It does not hold the Skill maintenance signing key; that belongs to Agent ACP
  Service.

## Interfaces

| Direction   | Interface                                                       | Purpose                                                                                                              |
| ----------- | --------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| Inbound     | Internal JSON-over-HTTP RPC ([control API](api/control-api.md)) | Image resolution, lifecycle commands, Inspect/List, operation queries, observation List/Watch, Skill set preparation |
| Inbound     | Local-loopback `GET /status`                                    | Liveness and readiness (database, journal/notifications, adapter initialization and cached monitor state)            |
| Outbound    | Docker Engine API `v1.47` over a Unix socket                    | Containers, volumes, networks, events, image inspection                                                              |
| Outbound    | Runtime `GET /status`                                           | Bounded verification of Runtime identity and `execution_id`                                                          |
| Outbound    | Authenticated Skill Registry artifact API                       | Download already-frozen exact Skill versions for preparation                                                         |
| Persistence | Private PostgreSQL schema `runtime_controller`                  | Environment heads, operations, generation claims, observation journal, Skill sets and references                     |

The Runtime status reader recognizes the compiled `test_features` array while
retaining strict unknown-field decoding. Deploy this reader before upgrading
Runtime images to the [required-field status contract](../../contracts/runtime/status.md).
It also accepts the previous status shape during rollout. This change does not
alter readiness criteria or reject test-feature images; image admission is enforced by the operator repository/digest policy in #29.

## Configuration

| Variable                                             | Required               | Default                            | Description                                                                                                                          |
| ---------------------------------------------------- | ---------------------- | ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `ANTNEST_RUNTIME_CONTROLLER_DATABASE_URL`            | yes                    | none                               | Controller-private PostgreSQL DSN                                                                                                    |
| `ANTNEST_RUNTIME_MANAGEMENT_NETWORK`                 | yes                    | none                               | Outbound private Docker network shared with Runtimes; the control listener binds a separate Controller network                       |
| `ANTNEST_RUNTIME_CONTROLLER_LISTEN`                  | no                     | `127.0.0.1:8080`                   | Explicit unicast control IP and port; bind the Controller-purpose network in deployment                                              |
| `ANTNEST_RUNTIME_CONTROLLER_HEALTH_LISTEN`           | no                     | `127.0.0.1:8082`                   | Separate loopback-only readiness listener                                                                                            |
| `ANTNEST_RUNTIME_ALLOWED_IMAGES`                     | no                     | `["antnest/antnest-runtime"]`      | Operator JSON array of allowed repositories or exact repository SHA256 manifests; disallowed new selections return 422 before Docker |
| `ANTNEST_RUNTIME_PLATFORM`                           | no                     | `docker`                           | Platform adapter; `docker` is the only accepted value                                                                                |
| `ANTNEST_DOCKER_HOST`                                | no                     | `unix:///var/run/docker.sock`      | Docker Engine URL; only `unix://` is accepted. Access to this socket is full control of the Docker daemon                            |
| `ANTNEST_RUNTIME_CONTROLLER_SCOPE`                   | no                     | management network name            | Ownership scope label written to every managed resource                                                                              |
| `ANTNEST_RUNTIME_SYSTEM_SKILLS_VOLUME`               | no                     | `antnest-system-skills`            | Read-only Skill volume mounted when a request carries no prepared Skill set                                                          |
| `ANTNEST_SKILL_REGISTRY_URL`                         | no                     | none                               | Private Skill Registry origin; requires native service sender credentials when set. Unset disables preparation with 503              |
| `ANTNEST_SERVICE_AUTH_MODE`                          | yes                    | none                               | Exact `token` or `mtls`; shared TLS/receiver/sender configuration applies                                                            |
| `ANTNEST_SERVICE_AUTH_CALLERS_FILE`                  | token mode             | none                               | Startup-loaded per-caller SHA256 JSON; only Controller may use control routes                                                        |
| `ANTNEST_SERVICE_AUTH_TOKEN_DIR`                     | Registry in token mode | none                               | Private per-receiver sender files, read on each request                                                                              |
| `ANTNEST_RUNTIME_SKILL_PREPARER_IMAGE`               | no                     | `antnest/runtime-controller:local` | Installed image used for never-started, network-less Skill volume preparation containers                                             |
| `ANTNEST_RUNTIME_SKILL_MAINTENANCE_VERIFIERS`        | no                     | empty set                          | JSON `{"keys":[...]}` with at most two Ed25519 public keys; empty disables Runtime Skill maintenance                                 |
| `ANTNEST_RUNTIME_STATUS_TIMEOUT`                     | no                     | `5s`                               | Bound for one Runtime `/status` request                                                                                              |
| `ANTNEST_RUNTIME_MUTATION_TIMEOUT`                   | no                     | `2m`                               | Complete mutation bound, including lock wait                                                                                         |
| `ANTNEST_RUNTIME_RPC_TIMEOUT`                        | no                     | `3m`                               | Internal RPC bound; must exceed the mutation timeout                                                                                 |
| `ANTNEST_RUNTIME_RECONCILIATION_TIMEOUT`             | no                     | `2m`                               | Inventory reconciliation bound                                                                                                       |
| `ANTNEST_RUNTIME_CONTROLLER_MONITOR_MAX_RETRY_DELAY` | no                     | `30s`                              | Maximum observation retry delay, including jitter; must be at least `1s`                                                             |
| `ANTNEST_OBSERVATION_RETENTION`                      | no                     | `168h`                             | Observation journal retention                                                                                                        |
| `ANTNEST_RUNTIME_SSE_HEARTBEAT`                      | no                     | `15s`                              | Observation Watch heartbeat interval                                                                                                 |
| `ANTNEST_TELEMETRY_CAPTURE_RPC_CONTENT`              | no                     | `false`                            | `true` or `false`; `true` records complete RPC bodies, including credentials, and is forwarded to new Runtimes                       |

Standard `OTEL_*` variables configure OTLP `http/protobuf` export. Selected
`OTEL_*` keys, optionally overridden by `ANTNEST_RUNTIME_OTEL_*`, are forwarded
to managed Runtimes. See [operations](docs/operations.md) for details.

Transient observation leadership/readiness query and reconciliation failures
retry without ending the process. Failed initial reconciliation releases
leadership before retrying; readiness is announced only after reconciliation
and the Watch handshake succeed. Retries start at `1s`, double to the configured
limit, include up to 20% positive jitter within that limit, and reset after
Watch readiness. Explicit permanent configuration/schema/programming errors
still return to startup supervision. The standard Compose service uses
`restart: unless-stopped` as a fallback for process failures.

Control contract revision 14 adds a required `monitor_ready` field to `/status`.
Monitor retries and Watch reconnection return HTTP 503 with `live: true`; a
ready Watch or ready-leader probe restores HTTP 200. The route reads cached
state and does not call Docker or scan Runtimes. A Watch-only disconnect can
leave lifecycle calls working; a Docker API outage makes actual platform calls
fail. Brief reconnects have a 503 window handled by existing probe failure
thresholds. See [operations](docs/operations.md#observation-dependency-recovery).

## Dependencies

- PostgreSQL: the private `runtime_controller` schema. Startup fails if the
  database is unreachable or carries an unknown future migration.
- Docker Engine: required for lifecycle, Watch, and image resolution. The
  management network and system Skill volume are checked during lifecycle
  calls, not at startup; `/status` never calls Docker.
- Managed Runtime `/status` endpoints on the management network.
- Skill Registry: optional. Without it, Skill set preparation is unavailable,
  but lifecycle commands that do not reference a prepared set still work.
- A prebuilt Antnest Runtime image installed on the Docker host.

## Build and test

All control routes require verified Controller workload identity; RC never calls its own API. The [workload boundary](api/service-authentication.md) specifies exact token/mTLS, JSON, listening addresses, Registry transport and Docker socket limitations. The retired `ANTNEST_SKILL_REGISTRY_API_TOKEN` must be removed; any nonempty value fails startup. Deployment wiring and complete token-profile cross-service E2E passed the final integration batch, recorded in the [rollout ledger](../../contracts/platform/service-authentication-rollout.json).

Service-local checks, from `services/runtime-controller`:

```bash
make fmt-check
make lint
make test
```

`make lint` uses the repository's checked-in `.golangci.yml`.

From the repository root:

```bash
make test-go                           # unit tests with root integration overlays
make test-runtime-controller-postgres  # repository tests against disposable PostgreSQL
node tests/e2e/service-authentication/runtime-controller/run.mjs # isolated native authentication/network/image/lifecycle gate
make e2e-runtime-controller            # builds images and runs the lifecycle E2E
make e2e-runtime-controller-observation-retry # isolated Docker socket outage/recovery
make integration-stage4-skill-prepare  # Registry to Runtime Controller Skill preparation
docker build -f services/runtime-controller/Dockerfile -t antnest/runtime-controller:local .
```

Unit tests live alongside the service packages. PostgreSQL and Docker
integration sources live in
[`tests/integration/go/runtime-controller`](../../tests/integration/go/runtime-controller),
and the deployed lifecycle scenario in
[`tests/e2e/runtime-controller/run.sh`](../../tests/e2e/runtime-controller/run.sh).
The root Go runner overlays those sources into the owning packages so they can
reach package-private details. The lifecycle E2E covers initialization from an
empty environment, Controller restart recovery, Runtime restart observation,
Update, Disable workspace retention, Enable, and Delete cleanup.

The observation retry E2E builds a separately tagged candidate Controller and
uses a private Unix-socket proxy to simulate unavailable Docker at startup and
a later socket outage. It verifies HTTP 200/503/200, readiness leases, zero
process restarts, and successful Runtime Initialize/Delete. It separately
disconnects only Watch and proves a lifecycle call still works while
`monitor_ready` is false, then removes its owned containers, volumes, networks
and candidate image.

Opt-in checks:

- Installed image resolution without creating resources:

  ```bash
  ANTNEST_RUNTIME_CONTROLLER_TEST_DOCKER_SOCKET=/var/run/docker.sock \
  ANTNEST_RUNTIME_CONTROLLER_TEST_IMAGE_TAG=antnest/antnest-runtime:local \
  node tests/integration/go/run.mjs runtime-controller --package internal/platform/docker -- \
    -run '^TestInstalledImageResolution$' -count=1
  ```

- Build metadata smoke against an existing development stack with Jaeger:
  `node tests/e2e/runtime-controller/build-image-smoke.mjs --project <compose-project>`.
- Creation and observation E2E: `make e2e-observation` from the service
  directory (see [creation and observation](docs/creation-and-observation.md)).
- Update process-crash recovery: `make test-crash-recovery` from the service
  directory (see the [crash recovery contract](docs/crash-recovery-contract.md)).

Test-only variables: `ANTNEST_RUNTIME_CONTROLLER_TEST_DATABASE_URL`,
`ANTNEST_RUNTIME_CONTROLLER_TEST_DOCKER_SOCKET`,
`ANTNEST_RUNTIME_CONTROLLER_TEST_IMAGE_TAG`,
`ANTNEST_RUNTIME_CONTROLLER_TEST_MOVED_IMAGE_TAG`,
`ANTNEST_RUNTIME_CONTROLLER_TEST_URL`, `ANTNEST_RUNTIME_TEST_CONFIGURATION`,
`ANTNEST_RUNTIME_TEST_AGENT_ID`, `ANTNEST_RUNTIME_CONTROLLER_CRASH_TEST`,
`ANTNEST_RUNTIME_CONTROLLER_CRASH_IMAGE`, `ANTNEST_RUNTIME_CRASH_EVIDENCE`,
and `ANTNEST_TEST_REAL_RUNTIME_IMAGE`.

## Documentation

- [Architecture](docs/architecture.md) - domain model, lifecycle workflows,
  persistence, observation semantics, Skill delivery, and invariants.
- [Operations](docs/operations.md) - deployment, configuration, readiness,
  health, and failure diagnosis.
- [Creation and observation](docs/creation-and-observation.md) - separation of
  command completion from Runtime readiness.
- [Observability](docs/observability.md) - trace, SQL, and RPC content
  boundaries.
- [Inspect absence contract](docs/inspect-absence-contract.md) - telemetry
  classification of an expected missing container.
- [Crash recovery contract](docs/crash-recovery-contract.md) - opt-in Update
  process-crash component test.
- [Control API](api/control-api.md) and [API directory](api/README.md) - owned
  RPC contract and schemas.
- [Skill Registry Runtime delivery contract](../../contracts/skill-registry/runtime-delivery-api.md)
  - Skill set preparation and lifecycle consumption.
- [Stage 1 Runtime](../../docs/stage-1-runtime.md) - cross-service Runtime
  contract.
- [Skill learning design](../../docs/skill-learning-design.md) - maintenance
  verifier keys and rotation.
- [Service layout](../../docs/service-layout.md) - repository ownership rules.
