# Stage 3 Base Acceptance Revalidation

Recorded: 2026-09-17 (Asia/Shanghai), candidate `fd0867c` plus the acceptance
migration worktree. This batch changes fixtures and documentation only.
All base business scenarios, **five lifecycle and 29 ACP request trace
topology/privacy checks**, and **55 local tests** passed. Strict Trace remains
failed on 17 warning traces and four Docker absence-probe ERROR spans (the
probe spans occur within three of those warning traces). Driver and Make exit
2 are preserved; this is not full strict deployment acceptance.

## Current contract and scenario mapping

The default `e2e-stage3a.sh` path now uses the
[base fixture](../scripts/stage3-base/README.md). `make e2e-stage3-local` uses
existing images; `make e2e-stage3` builds first. The fixture starts with empty
volumes and exercises management through Gateway using synthetic credentials.

| Historical assumption | Current replacement and evidence |
| --- | --- |
| Model owns `api_key` and endpoint | Create a Provider, then Models referencing its stable ID; rotate the Provider's credential separately; the deterministic Provider requires the original key for the first Run and the rotated key for all later Runs |
| Copy Model reads into writes | Write only Model parameters; reads include a projected `base_url` that the write contract rejects |
| Model revision creates another API model identity or history resource | Edit the current Model with its returned `expected_version`, preserve its API name, reject a stale version and read the new current version |
| Template references Model revision ID | Reference stable `model_profile_id`; preserve historical Template revision and the Agent's original build snapshot until explicit Rebuild |
| Template publication resolves installed images | Reject malformed image syntax without publishing; preserve a valid missing tag on an unexecuted secondary Template; the executing Template uses the configured immutable default image |
| Workspace bootstrap reports execution availability | Check management facts in bootstrap and current authorization/readiness/configuration fingerprint in ACP's public state endpoint |
| Unversioned v1-only workspace smoke | Official SDK v1 WebSocket, v2 WebSocket and v1 HTTP; exact Tool results, transcript recovery, empty resume and independent request traces |
| Captured Runtime response bodies prove lifecycle completion | With content capture disabled, read each authoritative Runtime operation and current logical inspection; match Agent, deterministic child request, kind, effect and target revision |
| Lifecycle drain uses removed Run admission contracts | Trace current execution snapshot publication and acknowledged Agent settlement under the owning drain activity, before Runtime mutation; compare Controller CLIENT acknowledgement with ACP SERVER metadata |

Password rotation/re-login, directory membership/global activation, SCIM
issue/use/list/revoke (including a rejected revoked token), Provider/Model/Template
idempotent creation, two-page Model/Template inventories, organization-scoped
Agent reads, ready events and SSE remain covered. Delete must hide the Agent
from the current list, retain its explicit audit projection, and reclaim its
Runtime container and workspace volume before stack teardown.

Four real Bash Runs make eight Provider requests. The first runs with the
original Model parameters and credential; later Runs require the edited token
limit and rotated credential. The final Run reads all four exact file markers
after Disable, Enable and Rebuild. Existing Session text and Tool results replay
unchanged after Rebuild, without another Provider request. Both WebSocket versions
reject a prompt sent after authoritative logout, close with code 1008, and
recover the same empty Session after a fresh login.

## Verification record

The final fixture/unit/contract/component gate has **55 passing tests**, including
the local HTTP model component, malformed-image and read/write DTO regressions,
settlement metadata, negative trace mutations, Docker exposure, existing cleanup,
SDK request observation and collector regressions. Verification ran serially.

The final project was `antnest-stage3-e2e-88660`. Its 11 Compose services passed
deployment checks: only Gateway exposes an application host port; PostgreSQL
and Jaeger diagnostics bind loopback; Temporal and internal application services
have no host ports. Five completed Runtime operations have distinct target
revisions and match their owning lifecycle child IDs.

| Lifecycle | Temporal activities with committed driver writes | Warning entries | Docker probe ERROR spans |
| --- | ---: | ---: | ---: |
| Create | 4 | 18 | 2 |
| Disable | 5 | 18 | 0 |
| Enable | 5 | 9 | 1 |
| Rebuild | 6 | 27 | 1 |
| Delete | 6 | 27 | 0 |

All 29 Session traces have distinct request identities: four ordinary Tool Runs
and 25 setup/list/replay/resume requests. Provider HTTP CLIENT span IDs correlate
the eight actual model requests to those four Runs; non-execution traces have
no Run, model or Runtime execution. Replay and logout recovery do not call the
Provider. Logout denial is verified on the wire and through durable empty
recovery; its discarded prompt/connection is not counted as an ACP request trace.

The 17 warning traces comprise all five lifecycles and 12 Session requests,
with 1,782 warning entries. Jaeger's calculated deltas range from +13.141 to
+826.952 microseconds and from -235.552 to -651.814 microseconds. These are
diagnostic adjustments, not proof of physical host-clock offsets. Docker's four
GET 404 ERROR spans are separately retained as strict failures despite the
subsequent successful allocations and starts. No unexpected service error was
waived to obtain topology results.

Seven disposable projects (`85239`, `85596`, `86083`, `86602`, `87023`, `87867`,
`88660`, each prefixed `antnest-stage3-e2e-`) were cleaned after the regression
iterations. The final audit found zero owned containers, volumes, networks or
verification child processes. All 12 retained development containers have the
same IDs, images and health state and remain running. Shell syntax, Compose
configuration and `git diff --check` passed. No production image was rebuilt.

Local evidence is in `.cache/legacy-acceptance-20260917/`:
`base-gates-final.log`, `base-docker-7.log`, `base-result.json`,
`base-summary.json`, `base-compose-check.log` and `base-cleanup.json`.
The README documents the separate private raw lifecycle diagnostics directory.

## Scope and remaining work

The historical retained-stack, Identity-only/OIDC, Managed MCP and fault branches
remain consumers of the old base helpers. They were not retired or counted as
current acceptance. The new default verifies Workspace HTML/bootstrap and SDK
protocol behavior; separate browser evidence remains in the C4 reports.
Missing-image failure at Runtime creation belongs to the later lifecycle fault
batch. The old “missing image rejects Template publication” assertion is retired
because that responsibility moved; malformed-reference rejection is retained.

Clock warnings and low-level Docker probe ERROR spans remain strict failures.
The fixture does not change service telemetry, force clock synchronization or
waive unrelated errors. Only a Docker GET 404 under a completed, matching Runtime
allocation with subsequent successful allocation and verification/start may
continue through topology diagnosis, and it still makes `strict_trace=failed`.
Strict observability acceptance therefore remains separate from successful
business/topology evidence. The next asset batch is Managed MCP lifecycle.
