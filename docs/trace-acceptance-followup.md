# Trace acceptance follow-up

Date: 2026-09-17. This follows the
[raw-span diagnosis](trace-error-span-diagnosis.md) and the decision to keep
SIGKILL recovery separate from normal-request Trace completeness. Scope is
expected Docker absence, P2 crash diagnostics and completed-request export
waiting. P1 database errors, Runtime unknown-effect errors and clock warnings
are not rewritten or suppressed.

## Runtime Controller batch

The initial workspace lookup in EnsureStorage and initial container lookup in
Create now mark a successful HTTP 404 response as `antnest.outcome=absent`.
The wire status stays 404, span status stays unset, and no error event is added.
The expectation is local to those Docker GETs. Required-resource checks,
post-create verification, other peers/methods, HTTP 5xx and transport/body
failures retain their previous semantics.

The service contract preceded tests and implementation. Real HTTP component
tests first reproduced erroneous ERROR status for expected absence and then
passed, including a post-create 404 that must remain an error. Transport tests
cover the negative cases. Full service race tests with a disposable PostgreSQL
database passed, and golangci-lint reported zero issues. The first full run had
an unresponsive monitor test process; it was terminated, the rest of the run
and database cleanup completed, and both the isolated monitor rerun and a
complete service rerun passed. No monitor code changed.

The independently tagged image is
`antnest/runtime-controller:expected-absence-20260917`, image ID
`sha256:d994b5e92363cb630ae9b6bc3d64bc8deee64fc93bfd26cf257e54d10f6b1c3d`.
The retained development deployment and the normal local image tag are not
replaced. Local evidence is in `artifacts/verification/acp-persistence-20260917/` under
`runtime-absence-*`.

## Fixture integration contract

P2 remains opt-in through `make e2e-acp-restart`. The normal `make test` target
runs its fixture unit/component tests, without killing a deployed service.
Six deliberately interrupted requests now report `strict_trace=not_applicable`
and actual diagnostic completeness. Missing trace data is reported as
unavailable. Errors and missing parents are inventoried together; no parents
are fabricated. Wrong identities, malformed data, privacy violations and
backend request failures are still rejected. Recovery, exact replay, effect
protection, observed process death and physical Runtime replacement remain
mandatory assertions.

Completed setup, execution, replay and rejection traces must pass their actual
topology/protocol/privacy inspection before being archived and before another
SIGKILL. Collection polls with a bounded timeout; it does not infer completeness
from a fixed sleep or an unchanged partial span set. Their strict warning/error
checks and all lifecycle checks remain active.

The lifecycle inspector verifies both new absence semantics and subsequent
successful allocation/start, with tests rejecting missing allocation or an
incorrect outcome. Historical ERROR probe traces still retain their original
strict failures. Only the base and P2 isolated Compose profiles can select the
new Runtime Controller candidate with `ANTNEST_E2E_RUNTIME_CONTROLLER_IMAGE`.

The affected fixture regression passes 57 tests, including real HTTP
trace-not-found versus backend-error responses. Re-evaluation of the six saved
P2 interruption traces reports six diagnostic traces, all six Runtime error
spans and all 49 missing-parent edges; the old raw evidence and old results are
preserved.

## Normal lifecycle integration

Project `antnest-stage3-e2e-15658` passed the normal default flow without SIGKILL:
Create, Disable, Enable, Rebuild and Delete; v1 WebSocket, v2 WebSocket and v1
HTTP requests; credential rotation, retained workspace and logout revocation.
All 34 request/lifecycle topology checks passed. Four real expected-absence
404 spans have unset status and successful allocation proof; Docker probe ERROR
count is zero. Strict Trace still fails on 19 warning traces, which are outside
this change. The profile retains its nonzero result for those warnings.

Evidence is in `artifacts/verification/stage3-base/antnest-stage3-e2e-15658/` and
`artifacts/verification/legacy-acceptance-20260917/base-docker-8.log`. Cleanup verified zero owned
resources or verification children, with the retained 12-container baseline
unchanged, before starting the separate crash-recovery regression.

## Independent crash-recovery integration

Project `antnest-stage3-e2e-16578` passed eight recovery cases, 16 Runs, 18 exact
replays, two protective rejections and two physical Rebuilds. All 44 completed
request/lifecycle topology checks passed. Four expected Docker absence probes
have successful allocation evidence and zero probe ERROR spans. Six interrupted
requests are explicitly diagnostic with no evidence-assessment errors; their
six Runtime `outcome_unknown` spans and 45 missing-parent edges are preserved.
The number of interrupted edges differs from the earlier run because crash-time
export is not guaranteed.

The remaining strict failures are the 21 warning traces among completed
requests/lifecycles. The profile returns nonzero for those warnings, not for
the six diagnostic crash traces. The business and topology outcomes do not
claim full strict acceptance. P1 error semantics remain unchanged.

Private evidence is in `artifacts/verification/acp-restart/antnest-stage3-e2e-16578/` and
`artifacts/verification/legacy-acceptance-20260917/restart-docker-5.log`. All resources belonging
to this and prior P2 attempts are gone; no verification children remain and the
retained 12-container baseline is unchanged. The isolated candidate has not
been deployed to the retained stack. No shared legacy assets were retired.
