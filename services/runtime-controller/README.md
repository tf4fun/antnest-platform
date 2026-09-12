# Runtime Controller

> Status: Docker implementation complete; Kubernetes remains a later adapter.

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
- Verify Runtime `/status` after lifecycle creation, Healthy events, and
  explicit reads of a ready Environment.
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

| Direction         | Interface                                                                                                      |
| ----------------- | -------------------------------------------------------------------------------------------------------------- |
| Inbound           | Internal RPC for image resolution, Runtime Initialize, Update, Disable, Enable, Delete, Inspect, and observation List/Watch |
| Platform outbound | Docker Engine API initially; Kubernetes API in a later adapter                                                 |
| Runtime outbound  | Bounded `GET /status` verification for lifecycle, observation, and ready-state reads                           |
| Persistence       | Private Runtime Environment head, operation, internal generation-claim, and bounded observation-journal schema |

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
containers, volumes, or database records, run from this service directory:

```bash
ANTNEST_RUNTIME_CONTROLLER_TEST_DOCKER_SOCKET=/var/run/docker.sock \
ANTNEST_RUNTIME_CONTROLLER_TEST_IMAGE_TAG=antnest/antnest-runtime:local \
go test ./internal/platform/docker -run '^TestInstalledImageResolution$' -count=1
```

Use the socket path of your Docker context. This opt-in check only inspects the
named image and its resolved immutable ID; it never pulls or builds an image.
Unit and RPC contract tests separately cover invalid tags, missing images,
platform outages, deadlines, response minimization, and trace propagation.

For build metadata integration against an existing development instance with
Jaeger enabled, run from the repository root:

```bash
node services/runtime-controller/scripts/build-image-smoke.mjs --project <compose-project>
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
