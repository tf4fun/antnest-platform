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
| Agent Controller   | Owns Agent lifecycle, immutable configuration/execution revisions, explicit Runtime rebuild, Run admission, and Agent events      | Implemented; integrated acceptance pending |
| Agent ACP Service  | Owns ACP v1/v2 Sessions, Runs, context, model/Tool loop, and per-Run Runtime MCP calls                                            | Implemented for Stage 2                |
| Identity Service   | Owns Organizations, Users, local login, OIDC, SCIM, credentials, and the directory journal                                        | Implemented for Stage 2                |
| Contracts          | Language-neutral Runtime, Egress, Agent Controller, ACP, and Identity contracts                                                   | Evolving with each rewritten component |

The repository layout and ownership rules are defined in
[`docs/service-layout.md`](docs/service-layout.md). The greenfield Stage 1
Runtime/Egress design is canonical in
[`docs/stage-1-runtime.md`](docs/stage-1-runtime.md).

The reviewed Stage 2 Agent lifecycle and ACP target design is defined in
[`docs/stage-2-agent-and-acp.md`](docs/stage-2-agent-and-acp.md). It replaces
older candidate/active Runtime rollout and transparent MCP-switching concepts
for the future Agent Controller and Agent ACP Service.

## Current Integration Status

The Rust Runtime, Runtime Egress, and thin Go Runtime Controller are implemented
and accepted together. Stage 2 adds independently deployable Agent ACP,
Identity, and Agent Controller services. Their contracts and cross-service
implementation now connect Identity-backed Agent creation, lifecycle, Run
admission, ACP execution, Runtime MCP, and Agent events. Full disposable-stack
and Jaeger acceptance remains pending; this is not yet an end-user quick start.

## Repository Commands

```bash
make fmt-check   # Go and Rust formatting
make lint        # Go golangci-lint standard rules, Rust clippy, and Node lint/typecheck
make test        # Unit and integration tests that need no running Compose stack
make docker-build
make compose-up
make e2e-stage1  # Isolated disposable Stage 1 Runtime/Egress acceptance
make e2e-runtime-controller  # Isolated Runtime Controller lifecycle acceptance
make test-postgres  # All persistence suites against one disposable PostgreSQL instance
```

Use the service-local README before changing a component. It states what that
component owns, what it must not own, and which narrower command validates it.

## Test Resource Hygiene

Container-backed verification must run serially and clean up resources created
only for that verification when it finishes or is interrupted. After each run,
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
