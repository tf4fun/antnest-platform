# Runtime Creation And Agent Availability

## Service Contract

Runtime Controller creation commands now finish after platform create/start and
persistence. Their result is `completed` / `provisioned`, not a ready execution
identity. Agent Controller saves that target and completes its lifecycle
operation. It does not move the removed readiness wait into Temporal.

There are two independent facts:

1. Configured Agent: immutable AgentSpec plus the current Runtime revision.
   Create/rebuild/enable publish this pair, clear the active lifecycle operation,
   and establish `created/enabled`, Runtime `unknown`, with no executable revision or endpoint.
2. Available Agent: a current, matching healthy Runtime observation supplies
   execution identity and MCP endpoint. Only then is an immutable execution
   revision appended and the Agent projected `available`.

The existing `executable_spec_revision_id` database column retains the configured
spec while disabled or awaiting readiness; it alone has never been a Run grant.
Executable configuration publication requires enabled/available, no active lifecycle
operation, valid owner binding/authorization and a complete executable binding.
ACP decides local Run admission from that synchronized configuration. Historical execution
revisions remain immutable and never substitute for a pending target.

## Lifecycle And Observation

Create, rebuild and enable keep their existing platform/network phases. Publish
commits the configured target, clears old executable fields, preserves historical
execution records, and emits `agent_created`, `agent_rebuilt` or `agent_enabled`.
No execution revision is inserted by these commands. `agent_ready` is emitted by
independent observation only. An unhealthy Runtime never rewrites a completed
creation into a failed operation.

The existing observation worker drains the Runtime journal and reconciles pending
bindings against fresh Inspect results. It scans only configured pending Agents,
with pagination; it does not inspect every Agent on every Run. Early/missed healthy
events and worker restart therefore converge without an additional queue, table,
workflow or dependence on one event arriving at the right time.

Publication compares the current Agent revision, aggregate sequence, desired
state and active operation under the database lock and rechecks the identity
watermark. A stale observation cannot overwrite a rebuild, disable, deletion or
owner revocation. Repeated publication is a no-op; execution IDs are never
fabricated before observation. Delayed Runtime loss/restart events are checked
against current Runtime state so they cannot invalidate a freshly observed
matching execution. Consuming a restart/loss observation also advances the pending
Agent aggregate, fencing an Inspect that started before the process change.
Bootstrap or cursor reset fences all pending bindings in the same transaction,
even when the replacement inventory is empty or not yet healthy; the next fresh
Inspect supplies the executable binding.
Unexpected loss of an already published execution still
requires explicit lifecycle recovery, not automatic reactivation.

Disable/rebuild/delete operate on configured Runtime resources, not on proof of
a prior successful Run. A never-ready Agent can therefore be removed or repaired.
Source execution history is optional. A current source execution must match the
configured Spec and Runtime; a retained last-successful execution used during
enable may belong to an older Spec, but always to the same Agent. Resource replacement, not new
Runtime readiness, is the barrier that can release a blocked old Runtime Run.

## Verification And Delivery

Tests cover creation completion before readiness, closed execution publication, later
activation, early/repeated/stale events, restart/cursor recovery, identity
revocation and all lifecycle actions for a never-ready target. PostgreSQL tests
check atomic publication, immutable history and the optional source execution
contract. Runtime Client tests pin the new wire contract separately from current
health observations.

Service verification (2026-09-13): the full `-race` suite with an isolated real
PostgreSQL database and real Temporal completed with 14 packages, 436 tests and
393 subtests, zero skipped or failed. This includes the service HTTP boundary
with dependency contract fixtures; it is not a deployed cross-service Docker
run. Targeted regressions reproduced the stale first-binding race before its fix;
independent read-only follow-up found no remaining defect in that fix.

This service batch is owned by Agent Controller; the related Runtime Controller
and Console batches are tracked in `docs/agent-lifecycle-state-model.md` at the
repository root. Gateway/browser/Jaeger acceptance is a separate integration
batch. The service may reuse one development PostgreSQL server but
owns only its own database/schema and accesses other services through RPC.
