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
