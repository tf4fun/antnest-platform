# Runtime Controller

> Status: existing Runtime lifecycle Docker adapter complete; Kubernetes remains a later adapter.

Stage 4 B3 system-Skill delivery has passed its local and applicable Docker
gates. A replayed `ready` preparation
fully reads the owned volume's manifest and file contents before returning a
consumable reference. Missing or modified content fails closed. A missing
volume is requeued under a new materialization when no current Runtime or
in-flight lifecycle operation references that set. An active source Runtime
may keep using a different set while an unmounted Rebuild target is prepared
again; its current set remains protected. Confirmed content drift in a
disabled Agent, or in an unmounted target set while a different source Runtime
remains active, enters durable cleanup;
the worker removes the invalid volume and requeues the same frozen set with a
new materialization. Current active sets and in-flight operations remain
fail-closed.
Lifecycle mutation uses a separate, bounded volume ownership preflight
and a post-create manifest gate. The
[preparation/lifecycle contract](../../contracts/skill-registry/runtime-delivery-api.md),
independent frozen-set digest validation, Docker archive transport and observed
mount fields are present. PostgreSQL now durably admits preparation intents,
merges identical collection work, retains operation-owned reference identities
and saves per-package checkpoints. The preparation HTTP routes and a worker are
wired into the service. The worker downloads exact Registry versions, writes
real files to an owned per-Agent volume, reads them back, resumes verified
checkpoints, and writes a collection manifest before marking the set ready.
On graceful shutdown, RC waits for the preparation worker to settle an
interrupted round and release its lease before exiting. The isolated
`make integration-stage4-skill-restart-prepare` gate restarts RC after the
first persisted checkpoint; preparation resumes against the same database,
completes all five delayed packages, and does not download the first one again.
The development Compose service gives this shutdown sequence a 30-second
stop window, covering the bounded HTTP and worker waits before Docker forces
termination.
The final readback scans the whole volume root, verifies file content and
rejects extra entries.
Missing volumes are requeued under a new physical materialization identity.
The Docker adapter verifies the actual mounted volume after container creation
and before startup, including an auto-created empty replacement volume race.
If Docker starts the Runtime but loses its Start response, RC re-inspects the
running candidate and repeats the Skill mount/manifest gate before accepting
completion. A changed mount remains `unknown`; a verified running mount may be
adopted. Unit tests cover both outcomes, and a disposable full-stack Docker
profile confirms legitimate adoption and a subsequent Skill-reading ACP Run.
Lifecycle admission resolves an exact active `ready` reference and inspects
the owned physical volume before the transition, repeats the database check
in the transition transaction, and records a
lifecycle reference with the chosen physical volume. Runtime creation and
recovery consume that recorded volume. Completing an operation atomically
transfers its reference to the current Agent set, keeps it through Disable,
replaces it on successful Update, and releases it on Delete or settled failure;
unknown operations retain their recovery reference. A cleanup worker normally
claims only sets with no preparation, lifecycle, or current Agent reference.
Confirmed drifted sets may retain preparation/current references while their
Agent is disabled and no lifecycle operation is active. An active Agent may
also clean an unmounted target set that has no current or lifecycle reference.
After removing the owned invalid volume, the worker requeues the same frozen
set. Delete
closes new preparation admission and cancels in-flight work in its lifecycle
transaction. The core Registry→Template→Controller→RC→Runtime/ACP Docker
workflow has passed. Controlled legacy shared-volume migration and exact-source
recovery pass isolated Docker gates; independent protected off-host export
acceptance is outside the current clean-development-deployment scope, which
has no legacy business data. The Skill Registry first-release business scope
has passed its local and Docker gates.
The read-only legacy shared-volume inventory endpoint scans the mounted volume
twice without following symlinks, hashes every regular file and reports all
Docker consumers, including stopped and foreign containers. The separate
`POST /internal/legacy-system-skills/backups` copies an explicitly observed
inventory to a restricted persistent volume, reads its archive and manifest
back, and returns an idempotent receipt. This same-host copy still needs a
verified protected export before Controller may finish any Agent migration;
`GET /internal/legacy-system-skills/backups/{backup_ref}` revalidates the
stored archive and manifest without reading Docker or the live shared volume.
None of these endpoints lifts the existing gate.
The separate `legacy-backup-export` maintenance binary copies an RC backup
directory into an operator-mounted private destination, verifies source and
destination archives, and reports `copy_verified`. It does not certify that the
destination is off-host; the migration gate still requires independent protected
export verification.
The `legacy-backup-attest` maintenance binary is intended to run on an
independent verifier, with its own private Ed25519 key and read-only access to
the protected export. It reads the full archive again and emits the signed
[`v1 attestation`](../../contracts/skill-registry/legacy-export-attestation.md).

