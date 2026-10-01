# Runtime loss contract

This document defines what the unplanned Runtime loss profile
(`make e2e-lifecycle-loss`) must prove. It uses the Foundation setup and the SDK
and public Run audits, and covers a live Docker-event case and a cold
inventory-reconciliation case, same-Session recovery and restart deduplication.
SIGKILL is never used.

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
  and a `runtime-condition-loss` event identity); no direct journal link is
  fabricated. Producer route, Agent, Runtime revision, generation and physical
  resource are correlated independently.
- Inspect must report provisioned/absent, with a cleared execution binding and
  preserved configured spec, history and workspace.
- ACP must report `offline/agent_unavailable` and reject Prompt with
  `-32020/agent_unavailable`, with no Run or model activity.
- An explicit Rebuild recovers the same configuration and workspace under new
  compute, Runtime and execution revisions. Exact Session replay must not
  execute.
- Four completed Tool Runs, two denials, the actual SDK request Traces and six
  lifecycle Traces are verified.

## Trace rules

Strict timing failures and the deliberate rejection errors are reported as
failures. Missing-source Rebuild Trace evidence opts in with the physically
observed old generation: a completed absent Inspect under the exact Runtime
update request is required, followed by successful next-generation allocation
and start under the same update. The source 404's raw ERROR span and strict
failure are preserved.

Negative tests come first, checks run serially, and owned cleanup and the
remaining environment are verified afterwards.
