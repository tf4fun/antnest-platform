# Manual browser finish helper retirement

Date: 2026-09-21. This implements the second bounded removal from the
[retirement audit](acceptance-retirement-audit.md), following the
[old orchestration/admission cleanup](acceptance-retirement-revalidation.md).

The migrated browser profile already runs automatically. Its former
`waitForFinish` export has no executable caller; only three tests still exercise
manual input, EOF and interruption of that retired loop. Remove that export,
the three exclusive tests and their unused `EventEmitter` import.

Keep `browser-control.mjs` and `browser-control.test.mjs` because both current
browser profiles use `assertWorkspaceBytes`. Its implementation and remaining
test are unchanged: exact workspace bytes pass, mismatched bytes fail, and
diagnostics do not expose private file contents. Browser shutdown and signal
handling remain owned by the current automated runners and component checks.
Model peers, screenshots, current profile contracts and production services are
unchanged.

## Verification

All four original tests pass before removal. The final shared suite passes
1,205 tests, with five pre-existing opt-in ACP PostgreSQL commit-receipt fault
checks skipped and no failures/cancellations. Its 1,210 tests are exactly three
fewer than the preceding 1,213-test batch. The byte/privacy assertion and current
HTTP/WebSocket/Chromium component checks remain.

Private source hashes, pre-change module/test snapshots, logs and retained
container baseline are under `.cache/browser-finish-retirement-20260921/`.
The shared suite and both disposable browser profiles run serially.

The automated four-scenario profile uses project `antnest-lifecycle-eda7814c`.
All five browser check groups, four Runs, six model requests, two Tool calls,
exact bytes and replay without execution pass. All thirteen topologies pass;
missing parents and error spans are zero. All eleven browser requests pass strict
checks. Create and Delete retain timing failures (calculated deltas 459.945 µs,
679.845 µs, 637.853 µs and 661.207 µs), so the runner retains exit 2. The four
screenshots were inspected: real expanded Tool output, attachments/rejection
feedback, exact replay, and mobile layout.

The independent C4 profile uses project `antnest-lifecycle-436be050`, with evidence
in `.cache/c4-browser-2026-09-21T13-47-37-655Z/`. All eleven browser groups pass:
real Tools, two-page metadata, attachments/capability rejection, approvals,
cross-Session cancellation, offline/close-reopen replay, Rebuild, mobile,
revocation and privacy. All ten saved traces pass the existing topology checks,
with zero missing parents. Four strict timing failures remain (-1.102588 ms,
87.136 µs, 288.481 µs and 315.277 µs calculated clock deltas); exit 1 is retained.
The intentional held-model cancellation keeps its existing separate diagnostic
handling and two model/HTTP error spans. It is not counted as a strict success.
All six C4 screenshots were inspected, including the in-progress offline Rebuild
state and the post-revocation login screen. The subsequent current Run and retained
bytes are verified by the browser scenario's assertions.

Independent cleanup confirms both owned projects have no remaining containers,
volumes or networks. Twelve retained development containers preserve IDs, images,
mounts, networks, start times and restart counts. All twelve run; all eleven
configured health checks are healthy. No verification or Chromium child process
remains. No service image is rebuilt or deployed.

Source-hash comparison confines implementation changes to the control module and
its test. The retained validator and its test body match the pre-change snapshot
exactly; no executable `waitForFinish` references remain. Formatting, local links
and `git diff --check` pass. Private coordinator and owned-profile evidence use
directory/file modes 700/600. All six strict timing failures remain recorded;
this is not a full strict platform acceptance pass.

The subsequent [retained seed retirement](retained-seed-retirement.md) rejects
`KEEP_STACK=true` before setup. Its now-unreachable inline tail/final helper
consumers and separation of current interruption helpers from historical
abrupt-crash diagnostics remain separate cleanup work. This browser batch does
not remove or redeploy retained development resources.
