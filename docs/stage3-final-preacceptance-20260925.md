# Stage 3 final pre-acceptance checkpoint

Date: 2026-09-25. Base source: `a6ebb15b8a5da2844c185fa5f5e76fff5bf45251`.
The current candidate also contains the Agent UI and C4 test changes recorded
below; its exact commit and image IDs belong in the final acceptance manifest.
This records readiness to enter final acceptance, not a new Stage 3 acceptance
decision. The agreed single-node service boundary and reviewed clock-warning
exception remain in [the Stage 3 closeout](stage-3-current-services-closeout.md).
Planned new services remain Stage 4 work.

## Candidate checks completed

The committed Agent UI refactor passed 219 server tests, 156 browser-logic
tests, 106 component tests, 19 shared-contract tests, 16 Node HTTP/SSE tests,
two memory probes, production build/typechecks and four Chromium/SSR tests.
The isolated six-service Chromium main workflow, complete-history workflow,
and pre-receipt Bridge crash reconciliation passed. Their test-owned resources
were removed. The Bridge production-container fixture was corrected to bind
ACP clients by principal and wait for the delivery watermark and `ready`
history state. Its 17 MiB case has since passed twice, including a repeat on
this candidate. Earlier failures and diagnostics remain private under
`artifacts/verification/stage3-preacceptance-20260925/`.

The current permission and SSR fixes passed 219 server, 156 browser-logic and
107 component tests, production build/typechecks, four Chromium/SSR browser
tests, 16 Bridge HTTP/SSE integration tests, both memory checks, 97 C4 helper
tests and the repeated Bridge production-container gate. A valid pending
permission now checks execution authorization without waiting for unrelated
historical replay. An Agent page without a selected Session renders its empty
state directly on the server instead of suspending on the lazy Conversation
chunk. Initial local tests that opened loopback listeners failed with sandbox
`EPERM`; the same suites passed when loopback binding was permitted.

Repository-wide `make fmt-check` passed after a separate mechanical pass on
22 pre-existing unformatted test sources. The current C4 migration changed
test sources again; `make fmt-check`, `git diff --check` and the 14-case
chat Trace contract rerun passed on the current worktree.

## C4 candidate evidence

The [2026-09-16 C4 browser report](c4-browser-revalidation.md) predates the
Node Bridge. The migrated HTTP/SSE C4 profile now runs on the current UI,
Gateway and ACP images. Its second complete run recorded
`status=browser_passed`, all eleven business/privacy checks passed and
`cleanup=verified` in
`artifacts/verification/c4-browser-2026-09-25T12-23-26-721Z/report.json`.
It checks real login, exact Runtime workspace bytes, attachments and previews,
capability rejection, Tool permission, two-Session busy/Stop behavior, offline
and close/reopen completion, Rebuild, identity revocation, private-data
responses, and desktop/mobile layout. Candidate screenshots are retained in
that private evidence directory. The earlier unported C4 failures and the
permission/SSR red-green diagnostics are retained in the same verification
area.

The C4 Trace contract now requires Gateway HTTP → Agent UI Bridge → ACP HTTP
→ ACP Prompt → Run → model/Runtime ancestry. The old runner expected direct
Gateway ACP forwarding; the new contract has a red-green unit test, and the
real C4 rerun passed successful-Run topology. There were no error spans in
those successful Runs. `strict_trace=failed` and original exit 1 remain:
every saved warning is the previously reviewed Jaeger
`clock skew adjustment disabled` category. The cancelled Run has its separate
expected-cancellation scope. This is not a zero-warning strict pass.

| Item | Current candidate evidence | Remaining review |
| --- | --- | --- |
| C4-01 | Login, Agent/Session, Run, permission, Tool and exact Runtime bytes passed | Frozen final candidate manifest |
| C4-02 | Attachment previews/bytes and capability rejection passed | Frozen final candidate manifest |
| C4-03 | Two Sessions, Stop, offline and close/reopen completion passed | Frozen final candidate manifest |
| C4-04 | Rebuild, revocation and private-data response audit passed | Frozen final candidate manifest |
| C4-05 | Desktop/mobile interactions, Chromium/SSR and screenshots passed | Real screen-reader and non-local deployment remain deferred by user scope |

The C4 network privacy audit reads finite HTTP responses and the scoped Agent
View. SSE body and resumption are covered separately by Bridge integration
and fullstack profiles. The historical closeout decision is not silently
rewritten by this pre-acceptance result.

## Final acceptance work

1. Freeze and review one source and service-image manifest, including the
   permission/SSR correction and C4 migration, then use it consistently for
   final acceptance.
2. Run the Stage 1/2/3, Identity, lifecycle, ACP, Console and Workspace
   business/topology inventory against that fixed candidate, with serial
   Docker resource accounting. The
   [2026-09-22 combined regression](final-candidate-regression-20260922.md)
   is historical evidence for an earlier candidate.
3. Update the Stage 3 closeout and current-status index with the resulting
   candidate report. Preserve original strict Trace exits and apply the
   documented exception only to reviewed clock-only warnings. Any new
   business, parentage, privacy or unexplained diagnostic failure remains a
   final-acceptance failure.
