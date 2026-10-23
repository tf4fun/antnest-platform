# Agent State In The Console

This document describes how Admin Console presents Agent lifecycle, activation
and Runtime condition, and which actions it offers in each state.

The BFF preserves Agent Controller's lifecycle, confirmed activation, Runtime
condition, diagnostic reason/detail and observation timestamp. It never derives
health from a completed lifecycle operation and never probes Runtime directly.

Lists and detail show the current condition for created/enabled Agents, Disabled
for created/disabled Agents, and Not created or Deleted for terminal boundaries.
Detail also shows the underlying lifecycle and activation separately. An active
operation supplies progress, not another persisted Agent state.

Never-ready configured targets can be rebuilt, disabled or deleted without an
execution history. Failed initial creation allows cleanup. Disable intent and
confirmed disable remain distinct; command buttons are conservative hints and
Agent Controller revalidates every action. Runtime health alone is not Run
admission. A healthy target without an execution binding is not shown as ready.

Agent events refresh the projection, including runtime condition changes after
creation completes. Reconnect reads the current projection; it cannot regress a
newer aggregate or alter a terminal Operation. Runtime diagnostics remain visible
to authorized administrators. Internal endpoints and credentials stay excluded.

Tests cover BFF field preservation, state presentation, action eligibility,
statistics and reconnect ordering. Platform integration verifies the complete
producer-to-browser contract separately.

## Runtime barrier recovery

Administrators authorized for the current organization can use **Recover
Runtime** when Agent Controller projects a Runtime recovery reason. The reason
remains visible when the Runtime condition is still `available`: an interrupted
tool call can require recovery independently of Runtime health. This action uses
the existing administrator grant.

The recovery dialog freezes the Agent's current configured Template and version,
together with Controller's projected original request ID, barrier ID and Runtime
revision. **Confirm recovery** first reads that original operation. An existing
operation supplies progress; only an authoritative `404 operation_not_found`
allows the confirmed recovery request to be dispatched. A newer Template catalog
revision does not replace the frozen configuration.

After an unknown submission result, **Check recovery request** only queries the
original operation. Once that query explicitly establishes that the operation is
missing, **Retry same recovery** sends the same original body and idempotency ID.
A `409` retains that identity and requires reconciliation; it does not create a
new request or fall back to an ordinary Rebuild.

Recovery queries, submission and the following Agent refresh are mutually
exclusive with ordinary lifecycle mutations. Page or session changes abort local
requests and invalidate pending decisions before any later dispatch. Agent
Controller remains authoritative for current authorization, the original tuple
and receipt, the configured target and cooldown. Recovery retains previous
messages and tool history.

The recovery browser scenario uses controlled HTTP/SSE API responses to exercise
this Console consumer. Agent UI consumption and actual cross-service manual
Runtime recovery E2E acceptance remain follow-up work.
