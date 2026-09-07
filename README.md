# Antnest Platform

Antnest Platform is the Docker-first service architecture for Antnest. This
repository is organized around independently understandable services rather
than around one shared application package.

## Service Map

| Component          | Target role                                                                                                                       | Status                                 |
| ------------------ | --------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------- |
| Antnest Runtime    | Executes one Agent's process and filesystem operations and transports Agent packets                                               | Implemented and aligned with Egress    |
| Runtime Egress     | Rust service owning Agent addresses, network policy, UDP/TUN forwarding, rejection, and address reuse                             | Implemented and accepted with Runtime  |
| Runtime Controller | Logical Runtime Environment lifecycle, private deployment realization, and platform observation with an in-process Docker adapter | Implemented and accepted for Docker    |
| Agent Controller   | Owns Agent lifecycle, immutable configuration/execution revisions, explicit Runtime rebuild, Run admission, and Agent events      | Implemented and accepted in Stage 3A   |
| Agent ACP Service  | Owns ACP v1/v2 Sessions, Runs, context, model/Tool loop, and per-Run Runtime MCP calls                                            | Stage 3 integrated; protocol closeout open |
| Identity Service   | Owns Organizations, Users, local login, OIDC, SCIM, credentials, and the directory journal                                        | Stage 3 integrated; event delivery not implemented |
| Edge Gateway       | Sole browser ingress, Identity-backed sessions, administrator/Agent admission, trusted routing, and trace propagation              | Implemented for Stage 3                |
| Admin Console      | React administrator application and thin BFF for Identity and Agent lifecycle management                                           | Implemented for Stage 3A               |
| Agent UI           | React end-user conversation workspace for Agents, ACP Sessions, tool activity, and attachments                                    | Implemented through Edge and ACP v1    |
| Contracts          | Language-neutral Runtime, Egress, Agent Controller, ACP, and Identity contracts                                                   | Evolving with each rewritten component |

The repository layout and ownership rules are defined in
[`docs/service-layout.md`](docs/service-layout.md). The greenfield Stage 1
Runtime/Egress design is canonical in
[`docs/stage-1-runtime.md`](docs/stage-1-runtime.md).

The reviewed Stage 2 Agent lifecycle and ACP target design is defined in
[`docs/stage-2-agent-and-acp.md`](docs/stage-2-agent-and-acp.md). It replaces
older candidate/active Runtime rollout and transparent MCP-switching concepts
in Agent Controller and Agent ACP Service.

The Stage 3A administrator control-plane contract and its browser-to-Jaeger
acceptance path are defined in
[`docs/stage-3-admin-control-plane.md`](docs/stage-3-admin-control-plane.md).
The shared browser product language is defined in
[`docs/design-language.md`](docs/design-language.md).
The target ownership and restoration status of browser workflows are tracked
in [`docs/product-surfaces.md`](docs/product-surfaces.md).

The implemented entry-to-storage call chains, data exchanges, commit points,
and architecture simplification findings are maintained in
[`docs/business-sequences.md`](docs/business-sequences.md).

The active closeout scope and ordered acceptance checklist are maintained in
[`docs/docker-single-node-closeout.md`](docs/docker-single-node-closeout.md).
ACP and identity come first; Docker identity, Agent management, and Agent UI
must close with Gateway-rooted Jaeger evidence before broader expansion.
Skill Registry and Channel Gateway are not started. Scheduler and Kubernetes
remain planning-only; horizontal scaling and HA are deferred.

Runtime-owned stdio MCP and per-Run context construction are described in
[`docs/runtime-context-and-managed-mcp.md`](docs/runtime-context-and-managed-mcp.md).
The reproducible Docker acceptance profile is documented in
[`scripts/managed-mcp/README.md`](scripts/managed-mcp/README.md).

## Current Integration Status

The Rust Runtime, Runtime Egress, and thin Go Runtime Controller are implemented
and accepted together. Stage 2 adds independently deployable Agent ACP,
Identity, and Agent Controller services. Stage 3A now connects an administrator
browser session through Edge Gateway, Identity, Admin Console, Agent UI, Agent
ACP Service, Agent Controller, and Runtime Controller. The disposable
acceptance covers Model Profile,
Template, and Agent creation plus disable, enable, rebuild, delete, lifecycle
events, end-user ACP Session/Tool execution, port isolation, and Jaeger trace
continuity.

This is scenario-specific acceptance, not a fully conformant ACP claim or a
complete Identity event-driven workflow. Runtime-managed stdio MCP does not
implement client-injected ACP stdio. Full-platform interruption recovery,
cross-identity isolation, Identity linkage, and operational acceptance remain
tracked in the single-node closeout above.

## Stage 3 Local Applications

Build and start the production-shaped administrator stack:

```bash
make docker-build-stage3
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

```bash
make fmt-check   # Go and Rust formatting
make lint        # Go golangci-lint standard rules, Rust clippy, and Node lint/typecheck
make test        # Unit and integration tests that need no running Compose stack
make docker-build
make compose-up
make e2e-stage1  # Isolated disposable Stage 1 Runtime/Egress acceptance
make e2e-runtime-controller  # Isolated Runtime Controller lifecycle acceptance
make e2e-stage3  # Empty Stage 3 stack, lifecycle, Agent workspace ACP, port, and Jaeger acceptance
make test-postgres  # All persistence suites against one disposable PostgreSQL instance
```

Use the service-local README before changing a component. It states what that
component owns, what it must not own, and which narrower command validates it.

## Test Resource Hygiene

Container-backed verification must run serially and clean up resources created
only for that verification when it finishes or is interrupted. The only
exception is the explicit `ANTNEST_E2E_KEEP_STACK=true` local browser-acceptance
mode; it prints the retained project identity and transfers cleanup to the
operator. After each run,
check for residual test containers and stop or remove the ones that are no
longer needed; remove volumes only when they belong to a disposable test
project. Repository E2E scripts must keep cleanup traps for both success and
failure paths.

Development and test Compose reuse one physical PostgreSQL server to reduce
resource use. Every service still owns a separate database, login role,
migration journal, and DSN; sharing the test server does not permit cross-service
table access. Production may place those logical databases on separate servers
without changing service code.

Periodic CPU spikes have been observed in otherwise idle containers after test
runs. The root cause is not yet established. Until it is diagnosed, treat
post-test container inspection and cleanup as part of verification rather than
leaving an idle test stack running indefinitely.
