# Test layout migration

Date: 2026-09-22. Status: **main directory migration and its scoped verification
complete; full cache-source exit and its scoped assertion verification are also complete**.
The user requested a repository-wide
layout: service unit tests remain within services, integration and E2E tests
move to root `tests/integration` and `tests/e2e`. This includes recovering active
verification code that was incorrectly kept only under ignored `.cache` paths.
The preceding timeout/failure changes remain part of the working tree.

## Delivery batches

1. Define root test ownership, inventory sources and recover shared verification
   infrastructure. Keep executable sources separate from private evidence.
2. Move root acceptance assets and preserve their Make, Compose and Docker
   entry points. Production initialization scripts stay in `scripts/`.
3. Move each service's external-dependency, browser and deployed acceptance
   sources, updating that owner's test/build configuration and documentation.
   Keep pure unit tests in the owning service. Preserve private package access
   without changing production interfaces.
4. Recover unique active cached scenarios, deduplicate their helpers and remove
   machine-specific inputs. Historical snapshots and obsolete implementations
   remain evidence; they are not restored as current tests.
5. Run root integration and representative deployed E2E gates, audit all imports
   and entry points, and record exact resource/retained-environment comparisons.

Stages are not complete until their relevant checks pass. A moved file or one
passing producer is not evidence that all consumers or workflows are accepted.
Cache originals are now removed individually only after their destinations and
preservation records have been verified. No retained-service deployment or data
reset is included.

## Initial inventory

The shallow cache audit found 134 script files across 36 task directories,
representing 73 distinct contents. This includes repeated runners, historical
snapshots, diagnostic one-offs and active acceptance drivers; it is not a count
of independent current test cases. Root Make E2E scenarios and service unit tests
already have versioned sources. The cache-only gap affects orchestration,
environment checks and some retained-deployment acceptance drivers.

The [cache inventory](cache-test-inventory.md) records all 134 dispositions,
including historical snapshots and one-time deployment or recovery actions.
The identified reusable cache-only sources have formal tools and configured
drivers below; historical snapshots retain their original evidence scope.
The inventory maps file ownership, not every original assertion to an equivalent
formal test. The subsequent recursive audit and remaining assertion-equivalence
limits are recorded in the cache inventory; this report does not establish that
every cached test assertion has been migrated and revalidated.

## Source mapping

The following source moves and entry-point updates are implemented. File counts
describe moved assets, not passed test cases. Source-preservation, default Go
entry-point, Python cleanup and final environment checks have completed.

| Source group | Current location and mapping |
| --- | --- |
| Root acceptance assets | Seventeen former scenario directories and nineteen E2E shell entry points now live under `tests/e2e/`, retaining scenario names and shell entry names. Make, Compose and Docker consumers point to the new paths. |
| Root Temporal, deployment and shared checks | Deployment checks live under `tests/integration/deployment/`, with Temporal checks in its `temporal/` directory; production Temporal initialization/deployment assets remain owned by `scripts/temporal/`. Shared execution, dependency and evidence tools live under `tests/support/`, with verification helpers in `tests/support/verification/`. |
| Go integration and deployed sources | Runtime Controller 9, Agent Controller 64, Identity 11, Admin Console 1 and Edge Gateway 2: **87 sources** moved to the corresponding root Go integration/E2E trees. Overlays preserve package identity and private-symbol access; service unit tests remain in their service. |
| ACP TypeScript and JavaScript acceptance | The first batch moved 35 TypeScript tests and 18 MJS assets. A further ownership review moved 12 TypeScript tests and four exclusive helpers. The final TypeScript set is **47 tests and four helpers**, with integration and deployed SDK/Stage 2 entry points under the matching root trees. |
| Rust Egress | Five external-dependency test sources now live under `tests/integration/runtime-egress/`; the service's Cargo test configuration points to them. |
| Rust Runtime | Ten integration sources now live under `tests/integration/antnest-runtime/`. The independent elicitation SDK probe package, comprising three source/manifest assets, is under its `sdk-probes/` directory. Python 3 E2E/fixture assets live under `tests/e2e/antnest-runtime/`. Cargo paths preserve the owning package without exposing production APIs for tests. |
| UI and service acceptance scripts | Agent UI 2, Admin Console 5, Edge Gateway 1 and Runtime Controller 3 scripts moved to their corresponding root integration/E2E directories. Synthetic-backend browser checks are integration tests; deployed browser, shutdown and lifecycle drivers are E2E assets. |
| Cache execution and evidence utilities | Repeated command/profile/queue wrappers map to `run-command.mjs` and `run-suite.mjs`; dependency wrappers map to `dependencies.mjs`. Environment comparison, log summaries, Trace audit, link checks and crash-Trace reinspection have formal implementations under `tests/support/verification/`. |
| Cache retained-environment scenarios | Seven parameterized drivers now live under `tests/e2e/development/`: Agent state, replay, chat Trace review, ordinary lifecycle, Runtime loss, metadata browser and rejection Trace review. They are explicit configured entry points, not default runs against the retained development stack. |
| Cache historical assets | Old source snapshots, one-time investigation collectors, completed recovery and candidate-specific deployment/final-check scripts remain historical evidence. Their original database/workspace snapshots are upgrade evidence, not new default regression tasks. The old idle-restart assertions have current shutdown-scenario coverage. |