Do not mount that key in the RC service. The same-host Docker test validates
the command and signature mechanics only. Controller consumes a valid signed
attestation in the explicit migration operation; the gate opens only after a
verified target mount and atomic publication. Independent off-host evidence
remains to be exercised.

The private `POST /internal/runtimes/{agent_id}/skill-sets/verify-active`
endpoint rechecks a still-held prepared reference against the current
Environment revision, running container deployment identity, read-only Skill
mount and manifest. It returns a point-in-time receipt for Controller's
implemented migration publish gate. See the
[verification contract](../../contracts/skill-registry/active-skill-set-verification.md).
An isolated root integration test publishes a fixed Registry version over HTTP,
asks RC to prepare and Initialize it over HTTP, and verifies the owned Docker
volume's labels, manifest, exact `SKILL.md`, idempotent receipt, actual candidate
container mount and write denial. The candidate is a test image, so Controller
Template selection and Antnest Runtime/ACP execution remain separate gates.
With `ANTNEST_TEST_REAL_RUNTIME_IMAGE=antnest/antnest-runtime:local`, the same
isolated test invokes the real Runtime executor against that prepared volume:
`info` discovers only the system Skill summary, `read` retrieves the full file,
and `write` to the system root is rejected. This does not run Runtime's networked
MCP server or an ACP Run.

The B3 artifact path now independently validates Registry ZIPs against the
shared package-rule cases and frozen metadata, streams normalized real files
into a read-only tar layout, and downloads only scoped exact versions through a
non-redirecting authenticated client. A root-owned Docker E2E exercises package
and collection-manifest write/readback on a never-started `NetworkMode=none`
preparation container.

## Dependency baseline (2026-09-26)

Go 1.27.1, pgx 5.11.0, and OpenTelemetry 1.46.0 / log 0.22.0 are
the current dependency baseline. Local admission includes the complete Go
overlay profile with the race detector, build, and lint. Database and installed
image contracts run in the isolated platform regression batch; see the
[dependency refresh record](../../docs/dependency-refresh-20260926.md).

Runtime Controller owns the platform lifecycle of one logical Runtime
Environment per Agent. Agent Controller issues explicit Initialize, Update,
Disable, Enable, and Delete commands. Runtime Controller realizes those
business commands as private Docker or Kubernetes compute and workspace
resources and reports a platform-neutral result.

## Responsibilities

- Idempotently `Initialize`, `Update`, `Disable`, `Enable`, `Inspect`, and
  `Delete` one Agent Runtime Environment.
- Allocate internal immutable compute generations and expose only an opaque
  Runtime revision to callers.
- Map one language-neutral Runtime configuration to deterministic Docker or
  Kubernetes compute and workspace resources.
- Keep deployment-platform credentials and adapters inside this service.
- Resolve an installed repository/tag to an immutable image identity through
  a read-only platform query; do not build or implicitly pull images.
- Consume platform health plus List/Watch events.
- Complete creation after confirmed platform create/start, without waiting for health.
- Verify Runtime `/status` on Healthy observations and explicit reads of a
  provisioned Environment; never rewrite completed commands from later health.
  See [creation and observation](docs/creation-and-observation.md).
- Normalize platform facts into a bounded, ordered Runtime observation journal.
- Create and retain the Agent workspace as part of Runtime lifecycle commands;
  workspace operations are never exposed as a cross-service API.
- Serialize all mutations for one Agent across Controller replicas.
- Elect one platform-Watch consumer and wake observation clients across replicas.
- Permanently bind each internal Runtime generation to one deployment digest.
- Emit structured logs, control-plane traces, and low-cardinality metrics.

## Non-Responsibilities

- It does not decide when an Agent is initialized, updated, disabled, enabled,
  or deleted.
- It does not own Agent desired state, active binding, or execution admission.
- It does not dispatch Runs or proxy MCP Tool calls.
- It does not allocate Tunnel IPs or persist Egress policy.
- It does not run a Runtime reverse-connection server.
- It does not authenticate end users or expose a public API.
- It does not read another service's database.

