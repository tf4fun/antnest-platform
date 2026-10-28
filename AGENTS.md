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

`main` is the system integration branch, not a release branch. A main push
builds a version set and runs the independent system E2E workflow; failures
remain failures and feed fix-forward work without automatically freezing
other PR merges. Nightly retains 100 readiness rounds; normal system runs
use three. An `e2e` label or explicit manifest dispatch runs independent
E2E. PR artifacts never enter the trusted registry namespace or qualify as
release evidence. A frozen release must use a complete passed main version
manifest; partial/manual PR results do not establish a release.

Use remote CI as the complete merge gate. Local verification is for targeted
failure reproduction and focused development feedback; do not duplicate the
complete CI suite locally before waiting for the remote checks. Review the
remote evidence for the exact candidate commit before merging.

Large features must be split into service-owned delivery batches followed by
an explicit integration batch. Define the shared contract first, then change
one owning service with its documentation and tests at a time. Record pending
consumer work instead of editing multiple service implementations in one batch.
Run cross-service integration after the service batches have passed their local
gates; do not describe one completed producer as a complete business workflow.

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
test manifests, recovery inputs, or lasting verification evidence in `.cache/`.
It is not a transfer directory for files that must survive cache deletion.
Service unit tests belong in their service; integration and E2E sources belong
in root `tests/integration/` and `tests/e2e/`; shared tooling belongs in
`tests/support/`. Durable private evidence and backups belong in
`artifacts/verification/`, excluded from Git and Docker build contexts.

When recovering a cached test source, verify its destination and preservation
record, then remove that individual cache original immediately. Do not leave
old copies in `.cache` under a historical/snapshot exception. Review historical
assertions and retain necessary source/history outside the cache.
Only reproducible dependency/compiler caches may remain in `.cache`.
