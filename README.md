# Antnest Platform

Antnest Platform is the Docker-first service architecture for Antnest. This
repository is organized around independently understandable services rather
than around one shared application package.

The [current implementation and acceptance index](docs/current-status.md)
distinguishes the latest service boundaries, recorded verification and remaining
scope. Updated 2026-09-23; historical stage reports retain their original scope.
The [Stage 3 current-service closeout](docs/stage-3-current-services-closeout.md)
records the reviewed clock-warning exception and keeps deferred browser checks
explicit. Planned new services belong to Stage 4.

[Test ownership and commands](tests/README.md) define the repository test layout:
unit tests stay within their service, integration tests live in
`tests/integration/`, deployed acceptance tests in `tests/e2e/`, and shared
verification tools in `tests/support/`.

## Service Map

| Component          | Target role                                                                                                                       | Status                                 |
| ------------------ | --------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------- |
| Antnest Runtime    | Executes one Agent's process and filesystem operations and transports Agent packets                                               | Implemented and aligned with Egress    |
| Runtime Egress     | Rust service owning Agent addresses, network policy, UDP/TUN forwarding, rejection, and address reuse                             | Implemented and accepted with Runtime  |
| Runtime Controller | Logical Runtime Environment lifecycle, private deployment realization, and platform observation with an in-process Docker adapter | Implemented and accepted for Docker    |
| Agent Controller   | Owns Agent lifecycle, configuration, Provider credentials, execution publication, Runtime rebuild, and management events | Execution-boundary integration accepted within B5 scope |
| Agent ACP Service  | Owns local admission, ACP v1/v2 Sessions, Runs, model/Tool execution, Runtime MCP calls, and execution audit | Declared profile and scoped Docker integration accepted |
| Identity Service   | Owns Organizations, Users, local login, OIDC, SCIM, credentials, and the directory journal                                        | Identity and owner-offboarding profile accepted |
| Edge Gateway       | Sole browser ingress, Identity-backed sessions, administrator/Agent admission, trusted routing, and trace propagation              | Implemented for Stage 3                |
| Admin Console      | React administrator application and thin BFF for Identity and Agent lifecycle management                                           | Implemented for Stage 3A               |
| Agent UI           | React end-user conversation workspace for Agents, ACP Sessions, tool activity, attachments, and model settings | Implemented; targeted real-browser checks passed; full strict profile remains open |
| Contracts          | Language-neutral Runtime, Egress, Agent Controller, ACP, and Identity contracts                                                   | Evolving with each rewritten component |

The repository layout and ownership rules are defined in
[`docs/service-layout.md`](docs/service-layout.md). The greenfield Stage 1
Runtime/Egress design is canonical in
[`docs/stage-1-runtime.md`](docs/stage-1-runtime.md).

The earlier Stage 2 baseline is retained in
[`docs/stage-2-agent-and-acp.md`](docs/stage-2-agent-and-acp.md).
The implemented execution boundary and its staged acceptance are documented in
[`docs/controller-acp-execution-boundary-plan.md`](docs/controller-acp-execution-boundary-plan.md):
Controller publishes Agent execution policy and configuration; ACP owns local
admission, Sessions and execution audit behind Gateway. Controller Run admission,
credential callbacks and finish receipts have been removed.

The Stage 3A administrator control-plane contract and its browser-to-Jaeger
acceptance path are defined in
[`docs/stage-3-admin-control-plane.md`](docs/stage-3-admin-control-plane.md).
The shared browser product language is defined in
[`docs/design-language.md`](docs/design-language.md).
The target ownership and restoration status of browser workflows are tracked
in [`docs/product-surfaces.md`](docs/product-surfaces.md).

Start with the [business-flow entrypoint index](docs/business-flow-entrypoints.md)
for the current user, protocol, background and operational flow inventory.
Earlier entry-to-storage sequences and architecture findings are retained in
[`docs/business-sequences.md`](docs/business-sequences.md).
Its current-flow links identify the contracts that supersede retired paths.

