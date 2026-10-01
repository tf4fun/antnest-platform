# Agent State

An Agent has a stable lifecycle (`not_created`, `created`, `deleted`), a confirmed
activation state (`enabled`, `disabled` when created), and a current Runtime
condition (`waiting`, `available`, `unhealthy`, `exited`, `absent`, `unknown`).
Desired state and the existing lifecycle Operation retain intent and progress.

Initial configured-target publication establishes created/enabled, without an
execution binding. Rebuild never resets the established lifecycle. Disable
intent immediately closes Controller's published execution permission; ACP closes new
Runs after applying it. Successful Runtime stopping establishes disabled.
Enable completion returns to enabled with an independently observed condition.
Failed commands do not invent success and never erase established creation.
Delete admission retains lifecycle until cleanup successfully establishes deleted.

Runtime condition is evidence about the current target, not a Run grant. Store
its reason, detail and observation time. Unknown evidence is not absence. Current
inspection, not delayed event labels, determines condition. Old revisions and
stale aggregate versions cannot replace newer observations or publish bindings.
Unexpected process loss invalidates execution; health alone cannot repair it.

Controller publishes an executable Agent only when created/enabled/available,
desired enabled, currently authorized and bound to its matching execution, with
no conflicting lifecycle Operation. ACP additionally enforces local execution
occupancy and all Session/Run decisions; Controller does not inspect Run state.
Never-ready configured resources remain eligible for rebuild, disable and delete.
UI labels and actions are projections, not additional stored state machines.

All mutating management paths and execution configuration publication use this
model; a domain-only transition helper that production never calls does not
count as an implementation of it.

The shared scenario matrix is maintained in
[the platform state design](../../../docs/agent-lifecycle-state-model.md).
