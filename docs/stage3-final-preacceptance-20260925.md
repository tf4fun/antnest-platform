# Stage 3 final pre-acceptance checkpoint

Date: 2026-09-25. Candidate source: `a6ebb15b8a5da2844c185fa5f5e76fff5bf45251`.
This is preparation evidence, not a new Stage 3 final acceptance decision. The
single-node service boundary and reviewed clock-warning exception remain those
in [the Stage 3 closeout](stage-3-current-services-closeout.md). Planned new
services remain Stage 4 work.

## Candidate checks completed

The committed Agent UI candidate passed 219 server tests, 156 browser-logic
tests, 106 component tests, 19 shared-contract tests, 16 Node HTTP/SSE tests,
two memory probes, production build/typechecks, and four Chromium/SSR tests.
The production Bridge container gate passed after correcting its test fixture
to bind ACP clients by principal and wait for both the delivery watermark and
`ready` history state. Earlier unchanged runs had passed once and failed twice
at the 17 MiB delivery case; both failures are retained under
`artifacts/verification/stage3-preacceptance-20260925/`. The failed fixture
had indexed mutable ACP connections by load order, and its private diagnostic
recorded repeated cold loads after the missed update. One complete run of the
corrected fixture has passed; repeatability remains a candidate gate.

The isolated six-service Chromium main workflow, complete-history workflow,
and pre-receipt Bridge crash reconciliation each passed on the same candidate.
Their test-owned resources were removed. Before and after this batch, Docker
had the same twelve retained containers, 285 volumes, and fourteen networks.
Private command output is in
`artifacts/verification/stage3-preacceptance-20260925/`.

The first local server run failed seven loopback-listener tests with sandbox
`EPERM`; the unchanged suite passed when loopback binding was permitted. That
environment failure is preserved in the private logs. `git diff --check` and
the staged diff check passed. Repository-wide `make fmt-check` initially listed
22 unformatted test sources, including Agent UI and other service files. A
separate mechanical Prettier pass normalized those sources; the complete
`make fmt-check` now passes. This test-source formatting is separate from the
Agent UI behavior commit.

## C4 evidence reconciliation

The [2026-09-16 C4 browser report](c4-browser-revalidation.md) passed its five
scoped business items on its dated UI image. It cannot by itself establish
browser acceptance of this Node/HTTP/SSE candidate. The current E2E evidence
has the following boundaries:

| Item | Current candidate evidence | Remaining check |
| --- | --- | --- |
| C4-01 | Real Gateway login, Agent/Session selection, multiple Runs, permission and Tool flow in the six-service main path | Recheck exact Runtime workspace bytes and Tool presentation in the C4-specific browser profile |
| C4-02 | Current browser covers capability rejection and attachment recovery; earlier C4 report checked exact text/image bytes and visible previews | Recheck accepted text/image bytes, preview and Tool result on the new UI |
| C4-03 | Two Sessions, busy state, Stop, page close, offline completion, Bridge/Gateway restart and one-model-request recovery have current E2E evidence | Include the C4-specific cross-Session cancellation path in the candidate profile |
| C4-04 | Identity expiry, logout and revocation on open pages have current E2E evidence | Recheck real Runtime Rebuild feedback and privacy payload audit on this candidate |
| C4-05 | Current component, Chromium/SSR, mobile navigation and six-service checks pass | Run current desktop/mobile C4 browser interactions and preserve candidate screenshots |

The existing `tests/e2e/workspace-closeout/c4-browser.mjs` still observes ACP
WebSocket frames and old UI selectors. It must be adapted to the current
HTTP/SSE workspace, or replaced by an equivalent current-candidate profile,
before the remaining C4 checks can be closed. Real screen-reader use and
non-local deployment remain deferred by the user's scope decision; the
historical five-item checklist is not silently marked passed.

## Remaining final-candidate admission

1. Establish repeatability of the corrected Bridge container gate. The
   formatting gate is complete, with its changes kept separate from the Agent
   UI behavior commit.
2. Revalidate the missing C4-specific browser observations against the
   committed Node/HTTP/SSE candidate.
3. Run the Stage 1/2/3, Identity, lifecycle, ACP, Console and Workspace
   business/topology inventory against one fixed source and image candidate,
   with serial Docker resource accounting. The
   [2026-09-22 combined regression](final-candidate-regression-20260922.md)
   predates this commit and is historical evidence only.
4. Update the Stage 3 closeout and current-status index with the resulting
   candidate report. Preserve original strict Trace exits and apply the
   documented exception only to individually reviewed nonlogical clock
   warnings. New business, parentage, privacy or unexplained diagnostics fail.
