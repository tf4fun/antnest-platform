# Runtime Creation And Agent Availability

This document explains why lifecycle completion and executable availability
are separate facts, and how independent Runtime observation publishes an Agent
as available.

## Service Contract

Runtime Controller creation commands finish after platform create/start and
persistence. Their result is `completed` / `provisioned`, not a ready execution
identity. Agent Controller saves that target and completes its lifecycle
operation. No Temporal Activity waits for readiness.

Opening the network separately requires a fresh RC inspection of the completed
target Runtime revision. Its canonical management-network IPv4 becomes Egress's
outer-peer binding; health and execution identity are still independent. A retry
does not reuse an address from a durable compute receipt. Source restoration
likewise inspects the exact source Runtime revision before reopening traffic.

There are two independent facts:

1. Configured Agent: immutable AgentSpec plus the current Runtime revision.
   Create/rebuild/enable publish this pair, clear the active lifecycle operation,
   and establish `created/enabled`, Runtime `unknown`, with no executable revision or endpoint.
2. Available Agent: a current, matching healthy Runtime observation supplies
   execution identity and MCP endpoint. Only then is an immutable execution
   revision appended and the Agent projected `available`.

The `executable_spec_revision_id` database column retains the configured
spec while disabled or awaiting readiness; it alone has never been a Run grant.
Executable configuration publication requires enabled/available, no active lifecycle
operation, valid owner binding/authorization and a complete executable binding.
ACP decides local Run admission from that synchronized configuration. Historical execution
revisions remain immutable and never substitute for a pending target.

## Lifecycle And Observation

Create, rebuild and enable keep their platform/network phases. Publish
commits the configured target, clears old executable fields, preserves historical
execution records, and emits `agent_created`, `agent_rebuilt` or `agent_enabled`.
No execution revision is inserted by these commands. `agent_ready` is emitted by
independent observation only. An unhealthy Runtime never rewrites a completed
creation into a failed operation.

The observation worker drains the Runtime journal and reconciles pending
bindings against fresh Inspect results. It scans only configured pending Agents,
with pagination; it does not inspect every Agent on every Run. Early/missed healthy
events and worker restart therefore converge without an additional queue, table,
workflow or dependence on one event arriving at the right time.

Before execution publication the worker confirms the current peer on the open
Egress attachment. Journal observations also reconcile address changes after
restart, without publishing an execution themselves. Both paths use attachment
CAS; neither opens an attachment closed by a lifecycle operation. A failed
confirmation prevents readiness publication and is retried on the next pass.

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

## Verification

Tests cover creation completion before readiness, closed execution publication, later
activation, early/repeated/stale events, restart/cursor recovery, identity
revocation and all lifecycle actions for a never-ready target. PostgreSQL tests
check atomic publication, immutable history and the optional source execution
contract. Runtime Client tests pin the wire contract separately from current
health observations. A targeted test covers the stale first-binding race. The
service HTTP boundary is tested with dependency contract fixtures, not a
deployed cross-service Docker run.

The platform-wide state model is described in
[Agent lifecycle state model](../../../docs/agent-lifecycle-state-model.md).
The service may share one development PostgreSQL server with other services but
owns only its own database/schema and accesses other services through RPC.