Docker and Kubernetes adapters are private in-process adapters. There is no
separate Runtime Provider service in the target architecture.

## Target Interfaces And Dependencies

| Direction         | Interface                                                                                                                   |
| ----------------- | --------------------------------------------------------------------------------------------------------------------------- |
| Inbound           | Internal RPC for image resolution, Runtime Initialize, Update, Disable, Enable, Delete, Inspect, and observation List/Watch |
| Platform outbound | Docker Engine API initially; Kubernetes API in a later adapter                                                              |
| Runtime outbound  | Bounded `GET /status` verification for independent observation and provisioned-state reads                                  |
| Persistence       | Private Runtime Environment head, operation, internal generation-claim, and bounded observation-journal schema              |

Runtime Controller never calls Runtime Egress. Agent Controller obtains an
Agent network attachment from Egress and includes it in the immutable Runtime
deployment request.

## Runtime Identity

The cross-service identity is `agent_id` plus an opaque `runtime_revision`.
Callers compare revisions but never allocate or interpret them. Runtime
Controller privately allocates a numeric compute generation whenever Initialize,
Update, or Enable creates a new process environment.

Runtime PID 1 additionally generates a fresh `execution_id` on every process
start. Runtime Controller learns it from `/status` and includes it in
observations, allowing Agent Controller to distinguish a process restart from a
temporary health change.

`execution_id` is a consistency identity, not a credential.

## Current Implementation

The Go service contains one in-process Docker Engine adapter, a private
PostgreSQL lifecycle/operation/observation repository, Runtime `/status`
verification, platform List/Watch recovery, and the internal JSON RPC adapter.
It has no Work lease, reverse Runtime session, MCP proxy, Egress client, or
separate Docker Provider process.

Runtime containers and workspaces use deterministic private names and labels.
Every resource also carries a stable Controller ownership scope, preventing
independent Controller databases on one Docker daemon from consuming each
other's inventory.
The trusted root
Supervisor prepares TUN and the resolver; Agent-selected operations always run
as UID/GID 1000 with an empty capability set. A persistent Agent workspace and
generation-scoped compute remain separate platform resources, but only Runtime
Controller can manipulate them. Disable removes compute and retains the
workspace; Delete removes both.
The generation digest covers the effective Docker mapping, including
Controller-injected network, mount, privilege, healthcheck, restart, and
Runtime telemetry settings.

## Local Start

From the service directory, unit and contract tests are self-contained:

```bash
make test
make fmt-check
```

From the platform repository root:

```bash
docker build -f runtimes/antnest-runtime/Dockerfile -t antnest/antnest-runtime:local .
docker compose build runtime-controller
docker compose up -d --wait postgres runtime-controller
curl --fail http://127.0.0.1:58080/status
```

Startup serializes ordered, immutable, transactional migrations through a
journal inside the Controller's private PostgreSQL schema. A binary refuses a
database carrying unknown future migrations. Docker mode requires the
configured management network and system-Skill volume to exist; Compose
creates both. The service owns its
internal RPC contract in [`api/control-api.md`](api/control-api.md) and its
machine-readable route/error catalog in
[`api/control-contract.json`](api/control-contract.json).

Run service-local checks from this directory:

```bash
make fmt-check
make lint
make test
```

The lint command uses the platform repository's checked-in `.golangci.yml`
with the `standard` linter set; it never inherits configuration from a parent
checkout.

Run integration evidence serially from the platform repository root:

```bash
make test-go
make test-runtime-controller-postgres
make e2e-runtime-controller
```

Unit tests remain alongside the service packages. PostgreSQL and Docker
integration sources live in
[`tests/integration/go/runtime-controller`](../../tests/integration/go/runtime-controller),
and the deployed lifecycle scenario lives in
[`tests/e2e/runtime-controller/run.sh`](../../tests/e2e/runtime-controller/run.sh).
The root Go runner overlays those sources into their owning service packages so
they retain access to package-private implementation details.

The PostgreSQL and Docker targets require a local Docker Engine and use
disposable test databases/projects. The E2E proves initialization from an
empty environment, Controller-process restart recovery, status identity,
same-generation Runtime process restart observation, update replacement,
Disable workspace retention, Enable recreation, and Delete cleanup. It also
proves image reference preservation and execution fencing. Each build resolves
the configured tag and persists its image ID before creating a container; recovery
uses that same ID. A new build resolves the tag again, without changing Template
configuration. Containers receive both values as startup diagnostic metadata;
operation records retain them after deletion. No automatic pull/update is added.

