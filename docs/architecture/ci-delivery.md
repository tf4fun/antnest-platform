# CI delivery model

## PR / main / release

- **PR admission**: the required `Integration checks` status runs the component
  gate — affected services' unit, contract and component checks — selected by
  `tests/support/ci-impact.mjs` + `ci-changes.mjs` (`--scope component`).
- **`main`** is the system integration branch, not a release branch. A main
  push builds a complete version set and runs the independent `e2e.yml`
  system workflow; failures feed fix-forward work without freezing other PR
  merges. A newer main push cancels the superseded in-progress system run,
  because stacked PRs for one issue often merge together; a cancelled run
  records `conclusion: "cancelled"` and opens no tracking issue. Nightly and
  manifest replays run to completion. An `e2e` PR label or
  `workflow_dispatch` runs the same E2E on demand.
- **Nightly stress**: the schedule (or a dispatch with `scope: stress`) runs
  only the `stress` suites, currently `stress-agent-readiness` with 100
  readiness rounds; main's system `c-agent-readiness` runs three. A stress run
  is never release evidence, and its failures go to a separate tracking issue.
- **Suite kinds**: every catalog suite has one `kind` — `component`,
  `system` or `stress` — and jobs are named `Component / …`, `System / …` or
  `Stress / …`. The former Tier A/B/C terms are retired; the `a-`/`b-`/`c-`
  id prefixes are historical identifiers only.
- **Release capability**: a full-scope, passed main system run records
  `e2e_passed=true` and `release_eligible=true` next to its
  `version-manifest`: that version set can be released from main. A full
  manual replay of a valid main manifest qualifies the same way;
  partial/PR results never do. A release uses the manifest's exact
  `package@sha256` release image digests. CI does not create releases or
  tags.

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

- Only the ten service and Runtime release images are published to GHCR,
  and only from main. Test images — the Temporal dependency and the Runtime
  test variants — are never registry packages: every run that consumes a
  manifest builds them from the manifest revision and loads them from that
  run's `docker save` artifacts. The manifest records them as
  `antnest/<name>:local` with `build: true`, and validation rejects any
  registry reference for them. PR images also travel as artifacts with
  `persist-credentials: false`; they never enter the trusted registry
  namespace or qualify as release evidence. PR label state persists across
  pushes.
- `version-manifest` + `result.json` artifacts carry the frozen manifest
  and the `e2e_passed` scope; manifest `workflow_dispatch` accepts a JSON
  manifest only with main ancestry.

## Remaining follow-ups (#361 stays open)

- Legacy auth runners still `docker compose up --build` from the same
  revision (controller/console/gateway/identity, runtime-controller
  fixture) instead of the manifest's release digests; `candidate-images.mjs`
  derives the others from provided images.
- Root `Repository checks` still runs full tooling/fixture tests; the
  ≤15-minute target must be measured remotely — it is not promised.
