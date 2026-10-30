# Antnest Platform Agent Policy

The repository-wide delivery queue and current handoff are in `TODO.md`.
Read the active batch and relevant dependencies before selecting issue work,
and update its status and evidence when a batch is reviewed or merged.

The coordinating agent owns Git state, verification, Docker, browsers, network
services, credentials, and shared processes. Verification commands run
serially and must leave no child processes behind after interruption.

Delegated agents may inspect the repository. A delegated writer must be given
one explicit, disjoint write set and one mechanical transformation. It must not
run tests, builds, generators, Docker, network calls, or Git operations. The
coordinator reviews every delegated change and runs all admission checks.

New behavior is developed test-first. PR admission requires the affected
services' unit, contract and component checks. The required Integration
checks status includes those selected service checks. Docker E2E is
post-merge system integration evidence, not a PR merge gate.

Docker E2E scenarios, execution, acceptance, and failure follow-up belong to
a dedicated workflow, not the development agent. Unless explicitly assigned
by the user, do not add or maintain those scenarios, arrange or run them,
wait for or poll their results, or take on their failures. Do not list pending
Docker E2E as development-agent follow-up or mark service development and PR
delivery incomplete because of it; hand off relevant context when needed.
This does not exempt required service unit, contract, or component checks,
including Docker-backed PostgreSQL or Temporal component checks. CI triggers
and release-capability criteria remain unchanged, and unexecuted E2E must
never be reported as passed.

Every CI suite has one kind: `component` suites gate pull requests, `system`
suites run on main, and `stress` suites run nightly. Do not use the retired
Tier A/B/C terms.

`main` is the system integration branch, not a release branch. A main push
builds a version set and runs the independent system E2E workflow; a newer
main push cancels the superseded run. Failures remain failures and feed
fix-forward work without automatically freezing other PR merges. A full
passed main system run means that version set is release-capable; CI does
not tag or publish releases. Stress suites (such as 100 readiness rounds)
run only nightly and are never release evidence. An `e2e` label or explicit
manifest dispatch runs independent E2E. Only release images enter GHCR:
test images are built in each run, and PR artifacts never enter the trusted
registry namespace or qualify as release evidence. Partial/manual PR results
do not establish release capability.

Use remote CI as the complete merge gate. Local verification is for targeted
failure reproduction and focused development feedback; do not duplicate the
complete CI suite locally before waiting for the remote checks. Review the
remote evidence for the exact candidate commit before merging.

Large features must be split into service-owned delivery batches followed by
an explicit integration batch. Define the shared contract first, then change
one owning service with its documentation and tests at a time. Record pending
consumer work instead of editing multiple service implementations in one batch.
The explicit integration batch covers required contract/component integration
and handoff after the service batches' local gates. Docker E2E remains with
the dedicated workflow; do not describe one completed producer as a complete
business workflow.

Focus delivery work on logic owned by Antnest services. Confirmed external SDK
issues are non-blocking: retain their diagnostics and continue internal-service
and business acceptance without adding SDK investigations or workarounds.
This rule supersedes earlier SDK timing investigation deferrals.

Span and Trace collection and inspection are auxiliary diagnostics only. They
must not block CI, delivery, or merging. Retain raw findings and report warnings
for unavailable collection, missing spans, topology, and timing assertions.
Keep business results, authorization, persistence, Runtime behavior, capacity
deadlines, and actual resource cleanup as independent blocking checks. Continue
those checks after diagnostic failures; never count unexecuted business checks
as passed. This policy supersedes historical strict Trace admission requirements.

## Test source and evidence storage

Never author, stage, or keep project test scripts, fixtures, source snapshots,
test manifests, recovery inputs, or verification evidence in `.cache/`.
It is not a transfer directory for files that must survive cache deletion.
Service unit tests belong in their service; integration and E2E sources belong
in root `tests/integration/` and `tests/e2e/`; shared tooling belongs in
`tests/support/`. Verification logs, screenshots and CI run artifacts are
temporary debug/process output, not permanent archives: keep only the minimal
active-batch logs in `artifacts/verification/` (excluded from Git and Docker
build contexts) until the remote PR evidence is confirmed, then delete them.
Unique uncommitted-code backups (patches, diffs, sole-source recovery inputs)
are kept separately from run output and are not discarded with it.

When recovering a cached test source, verify its destination and preservation
record, then remove that individual cache original immediately. Do not leave
old copies in `.cache` under a historical/snapshot exception. Review historical
assertions and retain necessary source/history outside the cache.
Only reproducible dependency/compiler caches may remain in `.cache`.
