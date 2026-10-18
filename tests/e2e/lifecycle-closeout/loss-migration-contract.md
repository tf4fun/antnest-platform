# Runtime loss contract

This document defines what the unplanned Runtime loss profile
(`make e2e-lifecycle-loss`) must prove. It uses the Foundation setup and the SDK
and public Run audits, and covers a live Docker-event case and a cold
inventory-reconciliation case, same-Session recovery and restart deduplication.
SIGKILL is never used.

## Private consumer boundary and inventory

The original member login retains both its Session and Principal. Each created
Agent must have that owner and the creating administrator's organization. The
host uses only the existing gateway-identity and agent-ui-acp grants, private
v1 ACP and complete private execution state. Retired Gateway ACP/state routes
are not positive entry points. The private opener initializes each connection
once; the flow must not initialize it again.

The live and cold cases run serially. Each case has exactly three connections:
`new -> prompt-before -> load`, `load -> denied-prompt`, and
`load -> prompt-after`. The second connection remains open through normal
Runtime stop, removal and the offline observation. Across both cases retain
six connections, six initializations, fourteen business requests, four completed
Runs, eight Provider requests, four Tool calls (two Bash and two read), two
semantic Prompt denials and six lifecycle admissions (Create/Rebuild/Delete
per Agent), including the original same-key lifecycle replay checks. All twenty
ACP request receipts, including initialization, are collected independently.

The private deployment has sixteen raw services and nine application images.
Validate the private relay/exporter and retain its raw receipts before applying
the unchanged fifteen-service Foundation deployment projection. The Loss model
overlay remains scoped to this profile. Fresh candidate images are required.

## Loss injection

After a completed Tool Run, the owned idle Runtime is stopped normally (exit
zero required) and the stopped container is deleted without force.

- **Live case.** The test waits for the exit to invalidate execution before
  deletion; the public loss audit keeps `runtime_exited`. The `runtime_deleted`
  producer observation is required separately.
- **Cold case.** The Runtime Controller is stopped before the Runtime is stopped
  and removed; after its normal restart, platform reconciliation must report
  `runtime_missing`.

## Required behavior

- Controller loss audits use fresh Inspect evidence (observation sequence zero
  and an `event_` identity with 32 lowercase hex digits); no direct journal link is
  fabricated. Producer route, Agent, Runtime revision, generation and physical
  resource are correlated independently.
- Inspect must report provisioned/absent, with a cleared execution binding and
  preserved configured spec, history and workspace.
- ACP must report `offline/agent_unavailable` in the full private state and reject
  Prompt on the still-open second connection with
  `-32020/agent_unavailable/retryable=false`, no notification and no Run or model
  activity. A disconnect, timeout or another refusal is not this evidence.
- An explicit Rebuild recovers the same configuration and workspace under new
  compute, Runtime and execution revisions. Exact Session replay must not
  execute.
- Four completed Tool Runs, two denials, the actual SDK request Traces and six
  lifecycle Traces are verified.
- Each replay keeps exact history and causes no execution. After recovery, a
  second normal Controller restart must catch its cursor up without changing
  physical identity or duplicating loss/history/audits. Preserve exact workspace
  bytes and the old Run audit through the same-Session read after Rebuild.

## Trace rules

Strict timing failures and deliberate rejection errors retain their raw failed
status separately from business admission. A Loss-owned denial inspector must
verify the exact semantic refusal, private client/upgrade/request lineage and
absence of execution. It must not widen the Managed busy policy or count a
different error as this denial. Missing-source Rebuild Trace evidence opts in with the physically
observed old generation: a completed absent Inspect under the exact Runtime
update request is required, followed by successful next-generation allocation
and start under the same update. The source 404's raw ERROR span and strict
failure are preserved.

Every actual request ID, connection Trace and Session is bound to its complete
wire receipt. The four Runs bind the original public audit to two model phases
and one real Tool each. Missing, foreign, duplicate or unclaimed internal
diagnostics fail. Confirmed external SDK/clock diagnostics remain visible under
the existing non-blocking policy; no SDK workaround or timing relaxation is
introduced.

Every client and host exporter is closed and joined while its receiver remains
available. Independent ACP and lifecycle collection continues after a sibling
failure unless the parent is aborted. Preserve original business, cancellation,
archive and cleanup errors together before final admission. Raw private state,
wire and error bodies stay in private evidence, outside the public summary.

Negative tests come first, checks run serially, and owned cleanup and the
remaining environment are verified afterwards.
