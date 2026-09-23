# Antnest Platform Agent Policy

The coordinating agent owns Git state, verification, Docker, browsers, network
services, credentials, and shared processes. Verification commands run
serially and must leave no child processes behind after interruption.

Delegated agents may inspect the repository. A delegated writer must be given
one explicit, disjoint write set and one mechanical transformation. It must not
run tests, builds, generators, Docker, network calls, or Git operations. The
coordinator reviews every delegated change and runs all admission checks.

New behavior is developed test-first. A stage is complete only when its unit,
contract, component, and applicable Docker E2E evidence passes.

Large features must be split into service-owned delivery batches followed by
an explicit integration batch. Define the shared contract first, then change
one owning service with its documentation and tests at a time. Record pending
consumer work instead of editing multiple service implementations in one batch.
Run cross-service integration after the service batches have passed their local
gates; do not describe one completed producer as a complete business workflow.

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
