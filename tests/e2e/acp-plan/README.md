# ACP structured plan E2E

This scenario verifies structured plan updates (`update_plan`) through the
deployed ACP service on a disposable full stack. It uses test fixtures only and
does not change production ACP or Runtime behavior.

## Running

Run serially. The parent builds eleven independent release candidates from the
current source, selects their exact image IDs and uses the admission override
after the normal isolated Compose configuration:

```sh
make test-plan-fixtures
make e2e-structured-plan
```

The parent profile owns one disposable Compose project with one PostgreSQL
instance and service-owned databases. The plan-specific Compose override
ignores the local `.env`, removes the host Temporal port and keeps dynamic IPs
separate from the fixed Egress and Jaeger addresses. No client MCP injection,
external Provider or browser is used.

## Workflow

The client creates users, a Provider connection and Model, a Template that
references the stable Model identity, and an Agent from the returned Template
revision through the Gateway and Admin Console BFF, then waits for executable
readiness.

For each ACP version, a real Session creates a plan, executes one Runtime write
and updates the plan, rejects an invalid plan, clears it, and starts another Run
that must see the empty plan. A fork taken before clearing must still see the
earlier plan. Full entries, ordering, priorities and statuses must match exactly,
and a plan is never inferred from reply text. The replacement plan changes order,
priority and status, removes a step and leaves one step unfinished; Run
completion must not silently finish that step.

A deterministic SSE model drives Tool calls and checks actual arguments, results
and the Run-start context. A bounded test-only response gate holds the final
model reply until the ACP client has received the plan update, so finding a plan
only after completion is not enough. The gate is a fixture, not a product API.
The only remote execution is the explicit Runtime write; `update_plan` stays
local. Fixtures cannot write SQL or access Docker.

Private v1/v2 WebSocket connections use the original browser Principal, an
Identity-issued workspace CCT and the read-only Agent UI→ACP service grant.
New connections load, resume and fork the persisted stream through this private
entry. Gateway and Console remain responsible for setup and administrative APIs.
Plan and Tool updates, including IDs and order, are compared against the live
stream; an empty matching subset is not success. Another user receives the exact
ACP `access_denied` error with no private updates, and a successful
authenticated WebSocket upgrade alone does not grant Agent access. Cross-Agent
access returns `session_access_denied`.

All wire updates are validated against the pinned official SDK schemas. Tool IDs
are checked across Runs in the same Session, not only within one Run. The mixed
scenario requires the remote result before the following plan and its local
result. The model fixture validates message roles and call-before-result
ordering. Each protocol version has its own Tool event shape: v1 starts with
`tool_call`, while v2 has no initial `tool_call` event and identifies the first
`tool_call_update` by its Tool ID.

## Trace checks

- The original SDK wire ID selects each request and its exported private
  CLIENT→upgrade→RPC boundary. The actual model HTTP inventory independently
  checks all 12 Runs, 22 model requests and two Runtime writes. The model HTTP
  CLIENT is matched through `model.complete` to its owning `agent.run` and Run ID.
- The 26 replay/denial requests and two successful session creations bring the
  business inventory to 40. Fourteen initialization requests are inspected
  separately. Fork input and returned Session IDs are independently bound.
- Every original connection is closed and joined before collection. Complete
  raw query responses, source hashes, exact error ownership and strict verdicts
  are kept under `artifacts/verification/acp-plan/<project>/traces/`. Three stable
  samples are required; initialization diagnostics join the final inventory.
- Every Run needs committed PostgreSQL persistence with a real driver write and
  fresh Runtime information and catalog reads before model execution.
  Management calls inside a Run are forbidden.
- Only the execute phase may have one remote write dispatch with its Runtime
  Tool SERVER descendant; plan-only Runs must have none. Generic transaction
  spans prove a persistence path, not the number of plan commits.
- Successful replay and fork requests and denial requests are collected
  separately. Repeated loads of one Session are disambiguated by their
  connection link. Each Trace must match its method and resource identity and
  must not execute a Run, model or Runtime tool. A successful replay may read
  the Runtime Skill catalog (`discover` and `resources/read`) once each; a
  denied request may not. Denial diagnostics must stay within the matching
  rejected ACP request and domain operation.
- Plan content, user input and synthetic credentials must not appear in
  exported Jaeger Traces. This check does not cover container stdout or metrics
  exports. IP forwarding is outside the tracing scope. Collection uses bounded
  stable-span sampling, which cannot rule out arbitrarily late telemetry.

Raw warnings and strict failures are preserved. Exit 0 means strict success;
exit 2 preserves reviewed Jaeger clock-skew warnings with valid business and
ownership evidence; other failures exit 1. CI runs the parent script directly
so Make does not erase this distinction. The deferred same-Node SDK endpoint
observation is limited to strictly less than 1 ms and does not waive
cross-process warnings or missing telemetry.

## Cleanup

Before Agent deletion, the client waits for a host receipt binding both live
Runtimes to their Agents, generations, project/run, candidate image IDs and
original inspection hash. The host also verifies all running service candidates
and both harness containers. Client and model run with only the two necessary
read-only grants; the evidence writer uses the host evidence owner.

The client joins Prompt and connection cleanup even after an early-plan gate
failure. Agent cleanup attempts every created Agent and preserves all failures.
The parent removes its containers, volumes, networks and recorded candidate
tags on success or failure and never adopts images from other deployments. Only final counts and verdicts are
printed, never raw events, credentials or Trace dumps.
