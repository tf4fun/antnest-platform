# CI delivery model

## PR / main / release

- **PR admission**: the required `Integration checks` status runs the component
  gate — affected services' unit, contract and component checks — selected by
  `tests/support/ci-impact.mjs` + `ci-changes.mjs` (`--scope component`).
- **`main`** is the system integration branch, not a release branch. A main
  push builds a complete version set and runs the independent `e2e.yml`
  system workflow; failures feed fix-forward work without freezing other PR
  merges. An `e2e` PR label or `workflow_dispatch` runs the same E2E on
  demand. Nightly retains 100 readiness rounds; normal runs use three
  (`ANTNEST_E2E_READINESS_ROUNDS`).
- **Release**: a complete _passed_ `version-manifest` artifact with
  `origin: "main"` and a full-scope `e2e_passed` result is _system
  integration evidence only_ in this first rollout. Release certification
  additionally requires the remaining legacy source-build runner migration
  to be complete and `release_eligible=true`. A full manual replay of a
  valid main manifest can also serve as system evidence; partial/PR results
  never qualify. A release cut verifies full scope, passed status, main
  origin, matching revision, then pins the manifest's exact
  `package@sha256` digests. No release creation is performed by CI.

## Selection and ownership

- `tests/support/ci-ownership.json` registers every `contracts/<dir>` —
  producer service first, declared consumers after. `ci-impact.mjs --check`
  (in `ci.yml`) rejects unregistered contracts, unknown services and
  uncovered internal callers. Registration validates declared callers only;
  compatibility tests remain service-owned.
- Dependency-aware selection: contract changes expand to their owners,
  shared helpers expand through the static reverse reference closure, and
  unreferenced production helpers fall back to a conservative all-suite
  selection. `Makefile` changes are conservatively global — proven
  target narrowing is deferred until prerequisite ownership is handled.
- Integration required `needs` includes all ten `unit-<service>` reusable
  jobs; `SERVICES` from the selector drives each job's condition and the
  gate validates results (selected→success, unselected→skipped).

## Images

- Main builds publish every resolved image to GHCR (`--registry-images`
  makes all image types registry-eligible; variants included). PR images
  travel as `docker save` artifacts with `persist-credentials: false` —
  an explicit exception; they never enter the trusted registry namespace
  or qualify as release evidence. PR label state persists across pushes.
- `version-manifest` + `result.json` artifacts carry the frozen manifest
  and the `e2e_passed` scope; manifest `workflow_dispatch` accepts a JSON
  manifest only with main ancestry.

## Remaining follow-ups (#361 stays open)

- Legacy auth runners still `docker compose up --build` from source
  (controller/console/gateway/identity, runtime-controller fixture);
  `candidate-images.mjs` derives others from provided images. Pure
  manifest-only certification is not claimed until this migration finishes.
- Root `Repository checks` still runs full tooling/fixture tests; the
  ≤15-minute target must be measured remotely — it is not promised.
