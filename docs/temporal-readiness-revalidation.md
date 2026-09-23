# Temporal restart readiness repair

Date: 2026-09-21. Baseline: `866d0aa` plus the uncommitted network and shutdown
migrations. The [shutdown migration](lifecycle-shutdown-revalidation.md) retains
two post-restart Delete failures; the latest captured a 15-second client timeout,
Controller 503 and Temporal membership unavailability despite TCP health.

## Contract and delivery scope

This batch owns Temporal deployment readiness. Controller `/status` retains its
local database contract. No application implementation, SDK version, business
timeout, mutation retry, persistent data or retained deployment changes.

A healthy single-node Temporal container must satisfy both:

- Its local HTTP WorkflowService `GetSystemInfo` succeeds. Temporal 1.31.0's
  [WorkflowHandler startup](https://github.com/temporalio/temporal/blob/v1.31.0/service/frontend/workflow_handler.go)
  enables the health interceptor only after the frontend membership monitor is
  initialized; an open TCP port is insufficient.
- The official `tdbg membership list-gossip` reports a positive member count for
  each of frontend, history and matching. The probe uses live gossip, not stale
  membership database rows, and needs no application namespace or Workflow.

Use the pinned 1.31.0 server image plus the same-version official `tdbg` binary.
Bound each read and the overall Docker healthcheck. Fail closed for command
errors, missing/zero/malformed counts and frontend rejection. Dependency order
then gates existing-container restart as well as initial deployment. Controller
depends directly on Temporal health as well as completed namespace setup, so an
already-exited initializer cannot bypass the current readiness check. Health is
a point-in-time readiness observation, not a guarantee against later outages.

The upstream [membership monitor](https://github.com/temporalio/temporal/blob/v1.31.0/common/membership/ringpop/monitor.go)
can retry bootstrap while frontend listening has already started. The previous
logs establish this readiness gap; the deeper reason for that bootstrap retry
is not yet proven. No membership-table edits or arbitrary sleeps are permitted.

Delivery: first probe unit/contract and image component checks, then explicit
integration through repeated full shutdown profiles and Foundation regression.
Preserve raw errors/warnings and all earlier failed evidence. Compare retained
container identity/image/mounts/health and remove only owned test resources.

## Verification

The shell probe has 14 unit/component fixture cases: successful readiness,
frontend rejection and command failure/zero/absent/malformed member counts for
each required role. Two deployment contract checks cover direct Controller
ordering, retained namespace ordering, bounded probes, unpublished HTTP and the
fixed-version image/build entry points. Both behavior changes were verified red
before implementation and green afterwards.

Candidate image:
`sha256:c2621d785f7a46e39ad148775870407f561e1b6bf4000b89b3af9ca0b2b0c82d`.
The actual image probe succeeds against an existing ready cluster and fails
against an empty network. These are read-only checks; no Workflow is created.

First isolated shutdown run, `antnest-lifecycle-bc81520e`, passes ten normal
stops/same-container restarts, both remote SSE closures, ACP 1001, preserved
Session/Runtime/workspace and event history, zero Runs/model calls, and normal
Delete with exact replay. All six topologies pass; four strict failures retain
two warning traces and seven watch cancellation error spans.

During the second run, `antnest-lifecycle-e18f6274`, a read-only snapshot captures
TCP 7233 accepting connections (exit 0) while the candidate health status remains
`starting`, with five consecutive probe failures. This directly reproduces the
old false-positive condition and shows the new gate rejecting it.

The second run also completes all business assertions, exact Delete replay and
all six topologies, again retaining four strict failures (two warning traces and
seven cancellation error spans). Both full runs complete without mutation
transport failures. The deployment dependency change is included in the second
run. Serial local regression passes 936 of 941 tests; five separately gated ACP
PostgreSQL fault cases skip, with zero failures.

Foundation regression, `antnest-lifecycle-2388a465`, passes all nine lifecycle
operations and sixteen scoped topologies, including two real Tool Runs,
active-Run Rebuild, Controller replacement and exact replay. Eleven strict
failures retain nine warning traces and four expected cancellation/rejection
error spans. No timeout or automatic mutation retry was introduced.

Independent final checks cover all 28 raw traces across the three deployments:
zero missing parent edges. Retained Jaeger missing-parent warning messages, where
present, name parents that exist in the final collected span sets; these messages
and clock warnings remain strict failures. HTTP diagnostics contain no failed
mutation. All three projects have zero owned containers/volumes/networks, no
verification children remain, and all twelve retained development containers
preserve IDs, images, mounts, running state and health.

The readiness candidate passes its scoped business/topology gates. Strict Trace
acceptance remains incomplete. At this batch's conclusion retained deployment
was pending; the later [development synchronization](temporal-development-sync-20260921.md)
deploys this exact image and records normal restart, preserved data and nine
retained topologies. No old acceptance assets were retired.

Private evidence is under `artifacts/verification/temporal-readiness-20260921/`; raw profile evidence stays
under `artifacts/verification/lifecycle-shutdown/<project>/` or
`artifacts/verification/lifecycle-foundation/<project>/`. Original migration failures remain
historical failures, not retroactively passing results.
