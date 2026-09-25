# Stage 3 current-service closeout boundary

The later [2026-09-26 final candidate acceptance](stage3-final-acceptance-20260926.md)
adds the completed Agent UI C4 browser validation and serial cross-service
regression for the current service images. It preserves this closeout's
clock-warning exception and the original strict Trace failures.

Decision: 2026-09-23. **The implemented single-node service scope is accepted
for Stage 3 with the recorded clock-warning exception.** This is an acceptance
decision about reviewed evidence, not a change to Jaeger data or the strict
Trace runner's result.

Stage 3 comprises Antnest Runtime, Runtime Egress, Runtime Controller, Agent
Controller, Agent ACP Service, Identity Service, Edge Gateway, Admin Console and
Agent UI. Skill Registry, Channel Gateway and Scheduler are planned for Stage 4.
Kubernetes, multi-node operation and high availability are also outside this
Stage 3 acceptance boundary. Their absence does not block this closeout.

## Evidence and disposition

The [single-node checklist](docker-single-node-closeout.md) records 25 accepted
items, five explicitly deferred Agent UI browser items (C4-01..05), and no
remaining item within its agreed gate. Those five items remain **unaccepted**;
the Stage 3 decision does not convert them into passing browser evidence.

The later [combined candidate regression](final-candidate-regression-20260922.md)
records business and applicable Trace topology checks passing across 32 entries.
Its strict Trace commands retained their nonzero exits for timing warnings and
scenario-specific fault/cancellation diagnostics. The regression belongs to its
recorded candidate and precedes the final test-asset migration; it is not a new
full-platform run of the current uncommitted worktree.

For the Stage 3 base profile specifically,
`artifacts/verification/final-regression-20260922/stage3-final.parsed.json`
records 11 deployed services, the five Agent lifecycle operations, three ACP
transports, eight model requests, business success and 34 passing topology
inspections. Fifteen Trace inspections passed the original strict check; 19
failed it (five lifecycle and fourteen Session inspections). All 19 failed rows
have recorded `clock skew adjustment disabled;` warnings. They contain 1,530
warning occurrences in total. No other warning category or Docker absence-probe
ERROR span is recorded in this final base report. The
`trace-audit-summary.jsonl` in the same evidence directory found no missing
parent in the five saved raw lifecycle Traces. The 29 Session inspections have
validator summaries; this audit does not claim a fresh raw replay of all 34.

**Disposition:** the reviewed clock-only warnings above are accepted for the
Stage 3 functional and structural gate because no business or causal-topology
failure accompanies them. The stored `strict_trace=failed`, original command
exit 2, warning text and private evidence remain unchanged. Report this as
"Stage 3 current-service acceptance passed with reviewed clock warnings;
original strict Trace diagnostics failed," never as "zero-warning strict Trace
passed." The decision is limited to the inspected results. A new warning,
missing parent, duplicate span, wrong causal chain, unexpected ERROR, leaked
secret or business failure still fails its applicable check and needs review.
Intentional cancellation/rejection/crash diagnostics retain their own recorded
scope; this clock decision does not classify them as passed.

## Repair options

For the observed sub-millisecond-to-millisecond warning class, enforced global
NTP is neither required for this acceptance nor sufficient as a guaranteed fix.
The [recorded same-process SDK reproduction](controller-acp-execution-boundary-plan.md#obs-acp-clock)
produced parent/child timestamp inversions with no cross-host clock offset.
The [Jaeger query finding](observability-simplification.md#warning-漏检修正)
also shows that an early ordinary query can leave a stale warning after its
parent arrives; the accepted fixture waits before querying and retains the
warning check. Future low-risk work can recheck the SDK on a routine upgrade
and verify complete Trace collection before querying. A common timestamp
source across every service, SDK changes or stronger host time synchronization
would be a separate observability project, justified if the warnings grow or
impair diagnosis. No timestamp, warning or Jaeger configuration is changed by
this closeout decision.

The later [ACP timing review](acp-async-timing-review-20260923.md) locates four
warning origins in a separate ten-Trace browser sample. Jaeger propagates them
through same-host descendants; a late-ending Run or output read is not itself
proof of a new clock warning or business-order failure. Completion barriers
passed. The subsequent Gateway phase/kind correction has isolated Docker Trace
evidence for all four sampled forward spans and their ACP children; coalesced
output-refresh correlation and clock warnings remain. This review does not
expand the exception to unreviewed warnings or replace the base-profile
evidence above.