To verify image resolution against an installed local image without creating
containers, volumes, or database records, run from the repository root:

```bash
ANTNEST_RUNTIME_CONTROLLER_TEST_DOCKER_SOCKET=/var/run/docker.sock \
ANTNEST_RUNTIME_CONTROLLER_TEST_IMAGE_TAG=antnest/antnest-runtime:local \
node tests/integration/go/run.mjs runtime-controller --package internal/platform/docker -- \
  -run '^TestInstalledImageResolution$' -count=1
```

Use the socket path of your Docker context. This opt-in check only inspects the
named image and its resolved immutable ID; it never pulls or builds an image.
Unit and RPC contract tests separately cover invalid tags, missing images,
platform outages, deadlines, response minimization, and trace propagation.

For build metadata integration against an existing development instance with
Jaeger enabled, run from the repository root:

```bash
node tests/e2e/runtime-controller/build-image-smoke.mjs --project <compose-project>
```

This uses the instance's existing PostgreSQL and installed Runtime image. It
creates a synthetic Runtime (not an Agent), verifies operation persistence,
Docker image/metadata, startup logs, exact replay, and the Runtime trace resource,
then deletes its container/workspace and releases its Egress allocation. The
operation audit records deliberately remain to verify post-deletion retention.
No Provider or external model is called. `--image` and `--jaeger` override defaults.

## Maintainer Guide

- [`docs/observability.md`](docs/observability.md): safe boundary diagnostics,
  deployment mode propagation, and verification limits.
- [`docs/architecture.md`](docs/architecture.md): implemented model, workflows,
  persistence, observation semantics, and invariants.
- [`docs/operations.md`](docs/operations.md): deployment, readiness,
  configuration, and failure diagnosis.
- [`api/control-api.md`](api/control-api.md): owned RPC and recovery contract.
- [`../../docs/stage-1-runtime.md`](../../docs/stage-1-runtime.md): canonical
  cross-service Stage 1 contract and acceptance.
- [`../../docs/service-layout.md`](../../docs/service-layout.md): repository
  ownership and dependency rules.

### Opt-in reconstruction crash component

The [root crash-recovery suite](../../tests/e2e/go/runtime-controller/internal/control/crash_recovery_component_test.go)
runs four real process exit boundaries using the production control service,
PostgreSQL adapters and Docker driver. Run it from the repository root:

```bash
ANTNEST_RUNTIME_CONTROLLER_CRASH_TEST=true \
node tests/integration/go/run.mjs runtime-controller --profile e2e --package internal/control -- \
  -run '^TestRuntimeUpdateProcessCrashRecovery$' -count=1 -v -timeout=6m
```

See [the contract](docs/crash-recovery-contract.md). It creates its
own PostgreSQL, internal network, UDP fixture peer, Skills volume and Runtime
resources; existing development databases and images are not changed.

Requires the installed `postgres:17-bookworm`, `node:24-bookworm-slim` and
`antnest/antnest-runtime:local` images, a local Unix Docker context and `/dev/net/tun`
in Docker. `ANTNEST_RUNTIME_CONTROLLER_CRASH_IMAGE` may select a different installed
Runtime image. Optional `ANTNEST_RUNTIME_CRASH_EVIDENCE` names an existing private
directory for scoped result summaries and Runtime diagnostics on failure.
The fixture is compiled for Unix hosts. Evidence, `TMPDIR`, child job inputs and
effect journals must stay outside `.cache`; parent-path traversal and dangling
aliases are rejected before database or Docker actions. Output leaves must be
ordinary files, are checked again when opened, and are written with mode 600.
Effect journals keep append-and-sync semantics. The storage contract checks run
with `-run '^TestCrashStorage(ParentEntry|ChildEntry|PhysicalEffects|DiagnosticEntry|Paths|Files)$'`
through the same root runner without enabling the real Docker crash suite.

This explicitly opted-in abnormal-exit component is separate from routine
normal-restart acceptance. It proves service recovery, not public Controller
Rebuild, Temporal retries or execution publication; those need the integration
batch after the Runtime-owned gates. No forced-kill span completeness is claimed.
