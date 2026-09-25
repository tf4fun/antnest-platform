# attyd alignment correction batches

Reference: attyd `754ac145ab6d8a3437655e778f7a06fb04aa7239`.
Scope: the six findings in the 2026-09-25 implementation audit, including removal
of cumulative history admission limits. Existing Node/HTTP/SSE ownership,
Gateway identity and durable ACP intent receipts remain the foundation.
I1/I2 below are admission batches for these corrections. The user's deferred
external deployment and actual screen-reader acceptance remain outside this batch.

The correction batches and their applicable local integration gates are complete on 2026-09-25.

| Batch | Owner | Required result | Status |
| --- | --- | --- | --- |
| A0 | Shared contracts | Complete history, fenced Agent-view deltas, ordinary deadlines, Session lifecycle | Passed: schema regressions, including HTTP-to-SSE cursor handoff |
| A1 | Agent UI | Tool/plan replacement, retained-byte accounting, no history clipping/admission cap | Passed: complete service and integration gates |
| A2 | Agent UI | 60-second total ordinary HTTP wait, body included, independent accepted work | Passed: five real HTTP deadline regressions |
| A3 | Agent UI | Local accepted-Run revision progress without reload; recovered work leases; Session idle/incarnation fencing | Passed: lifecycle and late-observation regressions |
| A4 | Agent UI | Incremental producer and browser reducer; constant-sized control publications; reset recovery | Passed: producer/reducer, projection and real browser regressions |
| I1 | Integration | Contract, all service unit/component gates, real HTTP/SSE/Chromium integration | Passed on frozen code, including paging and observation ordering |
| I2 | Integration | Applicable production container and six-service Docker browser regression | Passed on frozen code: production container, complete-history stack, comprehensive stack |

Each behavior begins with a failing regression. Test sources remain in the
service or root integration/E2E directories; private command logs live under
`artifacts/verification/`. The A0 Node/browser consumers are implemented and verified together;
Gateway still forwards opaque events and ACP already exposes durable receipts
and delivery watermarks. If those contracts prove insufficient, any producer
change is a separate service-owned batch before cross-service verification.

Ordinary updates now replace tool fields and the current plan, retain omitted
fields, preserve final answers on late sparse tool updates, and count retained
logical data. Tests cover 65 MiB history and 17 MiB delivery without clipping.
Paging and disposable journal/observer queues remain bounded. The former shared
history budget class and reservation metric have been removed.

A local append transition is trusted only when this owner submitted its intent
and the durable receipt proves contiguous append versions. The Bridge waits for
complete live delivery; cold history, external writers and explicit delivery
gaps still use sealed recovery. Recovered Runs are re-observed by the sweep even
without a browser. Each Session has its own idle grace and incarnation.

The shared browser-safe DTO/patch module is under `web/server/src/protocol/` so
both entrypoints use identical validation without importing Node or ACP runtime
code into the browser. Deltas patch the retained Agent View atomically; invalid
paths, prototype segments, result shapes, identity or revision fences cause
resynchronization. `fromCursor` connects the initial HTTP cut to the first SSE
delta without decoding opaque signed cursors. Small metadata/output updates are
verified to omit unrelated text and make no extra ACP GETs. Collapsed turn
projection does not format tool result bodies.

Integration/container sources now assert complete history, scoped delivery and
exact content paging. The obsolete history-byte rejection/preview profile and
its Compose overlay have been replaced by `tests/e2e/agent-ui/fullstack-history.test.mjs`.

Integration follow-up also removes the browser's former 64 MiB fragment and
1024-page cumulative limits, while retaining response envelopes, cursor-cycle
detection and aborts. Fragment accumulation keeps received chunks and assembles
the block once, instead of copying the entire prefix on every page. Collapsed
projection borrows content only during synchronous projection, cloning the
visible window before publishing; hidden large text is neither cloned nor
serialized. Four additional failing regressions now pass.

Local evidence on 2026-09-25: complete build/typechecks; 195 server unit tests,
137 browser logic tests, 91 component tests and 16 contract tests pass. Real
Node HTTP/SSE integration passes 14 tests, including the five total-deadline
cases and retained-heap/slow-observer verification with explicit GC. Chromium
and SSR integration pass four tests, including continuous title deltas with
no extra View GET. All local gates have passed again on the final frozen code.

The production-container run exposed a pre-existing fixed-512-byte reservation
in content fragmentation: real signed cursors can make a page exceed 256 KiB.
Content pages now account for their actual cursor and JSON envelope, including
long scope IDs and UTF-8 bodies. A pager retains only the currently requested
serialized block, reusing it for adjacent fragments at the same revision.
Both regressions failed before the change and pass afterward. The production
container rerun passes: twelve reads of 320 KiB history perform one ACP load;
fifteen additional owners keep readable histories; 17 MiB output is reconstructed
exactly through bounded pages. The slow observer follows 512 visible-window
updates, receiving 105 frames including 85 resets and reaching the final watermark.
Its container memory sample goes from 77.9 MB to 145.2 MB and then 60.7 MB after
disconnect. The separate 17 MiB case goes from 95.4 MB to 160.3 MB and 130.2 MB
after idle. These are fixed local workloads, not an arbitrary-history heap bound.
Cold authenticated HTML arrives 1.34 seconds after launch; container stop exits
with code 0 within the 30-second grace. Private measurements are in
`artifacts/verification/agent-ui-capacity-20260925/`.

Final review reproduced three ordering races in the new cached observations:
an older execution response could replace a newer receipt and retain finished
work; concurrent Agent HTTP reads could keep the first completion instead of
the later request; an equal fresh watch observation did not fence an old HTTP
read. Execution observations now retain their request sequence, and Agent reads
use separate HTTP and watch generations. Equal watch values fence old requests
without publishing another control change. All three regressions failed first;
the lifecycle/owner/runtime/incremental suites then passed 65 tests. The final
serial admission run includes this change.

Final frozen-code evidence: 457 local checks and three Docker E2E profiles pass,
with zero failures/skips. The complete-history stack verifies four consecutive
real Runs, exact 32/96 KiB answers, browser expansion and refresh without repeat
model execution. The comprehensive stack covers Bridge/Gateway restart, page
close/logout, continued Runs, permissions, cancellation, timeout, expiry,
revocation, multi-Session history and fixed-load browser/Bridge memory gates.
Its held-Run and pending-permission Bridge restarts take about 15.8 seconds each.
Temporary browser processes, Compose stacks and test containers are cleaned up.

Reproducible command logs: `artifacts/verification/agent-ui-alignment-final-gates-20260925.log`
and `artifacts/verification/agent-ui-alignment-final-docker-20260925.log`.
Final review found no pending consumer or service implementation work for these
corrections. The explicitly deferred external environment and actual
screen-reader acceptance are unchanged in scope.
