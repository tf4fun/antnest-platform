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
