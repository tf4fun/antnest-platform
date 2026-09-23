# ACP / Runtime / UI Combined Integration

Recorded: 2026-09-16. This is the explicit integration batch following the
[ACP SDK audit and Session metadata service batch](../services/agent-acp-service/docs/acp-v1-sdk-audit.md).
The candidate is `fa80267` plus the metadata worktree changes, using the current
Runtime response-close fix and Agent UI attachment-error fix. No production
implementation changed during this integration batch.

## Contract And Scope

The existing ACP `session_info_update` title/time must reach every authorized
subscriber and agree with `session/list`. Two actual UI pages observe one
Session through Gateway. After a new prompt, the timestamp must change from its
previous value; both pages must display exactly the received title/time. Reload
must list and load the same metadata without changing activity time or
reexecuting model/Tool work. No shared protocol or service API changed.

The [C4 runner](../tests/e2e/workspace-closeout/c4-run.mjs) starts isolated real
Gateway, Identity, Controller, ACP, Runtime, UI, PostgreSQL, Temporal and Jaeger
services with synthetic accounts. Only the external model is controlled. The
browser does not mock Gateway/ACP traffic. Images were built serially using
`make -j1 docker-build-stage3`; retained development services were not redeployed.

| Candidate | Image ID |
| --- | --- |
| ACP | `sha256:86894d69ff528e71e1d987f1b19a52aeeb182e2f229831207caf340af80588d4` |
| Runtime | `sha256:2ed4ffe11b2f7ce24de4bcfb07566e7de012637400c7a82d3703fdc53ab1b909` |
| Agent UI | `sha256:199d86414a5ca54ac13deb4fd6dad70c66cf1b5ffb189f6701e5e3e99484a6f1` |

Build logs, all nine service image IDs and fixture output are retained locally
under `artifacts/verification/acp-platform-integration-20260916/`. The preceding ACP service gates
remain 959 unit/contract/component, 245 PostgreSQL and 9 SDK audit tests, plus
four isolated ACP production-image scenarios. Those counts belong to the
preceding service batch; they are not fresh reruns here. This batch reran all
40 workspace fixture tests successfully before the deployment verification.

## Final Deployment Evidence

Final report: `artifacts/verification/c4-browser-2026-09-16T15-48-45-799Z/report.json`, project
`antnest-lifecycle-93af7ada`. All 11 browser/business checks passed:

- Member login, Agent selection, new/load Session and real Runtime tools.
- Two-page metadata convergence, list agreement and unchanged reload time.
- Exact attachment bytes/previews, format rejection and model-capability rejection.
- Actual Tool permission approval.
- Cross-Session busy observation, model cancellation and readmission.
- Offline completion and close/reopen without resubmitting work.
- An open page observes Rebuild; exact workspace bytes and history survive.
- Desktop/mobile interaction and identity revocation return to login.
- Private Runtime addresses, access subjects and Provider credentials stay absent.

The Session title stayed `c4-browser-write`; both pages observed activity time
advance from `2026-09-16T15:49:18.913Z` to `2026-09-16T15:49:20.501Z`.
The fresh list, load notification and visible `<time>` value all matched the
latter timestamp exactly. Four actual Runtime Tool calls and 14 controlled
model requests served nine completed prompts and one canceled model request.
The rejected audio prompt made no model request. There were zero browser/model
errors or pending model requests; 560 browser payloads/frames/state snapshots
passed the private-data check.

Nine successful chat traces passed ancestry/topology and had zero error
spans/events. Five passed strict Trace checking. Four failed with 399 repeated
warning entries, all `clock skew adjustment disabled`:

| Phase | Trace ID | Warning entries | Calculated delta |
| --- | --- | --- | --- |
| Read | `c4dd3a3ec0573c97d5139d1d14d41da0` | 170 | 221.484 µs |
| After cancel | `659e78b33fbe0d744e2e6a925e758c09` | 83 | 458.393 µs |
| Close/reopen | `ac99433544f7aacc78dfddb43af92588` | 63 | 165.102 µs |
| Mobile | `e3d3b4a2f563497cc0bc50b537b420b1` | 83 | 218.143 µs |

The same raw timestamp review found ACP server starts 221, 458, 165 and 218
microseconds before their intact Gateway client parents, with millisecond-aligned
ACP start times. The review and independent cleanup inventory are saved in
`artifacts/verification/acp-platform-integration-20260916/final-review.json`. Desktop attachments,
mobile conversation and revoked-login screenshots were inspected; the final
mobile screenshot also retained readable layout and input controls.

The canceled request is a separate expected-cancellation topology, not one of
the nine successful chats. Final runner result remains **exit 1**,
`status=browser_passed`, `strict_trace=failed`, `cleanup=verified`.
This is business/topology acceptance with recorded timing failures, not a strict
whole-script pass. Owned containers, Runtime containers, volumes, networks and
browser processes were removed. The retained development stack remained healthy.

## Earlier Run And Timing Review

The first run at `artifacts/verification/c4-browser-2026-09-16T15-44-38-856Z/report.json`
passed all 11 browser checks, including the new metadata comparison. Nine
successful chat traces passed topology with zero error spans/events. Five
passed strict Trace checking; four failed with 292 repeated clock-warning
entries and distinct deltas of 293.253, 240.209, 97.261 and 372.483 microseconds.
Raw parent timestamps show the ACP server starting respectively 293, 240, 97
and 372 microseconds before its Gateway client parent; ACP start timestamps have
millisecond precision. Parent identity and execution ancestry remain intact.
These observations are consistent with the previously investigated timing
limitation, not evidence of missing parents or failed business execution.
The script returned exit 1 and cleanup was verified.

The final probe additionally requires the observed activity time to differ from
the pre-prompt value, preventing two stale pages from satisfying equality.

## Acceptance Boundary

Keep strict clock-warning failures under the existing
[OBS-ACP-CLOCK maintenance decision](controller-acp-execution-boundary-plan.md#obs-acp-clock).
No warning filter, duration threshold, timestamp rewrite or clock setting was
introduced. Business/topology results do not turn the entire script green.

The browser uses ACP v1. The metadata service batch separately covers v1/v2,
fork and ACP process restart. This integration does not reclassify those as
browser scenarios, test external paid-model quality, or claim automatic recovery
after cancellation with unknown Tool effects. Refusal isolation and unknown-effect
cancellation retain their service-owned Docker evidence. The then-pending 12-path
`acp-progress` fixture update and real Runtime rerun were subsequently completed
in the separate [2026-09-17 progress batch](tool-progress-revalidation.md), with
business/topology passing and strict timing warnings still failing.
The 2026-09-11 C4 accounting remains historical, and ignored `.cache` artifacts
are not guaranteed to exist in a fresh clone.