The cross-service [observability contract](docs/observability-contract.md)
defines span boundaries, optional RPC content capture, stream non-capture,
database tracing and local-only readiness. Implementation evidence is tracked in
the [RPC capture record](docs/observability-simplification.md),
[database rollout](docs/observability-database-remediation.md) and
[ACP database report](services/agent-acp-service/docs/observability.md).
The earlier [service-owned rollout](docs/observability-rollout.md) is historical.
The [clock-skew maintenance decision](docs/controller-acp-execution-boundary-plan.md#obs-acp-clock)
defers dedicated timing work for inspected, recorded warnings while retaining
strict Trace failures and separate business/structure results; it does not waive
new unexplained warnings or other verification failures.

The agreed closeout scope and ordered acceptance checklist are maintained in
[`docs/docker-single-node-closeout.md`](docs/docker-single-node-closeout.md).
The Docker single-node closeout is accepted as of 2026-09-11: 25 items pass,
with five Agent Web UI client checks explicitly deferred, not passed. Identity,
Agent management and server-side ACP/Runtime usage have Gateway-rooted evidence
in the [verification report](docs/docker-single-node-verification-report.md).
Admin Console recovery and live Jaeger navigation are included; this is not a
claim of universal ACP conformance or completed Agent Web UI acceptance.
Skill Registry and Channel Gateway are not started. Scheduler and Kubernetes
remain planning-only; horizontal scaling and HA are deferred.

Runtime-owned stdio MCP and per-Run context construction are described in
[`docs/runtime-context-and-managed-mcp.md`](docs/runtime-context-and-managed-mcp.md).
The reproducible Docker acceptance profile is documented in
[`tests/e2e/managed-mcp/README.md`](tests/e2e/managed-mcp/README.md).

## Current Integration Status

Runtime, Egress and Runtime Controller have scoped Docker acceptance. Identity,
Gateway and Console support browser login, directory/provisioning and Agent
lifecycle management. The 2026-09-15 Controller/ACP integration passed nine
business scenarios, including credential rotation, Controller outage, active-Run
rebuild, disable/enable, crash interruption without replay, revocation and retained
audit after deletion/restart. Trace structure checks passed; strict clock-warning
failures remain recorded under the maintenance decision above.

Agent UI now provides a Session-first workspace. Targeted real-browser model
selection and Provider fallback checks passed on 2026-09-15; model discovery
checks passed on 2026-09-16. Console owns builtin/remote model discovery, Controller
persists selected models, and ACP owns effective model selection. See
[ordered fallback](docs/provider-failover.md) and [model discovery](docs/model-discovery.md).

This is scenario-specific acceptance, not unrestricted ACP conformance or a
generic Identity event bus. ACP stable v1 and draft v2 are accepted for the
declared platform-owned MCP profile; client-injected MCP remains explicitly
rejected. Identity's narrow principal-revocation feed now drives Agent
offboarding. The 2026-09-11 checklist closed its in-scope operations/regression
items and deferred five C4 client checks. Later targeted browser results do not
retroactively close those checks or make the full development-browser Trace
profile pass. Exact dates, evidence and limits are in the
[current status index](docs/current-status.md).

## Stage 3 Local Applications

Follow the [single-node runbook](docs/docker-single-node-operations.md) for
configuration, secrets, image ownership, readiness, diagnosis and cleanup.
The commands below are a short local-development entry, not production setup.

Build and start the production-shaped administrator stack:

```bash
COMPOSE_PARALLEL_LIMIT=1 make -j1 docker-build-stage3
ANTNEST_ADMIN_DEFAULT_RUNTIME_IMAGE_REF=antnest/antnest-runtime:local \
  docker compose -f compose.yaml -f compose.stage3.yaml \
  --profile stage3 --profile observability up -d --wait
```

Open `http://127.0.0.1:8090` for Admin Console or
`http://127.0.0.1:8090/workspace/` for Agent UI. Development defaults are organization
`engineering`, email `admin@example.com`, and password `antnest-admin-dev`.
Override the corresponding `ANTNEST_BOOTSTRAP_*` variables outside disposable
local environments. Jaeger is available at `http://127.0.0.1:16686` when the
observability profile is enabled. Only Edge Gateway exposes an application
port in this topology.

## Repository Commands

Install the ACP service's locked Node dependencies before host-side checks or
Stage 3 E2E scripts: `npm --prefix services/agent-acp-service ci`. The E2E
network selector reuses its `ipaddr.js` parser to avoid existing Docker subnets.

```bash
make fmt-check   # Go, Rust, TypeScript and test-fixture formatting
make lint        # Go golangci-lint standard rules, Rust clippy, and Node lint/typecheck
make test        # Unit and integration tests that need no running Compose stack
make docker-build
make compose-up
make e2e-stage1  # Isolated disposable Stage 1 Runtime/Egress acceptance
make e2e-runtime-controller  # Isolated Runtime Controller lifecycle acceptance
make e2e-stage3  # Empty Stage 3 stack, lifecycle, Agent workspace ACP, port, and Jaeger acceptance
make e2e-lifecycle-network  # Real Runtime TUN policy/revocation/isolation and Gateway-rooted traces
make e2e-workspace  # Scoped state, ACP reconnect/cancel/rebuild/revocation and Jaeger; not browser acceptance
make test-postgres  # All persistence suites against one disposable PostgreSQL instance
```

Use the service-local README before changing a component. It states what that
component owns, what it must not own, and which narrower command validates it.

## Test Resource Hygiene

Container-backed verification must run serially and clean up resources created
only for that verification when it finishes or is interrupted.
`ANTNEST_E2E_KEEP_STACK=true` is [retired](docs/retained-seed-retirement.md): the
launcher rejects it before resource discovery or creation. Unset or `false`
keeps the disposable path; existing development environments are unaffected.
Use the disposable [current browser profiles](tests/e2e/workspace-closeout/README.md)
for acceptance. After each run,
check for residual test containers and stop or remove the ones that are no
longer needed; remove volumes only when they belong to a disposable test
project. Repository E2E scripts must keep cleanup traps for both success and
failure paths.

Development and test Compose reuse one physical PostgreSQL server to reduce
resource use. Every service still owns a separate database, login role,
migration journal, and DSN; sharing the test server does not permit cross-service
table access. Production may place those logical databases on separate servers
without changing service code.

The [offline backup/restore runbook](docs/docker-backup-restore.md) covers the
five service databases, application encryption keys and persistent Runtime
volumes. Its disposable `restore` profile verifies actual storage replacement;
it does not promise an atomic online snapshot or recovery of running processes.

Periodic CPU spikes have been observed in otherwise idle containers after test
runs. The [bounded CPU investigation](docs/docker-single-node-closeout.md#c5-idle-cpu-and-runtime-health-batch-2026-09-10)
identified frequent health probes as a measurable contributor; it did not
reproduce sustained 100% service CPU. New Runtimes probe every two seconds during
startup and every ten seconds in steady state. Existing Runtimes receive this
setting on explicit recreation. Post-test inspection and cleanup remain required;
do not leave disposable test stacks running indefinitely.