See [platform test ownership](../tests/README.md),
[verification tools](../tests/support/verification/README.md) and
[development driver configuration and effects](../tests/e2e/development/README.md)
for current invocation boundaries. The ordinary and Runtime-loss development
drivers retain separate business flows; this migration does not rewrite them
into a new shared lifecycle implementation.

The static test-function name multisets match the source baseline (`HEAD` at
audit time), with no names or occurrences lost:

| Source family | Preserved test functions |
| --- | ---: |
| Go Runtime Controller | 206 |
| Go Identity | 143 |
| Go Agent Controller | 548 |
| Go Admin Console | 138 |
| Go Edge Gateway | 100 |
| Rust Egress | 120 |
| Rust Runtime | 148 |

These are source-preservation counts across the relevant service and moved
tests, not a claim that every platform-dependent case ran in one invocation.
The audit also found zero active-source references to the former root-script
locations. Historical reports and snapshots retain their original provenance.

## Verification results

Private command logs and intermediate failures are under
`artifacts/verification/test-layout-migration-20260922/`. Commands run serially. The table records
completed results supplied by the coordinating verification run; it does not
convert pending checks or skipped cases into passes.

| Gate | Recorded result |
| --- | --- |
| Root shared fixture/infrastructure suite | 1,313 passed; five opt-in skips remain visible |
| Shared infrastructure check | 57 passed at the point when the lint helper had three cases |
| Final lint-helper regression checks | Four passed separately after the fourth case was added; red/green defect evidence retained |
| Default Go entry point | `make test-go` passed |
| Go lint entry point | `make go-lint` passed with root integration and E2E sources included in profile `all` |
| ACP unit tests | 809 passed |
| ACP protocol integration | 152 passed |
| ACP PostgreSQL integration | 245 passed |
| ACP SDK audit | Nine passed using its independent audit database |
| ACP production-image SDK Docker regression | All four scenarios passed |
| ACP Stage 2 fixtures | 55 passed |
| Runtime Controller service/database gate | 202 tests and 177 subtests passed; two Docker checks passed separately |
| Runtime Controller crash component checks | Four recovery windows passed |
| Agent Controller | 548 tests and 571 subtests passed |
| Identity | 143 tests and 59 subtests passed |
| Admin Console | 138 tests and 161 subtests passed |
| Edge Gateway | 100 tests and 123 subtests passed |
| Agent UI browser integration | Six viewport checks passed |
| Console browser integration | Both browser profiles passed |
| Console and Edge Gateway shutdown Docker profiles | Both passed |
| Egress | Local gate, ten PostgreSQL checks and Linux gate passed |
| Runtime | 104 macOS tests, one fixture check and three independent SDK probe checks passed; final Linux build passed; ten additional progress checks passed |
| Runtime Python E2E | All ten checks passed again after the anonymous-volume cleanup fix. HTTP-close evidence records nine successful operations with zero disconnect-related error spans on successful operations, and two expected error spans in the failure case: operation and HTTP. |
| Deployed Stage 2 | Business checks passed and structural failure count is zero; 36 strict Trace failures remain, with exit 1 preserved |
| C4 deployed browser E2E | All eleven browser business checks passed and cleanup was verified. Ten traces comprise seven strict passes, two strict failures and one expected cancellation; zero errors and 141 clock warnings were recorded. The two strict failures preserve exit 1. |
| Formatting | Formatting and `fmt-check` passed |
| Node lint and TypeScript checks | Passed |
| Documentation links | 231 documents and 1,309 local links checked successfully |
| Python and shell syntax | All five Python files and all root shell scripts passed their syntax checks |
| Offline evidence tools | Log summary and Trace diagnostic audit completed successfully; historical two-window crash-Trace reinspection found zero missing parents, with strict failures retained |
| Final environment and processes | Original twelve stopped containers, 271 volumes, fourteen networks and pinned images unchanged; zero remaining owned verification processes |

