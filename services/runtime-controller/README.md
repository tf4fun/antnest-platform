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

| Direction | Interface |
| --- | --- |
| Inbound | Internal RPC for Runtime Initialize, Update, Disable, Enable, Delete, Inspect, and observation List/Watch |
| Platform outbound | Docker Engine API initially; Kubernetes API in a later adapter |
| Runtime outbound | Bounded `GET /status` verification for lifecycle, observation, and ready-state reads |
| Persistence | Private Runtime Environment head, operation, internal generation-claim, and bounded observation-journal schema |

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
docker compose up -d --wait runtime-controller-postgres runtime-controller
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
proves immutable image input and execution fencing.

## Maintainer Guide

- [`docs/architecture.md`](docs/architecture.md): implemented model, workflows,
  persistence, observation semantics, and invariants.
- [`docs/operations.md`](docs/operations.md): deployment, readiness,
  configuration, and failure diagnosis.
- [`api/control-api.md`](api/control-api.md): owned RPC and recovery contract.
- [`../../docs/stage-1-runtime.md`](../../docs/stage-1-runtime.md): canonical
  cross-service Stage 1 contract and acceptance.
- [`../../docs/service-layout.md`](../../docs/service-layout.md): repository
  ownership and dependency rules.
