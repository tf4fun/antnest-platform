# Deployment diagnostic ports

Run `make test-deployment-ports` for rendered all-profile and overlay-order
checks against the [port contract](../../../../contracts/platform/development-authentication.md#host-ports-and-explicit-diagnostics).
These tests require the Compose CLI, not a running Engine, and never read a
retained `.env` file or deployment credential.

Run `make e2e-deployment-ports` with the selected Node and Docker. The dependency
harness starts only its own fresh PostgreSQL/Temporal project, explicitly loads
`compose.debug.yaml`, assigns loopback host ports and initializes the `antnest`
namespace. The child performs a real PostgreSQL query and Temporal gRPC
`GetSystemInfo`/`DescribeNamespace` through those host ports. All clients close,
and the harness removes and verifies its own containers, networks and volumes
on success, failure or normal interruption.

Evidence is private under `artifacts/verification/issue-32-deployment-ports-*`.
There are no model calls, Provider credentials or retained databases. This
checks publications and dependency tooling, not the full platform's purpose
networks, workload/CCT admission, browser, lifecycle or Skill flows. Those remain
the final integration batch after coordinated deployment passes.