The five root skips are skips, not additional passes. Database, audit and
deployed results retain their own scopes and counts. Stage 2 and C4 nonzero strict
results remain failure records even though their business checks pass.
This is not a full strict platform acceptance claim.

The 1,313-case shared run, earlier 57-case infrastructure run and final four-case
lint-helper run are separate, overlapping scopes and must not be added together.
The offline crash recheck consumed historical saved evidence; it
is not a fresh crash E2E execution.

## Corrections and retained failures

- The first Console shutdown Docker invocation received HTTP 503 before its
  backend was ready. The harness now awaits backend readiness, and the Console
  shutdown profile subsequently passed. The two Console browser integration
  profiles have their separate passing results above; the 503 did not occur in
  those browser profiles. The Edge Gateway shutdown Docker profile also passed.
- Three classes of shared-runner defect were reproduced by red checks and
  corrected to green checks. The default Go entry point and final resource
  comparison subsequently passed their separate gates.
- Go lint now includes root integration and E2E sources through profile `all`.
  Temporary package symlinks are removed in `finally`. Four helper regression
  cases retain red/green evidence, their final targeted run passed all four,
  and `make go-lint` passed.
- The Egress database invocation's `sslmode` query-string composition was
  corrected before its PostgreSQL checks passed.
- The initial ACP SDK audit lacked its required `_audit` database configuration.
  A separate audit database was supplied and all nine audit cases passed. The
  failed initial invocation is retained rather than counted as a test pass.
- The environment check found one new anonymous volume. The twelve containers,
  fourteen networks, pinned images and retained container state were unchanged.
  Inspection traced the volume to Python E2E Jaeger cleanup that omitted
  `--volumes`. Four Docker removal sites now remove their associated volumes,
  and the identified volume owned by this run was removed. All ten Python checks
  passed again, and the final environment comparison restored the exact baseline.
  The failed initial resource comparison remains recorded in
  `environment-after.json.comparison.json`; the passing final comparison is
  `environment-final.json.comparison.json` in this batch's evidence directory.

These are verification and fixture corrections found during the move. Historical
reports retain their original paths, candidates and outcomes; the mapping above
supplies current executable locations without rewriting old evidence.

## Scope at closeout

The main directory migration's entry-point, local gate, representative Docker
and cleanup checks are complete. The subsequent complete cache-source review,
individual archive/removal and final regression are recorded in the
[cache inventory](cache-test-inventory.md) and [cache exit report](cache-source-exit.md).
Historical assertion/evidence limits remain explicit; source removal does not
convert missing historical evidence into a newly passed acceptance. Stage 2 and C4 strict Trace results remain
failed under the existing timing deferral; they are not converted into passes.
The seven configured development drivers have moved source and documented effects; this
report does not claim a fresh successful execution against a retained environment.
No retained-service deployment, data reset or blanket cache deletion is part of
the directory migration. The working-tree changes have not been committed.
