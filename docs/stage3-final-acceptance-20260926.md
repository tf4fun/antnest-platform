# Stage 3 current-service final acceptance

Date: 2026-09-26. **The implemented single-node Stage 3 service scope passes
final functional acceptance with the previously reviewed Trace clock-warning
exception.** Original strict Trace exits remain nonzero; this is not a
zero-warning strict Trace pass. The scope and exception are defined in the
[current-service closeout](stage-3-current-services-closeout.md). Planned new
services belong to Stage 4. Non-local deployment and real screen-reader
validation remain deferred by the user's stated scope.

The service candidate is source commit
`5c14f12b0eb734f56cb9e11ff070ea422a40741e`. Ten local service-image IDs
were frozen in the private
`artifacts/verification/final-regression-20260925/candidate-environment.json`.
The subsequent working-tree changes repair only test sources, the serial suite
checker, and documentation; they do not alter service binaries. The final
Docker comparison confirms the same image IDs. The acceptance changes are
recorded in the commit containing this report; the image-build source remains
the service candidate commit above.

## Final evidence

| Gate | Result and evidence |
| --- | --- |
| Serial Docker integration | The 32-entry initial inventory completed with a resource/image comparison for every entry. Business and applicable topology checks passed in 31 entries. The old `workspace-browser` script still expected a direct ACP WebSocket and failed against the current Agent UI. It was replaced by the current HTTP/SSE C4 runner and rerun: 11 browser business/privacy checks passed, 10 Trace reports collected, cleanup verified. The separate C4 entry also passed those 11 checks. Evidence: `artifacts/verification/final-regression-20260925/integration/suite.result.json`, `artifacts/verification/c4-browser-2026-09-25T14-24-23-436Z/report.json`, and `artifacts/verification/final-regression-20260925/after-workspace-browser-alias.json.comparison.json`. The original failed result remains preserved. |
| Service and contract checks | ACP unit/integration and official SDK audit, Stage 2 fixtures, Console component tests, and Agent UI server/logic/component tests passed. The serial suite checker now rejects the Foundation failure text that the first matrix missed. Its 13 suite/catalog/manifest tests pass. Evidence: `artifacts/verification/final-regression-20260925/service-tests/suite.result.json`. |
| Go race and static checks | Runtime Controller, Identity, Agent Controller, Admin Console, and Edge Gateway Go race checks passed. The database-free Identity run skipped its database cases by design; those were exercised in the database gate below. `make go-lint`, `make node-lint`, `make fmt-check`, and `git diff --check` passed after the recorded test-source corrections. Evidence: `artifacts/verification/final-regression-20260925/runtime-controller-race-authorized.log`, `go-race-post-reboot/`, `go-lint-repeat.log`, and `node-lint-repeat.log`. |
| PostgreSQL/Temporal and image checks | The complete `make test-postgres` gate passed: Egress 7, Runtime Controller 202, ACP 249 across 33 files, Identity 143, and Agent Controller 548 tests, with no failures. The separate ACP persistence opt-in and Runtime moved-image contract checks passed. The dependency project reported `cleanup=true`. Evidence: `artifacts/verification/dependencies/postgres-1790352856-71056.result.json`, `artifacts/verification/final-regression-20260925/database-post-reboot/`, and `runtime-image-contract-post-reboot/`. |
| Resource accounting | The interrupted pre-reboot database project was identified by its own Compose label and removed. Docker then had the original 12 retained containers, 285 volumes, and 14 networks. The reboot regenerated only the default `bridge` network ID. A new post-reboot baseline was saved; final comparison reports unchanged retained containers, resources, and image IDs. Evidence: `artifacts/verification/final-regression-20260925/post-reboot-comparison.json.comparison.json` and `after-database-post-reboot.json.comparison.json`. |

## Trace disposition and limits

The integration matrix's original exit code was 1; most profile commands
returned nonzero for strict Trace warnings, and the original Workspace Browser
entry was a real business failure. The fixed Workspace Browser rerun passed its
business checks. Stage 2 reported all nine business scenarios passed, zero
structural failures, and 38 strict Trace failures. C4 reports
`status=browser_passed`, `strict_trace=failed`, and `cleanup=verified`. Its saved
warnings are in the reviewed `clock skew adjustment disabled` class; successful
Runs have no error spans. No original strict exit or diagnostic is rewritten.

The raw diagnostic audit found the warned parents present in the inspected
successful profiles. It does **not** cover every profile's raw Trace: some
artifacts use layouts the audit scanner did not resolve. The ACP SIGKILL fault
case has 28 missing parent references and remains a separately scoped forced
termination diagnostic, not a normal-run clock exception. The C4 raw reports
were checked separately. Evidence:
`artifacts/verification/final-regression-20260925/trace-diagnostic-audit.json`
and both C4 reports. A new missing parent, unexpected error span, privacy
leak, failed business check, or new warning category is not accepted by this
decision.

The host restarted during the first database run. That run has no completion
record and is not counted as a pass. After the restart the Go race and full
database gates were rerun successfully, and the independent dependency stack
was cleaned. The original pre-reboot environment snapshot remains in private
evidence to preserve the interruption history.
