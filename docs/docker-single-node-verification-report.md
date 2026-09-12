# Docker Single-Node Verification Report

Date: 2026-09-11. Status: **Docker single-node closeout accepted within the
agreed scope; Agent Web UI client acceptance remains deferred**.
The [closeout checklist](docker-single-node-closeout.md) remains authoritative.
This report keeps final measurements and explicit gaps, not intermediate logs.

**User scope decision, 2026-09-11:** Agent Web UI client validation (C4-01..05)
is deferred pending a later product iteration. These checks have not passed;
their absence no longer blocks the current closeout. Server-side ACP/Gateway,
identity, lifecycle, Runtime and operations requirements are unchanged. Admin
Console Runtime-loss recovery and live Jaeger navigation both pass in the
browser batches below.
This decision supersedes earlier dated C4-blocker statements below. Current
accounting is 25 accepted, five explicitly deferred and zero in-scope open items.
Earlier batch statements retain their historical scope; this final accounting
does not claim complete Agent Web UI acceptance or universal ACP conformance.

## Candidate And Environment

- HEAD: `325e8ab7f34eb6c8783bd99fed23ebb51e4fe362`, plus the uncommitted
  closeout working tree. HEAD alone does not identify the tested implementation.
- Latest complete service-regression input fingerprint: 1,180 files,
  `bf902e0e86768af1181d701baff1375adf91782ee9ba95c6660d5c393e4dd5ff`.
  SHA-256 covers sorted tracked/non-ignored paths under `services`, `runtimes`,
  `contracts`, `scripts`, plus root Go manifests, Compose files, Makefile,
  AGENTS policy and Docker/Git/lint configuration. Each entry hashes path,
  kind and byte length separated by NUL, then its bytes; links hash their
  target spelling, and deleted tracked paths have kind `deleted` and no bytes.
  Root report/checklist edits are excluded. This is not a committed Git tree.
- The later trace-verifier increment below has 1,173 input paths and fingerprint
  `ab8a1bb20a74300ca9442802b43c09c6a5cc2ced441735d59431f3f37e241ba1`.
  It changes verification scripts/documentation, not production service code.
  The deployment results below retain their original candidate scope; the
  headline Go/Node measurements are the later full service-suite rerun.
- The OIDC-verifier increment has 1,175 input paths and fingerprint
  `6a97dabd46285b46bf6bd95517512bbac17122035065cb933a729706b3fbef78`.
  It also changes only verification scripts/documentation. Its targeted suites
  and fresh Stage 3 deployment are recorded below; production images are reused
  from the preceding nine-image build, with current fixture scripts mounted.
- The later shutdown increment has 1,180 input paths and fingerprint
  `29e2c3d6f837f24a37a08d8e422dec9157baa310f154a926ecb67f464e435335`.
  It changes Gateway close ordering/cancellation telemetry plus verification
  scripts and documentation. Gateway is rebuilt and its whole race suite rerun;
  its targeted measurements remain in the shutdown section. The headline Go
  coverage now comes from the later complete race/coverage rerun.
- The current candidate additionally fixes Agent UI preview-URL ownership:
  pending effects inspect render-consistent candidates and attachment/history
  references, not newly allocated URLs from a later commit. A deterministic
  layout-effect regression reproduced the premature revocation before the fix;
  the full Node sweep passes afterward. This is not a new browser acceptance.
- The subsequent foundation-fixture correction has 1180 input paths and
  fingerprint `f7c7870e37cdd564c50ea1b414b9fca4fe225fcbfd83f509d9959c411f8e1e7d`.
  It changes the Stage 1 E2E caller, not any production service implementation.
  Its deployed results and final Compose image identities are recorded below;
  it does not imply another Go/Node/Rust unit-suite execution.
- Host: macOS/amd64; Go 1.27.1, Cargo 1.97.1, Node 26.8.1,
  golangci-lint 2.13.2, Vitest 4.1.11. Docker Engine 29.4.0, Compose 5.1.2.
- The Stage 2 caller/ACP fixture connection increment has 1,184 input paths,
  fingerprint `9505aeb3f3e5139854420b061f9247c28e24c35b3c165f2182c37e69e6aa9815`.
  Production services and the nine image identities below are unchanged.
  The changed verifiers pass 23 Stage 2 and 49 ACP fixture tests; these targeted
  results do not replace or inflate the earlier full service-suite counts.
  Rust deployment builds use Linux/amd64 and the pinned Rust 1.96 image.
- The identity-recovery fixture correction has 1,184 input paths, fingerprint
  `52a327467c48a1df93a5c4871da970290fbe45960e2f4a8f4027e784fd467422`.
  It changes only verification helpers/tests/documentation. The nine production
  images and service coverage are unchanged. Its 125 targeted fixture tests
  pass with no skips; format, standard Go lint (zero issues), Clippy,
  ESLint and typechecks pass again. This is not another full service-suite run.
- One disposable PostgreSQL 17 instance, separate service-owned databases and
  roles, random loopback port, tmpfs data, 1 CPU and 768 MiB limit. Agent
  Controller uses a dedicated `_test` database. No retained database or external
  Provider/IdP credential was used. Verification commands ran serially.

## Service Regression

Go results include race detection, uncached execution (`-count=1`), database
component tests and the Runtime Controller's read-only real Docker image test.
All 54 test-bearing packages pass; the other three packages contain no tests.
Counts below are top-level Go tests, not an inflated sum of parent/subtests.

| Go service | Passed | Skipped tests | Statement coverage |
| --- | ---: | ---: | ---: |
| Runtime Controller | 160 | 0 | 66.2% |
| Identity | 126 | 0 | 64.8% |
| Agent Controller | 417 | 0 | 72.2% |
| Admin Console backend | 82 | 0 | 76.3% |
| Edge Gateway | 78 | 0 | 76.2% |
| Total | 863 | 0 | 70.2% |

Coverage is 10,970 / 15,618 instrumented statements from package-local atomic
profiles, not branch coverage or business-flow completeness. Calls from another
package's component suite are not credited by this instrumentation mode. The
complete final Go sweep uses the five service paths in one serial command and
takes 174.415s. No assertion, filter or threshold was weakened. The database
tests use explicit service-owned `_test` databases; no conditional case is
counted as passed merely because its integration environment was absent.

| Node/browser-component scope | Final result |
| --- | --- |
| ACP non-database suites | 59 files, 538 tests pass; 39.75s |
| ACP PostgreSQL/protocol suites | 21 files, 160 tests pass, no skips; 122.16s |
| Console UI | 96 unit + 204 component tests pass; component phase 46.12s |
| Agent UI | 45 unit + 64 component tests pass; component phase 16.22s |
| Deployment and E2E helper assertions | 515 tests pass, no failures/cancellations/skips |

`make test-node` totals 1,462 tests and takes 128.318s; the 160 ACP PostgreSQL
tests are a separate entry point. This replaces the earlier 1,367-test baseline,
not an addition to it. Component tests do not prove actual desktop/mobile browser
behavior. The earlier failing preview-URL sweep is not counted as acceptance.

| Rust scope | Final result and boundary |
| --- | --- |
| Runtime on macOS | 95 unit + 1 fixture tests pass; Linux-only tests are not compiled |
| Runtime Linux/root build | 132 unit + 1 executor CLI + 1 fixture tests actually execute and pass; format, Clippy and release build pass; build command 417.263s |
| Egress on macOS | 94 non-database tests pass; the default entry ignores six PostgreSQL cases |
| Egress PostgreSQL | All six ignored cases explicitly execute and pass; no skips; 5.57s test execution |
| Egress Linux build | 95 non-database tests actually execute and pass; six database cases remain ignored in the build container, covered separately above; format, Clippy and release build pass; build command 224.030s |

Do not add native/Linux counts as if they were different business scenarios.
The Runtime Linux image has the default root build user and no `USER` override;
this matters because its CLI test can return early under a non-root Linux user.
The preview-correction's direct Agent UI build produced image
`sha256:9fa0625d70639b0a730f14c85f0cde476e987db7cb809000c36b3f1448a00655`.
Its build passes in 13.190s. Vite still reports the existing bundle-size advisory
for the 548.10 kB JavaScript chunk; no warning limit was raised. Building the
image does not prove that attachments render correctly in an actual browser.
The subsequent complete Compose build below supersedes these local image tags.

## Commands And Gates

The Go runs set workspace-local `GOCACHE`/`GOMODCACHE`, `GOMAXPROCS=2`, the three
service `ANTNEST_*_TEST_DATABASE_URL` values, and Runtime Controller's Docker
socket/image test variables. Each DSN refers only to its disposable owner DB.
ACP additionally requires `ANTNEST_ACP_TEST_DATABASE_URL`; absence would skip
its PostgreSQL suites. Egress requires both its owner and test-admin DSNs,
pointing to the same disposable Egress DB.

```sh
go test -race -p=1 -count=1 -timeout=300s -json \
  -coverprofile=.cache/closeout/final-candidate.go.cover \
  ./services/runtime-controller/... ./services/identity-service/... \
  ./services/agent-controller/... ./services/admin-console/... \
  ./services/edge-gateway/...
CARGO_BUILD_JOBS=2 RUST_TEST_THREADS=1 make -j1 test-rust
cargo test --manifest-path services/runtime-egress/Cargo.toml --locked \
  --test postgres_repository -- --ignored --test-threads=1
npm --prefix services/agent-acp-service run test:postgres
make -j1 test-node
docker build -f runtimes/antnest-runtime/Dockerfile --target build --no-cache-filter build .
docker build -f services/runtime-egress/Dockerfile --target build --no-cache-filter build .
make -j1 fmt-check lint
```

The Go run covers all five service paths with one atomic profile. The Docker
build steps execute the Rust test
commands rather than accepting a cached `RUN`; dependency/build caches were
reused. Temporary image tags were used for ownership and removed afterward.
Final repository admission passes: Go standard lint reports **0 issues**, both
Rust Clippy gates deny warnings, and configured format/ESLint/typechecks pass.
The root Go profile is `default: standard`: it does not enable cyclomatic or
cognitive complexity linters, so this is **not a complexity-threshold pass**.
No comparable Rust/TypeScript coverage measurement is claimed in this batch.
The final-candidate admission rerun passes after the preview correction:
Go standard lint reports 0 issues, both Clippy runs deny warnings, and all
configured format/ESLint/type checks pass. The documentation check resolves
392 local file targets across 86 Markdown documents; 20 shell scripts pass
syntax checks and `git diff --check` passes. No external URL/anchor validation
or additional complexity threshold is implied.

### Final Docker Regression Boundary

The complete service-suite rerun does not by itself close C6-01. Its required
single-node regression scope is the existing deployed entry points below, not
just their helper tests. Reconcile each result against the candidate's owning
service images and invoked assertions; an equivalent execution may cover an
entry without rerunning it merely under another command name. The historical
deployment increments below remain valid scoped evidence, not an assertion that
all these profiles have just run on the current candidate.

| Deployed scope | Required entry points, reconciled by the results below |
| --- | --- |
| Runtime foundations | `e2e-stage1`, `e2e-runtime-controller`, `e2e-stage2`, `e2e-stage3` |
| Identity and ACP recovery | `e2e-identity-access`, `e2e-acp-session`, `e2e-agent-access`, `e2e-rpc-response-loss`; Stage 3 with `ANTNEST_E2E_ACP_CLOSEOUT=true` |
| ACP user capabilities | `e2e-tool-progress`, `e2e-file-observations`, `e2e-structured-plan`, `e2e-tool-permissions`, `e2e-slash-commands`, `e2e-multimodal`, `e2e-session-cost` |
| Managed MCP | Stage 3 with `ANTNEST_E2E_MANAGED_MCP=true`, separately selecting version `1` and `2` |
| Lifecycle and workspace | `e2e-lifecycle`, `e2e-lifecycle-interrupted`, `e2e-lifecycle-network`, `e2e-lifecycle-loss`, `e2e-lifecycle-shutdown`, `e2e-workspace`; lifecycle `health` and `restore` profiles |
| Process signals | `node services/admin-console/tests/shutdown-docker.mjs`, `node services/edge-gateway/tests/shutdown-docker.mjs` against the final owning images |

Run profiles serially and honor their mutual-exclusion checks; do not combine
incompatible fault scenarios to save deployment time. Each disposable profile
uses one PostgreSQL instance with private service databases. External-network
requirements remain explicit. C6-02's actual browser scenarios, C5-04's page
navigation and C6-04's report are reconciled separately in the final sections.
An independent read-only scope review confirmed this distinction; no new
testing framework or service feature is introduced by the checklist.

### Final-Candidate ACP Capability Regression

These 2026-09-11 deployments use the unchanged nine production images listed
below as their baseline and the `9505aeb3` fixture input fingerprint above.
Tool progress and Tool permissions select the test-only `managed-integration`
Runtime, as do both Managed MCP profiles. It derives from the final Runtime
and adds the managed-MCP fixture; these checks do not assert production Runtime
image identity. The dedicated Managed MCP reruns record fixture image ID
`sha256:635582bc5ea8cff737541dbeb5622836349ff92fb2b328668390da5e2bcdef1d`.
Each profile has its own disposable project, runs serially, and passes cleanup
before the next profile starts.
The model is a controlled protocol peer, not an external Provider. This is
deployed protocol/business evidence, not actual browser acceptance.

| Profile | Verified result | Gateway-rooted traces | Elapsed |
| --- | --- | --- | ---: |
| Tool progress | 12 v1/v2 Bash/managed-MCP success, failure and cancellation scenarios; 20 model requests; no duplicate dispatch on reconnect | 12 execution traces | 91.759s |
| File observations | 16 v1/v2 read/write/edit scenarios; 32 model requests; exact diff/replay and two cross-user rejections | 16 execution plus 16 replay traces; replay has no execution | 119.992s |
| Structured plan | 12 v1/v2 scenarios; 22 model requests; six plan commits, two invalid-plan rejections, two actual Runtime writes; two cross-user and four cross-Agent rejections | Four execution plus eight replay/denial traces | 77.247s |
| Slash commands | v1 WS, v2 WS and v1 HTTP; six command Runs with no model execution; ordinary v1/v2 Tool conversations still pass with four model requests | Nine command/replay/denial plus two ordinary execution traces | 72.395s |
| Multimodal input | v1 WS, v2 WS and v1 HTTP; nine successful Runs/model requests, three local capability failures and six invalid-input rejections; replay and cross-Agent/User isolation pass | Nine protocol/restore/denial traces | 68.621s |
| Session cost | All three transports; 52 model requests; one actual ACP restart, nine restored Sessions; price-version pins, cumulative replacement and cross-Agent/User isolation pass | Eleven usage/recovery plus 19 pricing traces | 134.711s |
| Tool permissions | 26 v1/v2 scenarios: allow/reject once/always, modes, Smart judgments, cancellation and pending-approval reconnect; two cross-user rejections; two owned Agents removed through the API | Two execution traces validate approval-before-dispatch and rejected-call non-execution | 63.123s |

Representative execution trace IDs, in table order, are
`6aa492f1fb4a26b1d7ed4e208b865b77`,
`258c765ba0cdd850c69e1d9aeb098173`,
`b265ca378d3d302dd92f0d56979a4d2b`,
`7da362ffaff58832d5d80273283cdb29`,
`63a7a69a0eeeaed42c85283908976d66`,
`5b6b054930ffb352ccdc29e6fd564aaa`, and
`00c270a5298d6e197af10cf7bac71b21`.
They identify assertions made before the disposable Jaeger stores were removed;
they are not links to retained live traces. All seven ACP user-capability
profiles in the regression boundary have now passed on this candidate. Other
final Docker scopes above still require reconciliation or execution. These
results do not close C4 or C6 as a whole.

Managed MCP stable-v1 and draft-v2 also pass serially on the same candidate.
Each verifies six business phases, 15 model requests, nine actual Tool calls,
and two independently observed drain-worker checkpoints during an admitted Run.
Child reuse, fresh guidance/Skill context, explicit rebuild, retained workspace,
replacement execution identity, second-Session rejection and stale-connection
rejection all pass. The parent Stage 3 local/OIDC/SCIM and lifecycle/workspace
checks also pass, with full project cleanup. Both profiles use the test-only
managed-integration image built from the current Runtime; the production Runtime
image is unchanged.

| Managed MCP profile | Execution traces | Representative trace | Elapsed |
| --- | --- | --- | ---: |
| Stable v1 | Two traces, 1,002 spans | `38471870205dc5b07eff9b8c703e1773` | 118.555s |
| Draft v2 | Two traces, 1,009 spans | `81e6d1a6ec311adad0147a7cbde49efb` | 117.524s |

### Final-Candidate Identity And Recovery Regression

These profiles run serially on the same nine product images. HTTP identity uses
the `9505aeb3` fixture input; the corrected existing-connection, Agent-access and
RPC-response-loss profiles use the later identity-recovery helpers. All results
are service/protocol observations through Edge, not Agent Web UI acceptance.

| Profile | Verified result | Trace evidence | Elapsed |
| --- | --- | --- | ---: |
| HTTP identity access | Same-email organization isolation, SCIM, password/User/token and membership revocation; stopped Identity returns 503 without deleting the Cookie; recovery and actual short-token expiry pass | Two access traces (21 spans), one expiry trace (four spans) | 59.438s |
| Existing ACP connection fault | Both versions: four rejected prompts create no Run, Tool or history; two already-admitted Runs complete; two fresh-login Runs recover; eight model requests | Four denial/replay traces (264 spans), four execution traces (625 spans) | 80.117s |
| Agent access/offboarding | 36 denied management requests, eight denied upgrades, 20 denied Session commands, two membership revocations and nine successful Runs; five automatic Disable operations include global-user and SCIM flows plus consumer restart | 19 access/execution traces (1,952 spans); five offboarding causal chains, with shared source traces not counted as distinct | 149.949s |
| RPC committed response loss | Both versions, acquire and finish: four actual ACP self-exits/restarts, 16 model requests; exact durable retry, single side effect, retained intent and replay without execution | Eight RPC traces (678 spans), four real read-back traces (852 spans); background recovery retries are not mislabeled as new Gateway roots | 88.895s |

Representative traces are `b16d776824ddbdb8a8fd97a9e12c7cca` (HTTP access),
`c9ccb59015d66edefcec000f313f48d7` (expiry),
`b8bd964a4ce51c02ca476a9e34907825` (admitted ACP Run),
`3dd383ba278eb16c751b7d602894fc0c` (Agent access),
`2ecc9cd32288d3adb1b3d506f1ffb600` (offboarding source), and
`312ad983ea9ec09b4a087457020701c3` (committed acquire before response loss).
These are evidence references from disposable Jaeger stores, not live links.

Two discarded ACP-fault attempts exposed an incorrect fixture predicate: it
required every empty-Session notification to be `state_update`, rejecting the
valid command catalog while accepting an empty stream. The caller now reuses
the exact empty-Session verifier, accepting only the required catalog and idle
state while rejecting conversation, Tool or execution history. Same-length
negative cases separately reject running state and a terminal stop reason.
Both identity ACP clients also share the existing bounded SDK request and
WebSocket-close handling; no implicit retry is introduced. The 125 targeted
tests and read-only review cover this correction. This proven fixture issue is
separate from the earlier server-side HTTP 503 whose origin remains unproven.

### Final-Candidate Lifecycle And Operations Regression

These serial profiles use the final production images above as their baseline
and the later identity-recovery verification helpers. Interrupted Runtime
update deliberately derives a temporary image with a readiness barrier from
the final Runtime. Its assertions cover that controlled interrupted startup,
not the unmodified production image's startup timing. Both temporary image tags
are removed after the profile. Each profile succeeds only after its own
resource cleanup. API/protocol recovery does not stand in for the pending
Console Runtime-loss page and live Jaeger navigation checks completed below.

| Profile | Verified result | Trace evidence | Elapsed |
| --- | --- | --- | ---: |
| Lifecycle foundation | Nine operations; ten primary-Agent events and four failed-Agent events; active-Run rebuild drain with actual Controller restart, two accepted/two rejected prompts, same Session and exact Tool effects; failure cleanup, workspace retention/removal, event cursor and restart/idempotency checks | Seven lifecycle causal chains plus two execution traces (428 spans) | 142.388s |
| Real network | Two Agents; six actual TCP/DNS probe phases; deny revokes an existing connection and rejects unsolicited traffic, while the other Agent's existing connection survives; policy CAS/replay, private-target denial and unchanged Runtime identities | Six execution traces (1,098 spans) and four policy traces (40 spans) | 74.293s |
| Runtime loss | Live `runtime_deleted` and cold `runtime_missing`: four successful/two rejected prompts, eight model requests, original Session/workspace retained, zero model calls on history replay and stable Controller restart; explicit rebuild and delete pass | Six lifecycle causal chains plus four execution traces (792 spans) | 93.680s |
| Interrupted Runtime update | Three operations, two forced Controller exits; actual lease expiry precedes recovery; target/workspace reused, two total generation claims/publications (initial plus replacement), exactly one update event and no replay effects | Rebuild admission `8270d7ac77050926323d55f851c8460e`, five exported phase traces plus create/delete chains; killed attempt 3 is explicitly unexported, not fabricated | 221.803s |
| Offline restore | Five owner databases, two persistent volumes and three encryption keys restored after replacing original storage; schema/data/permission fingerprints match, two permission-drift controls pass, five history events replay with zero model calls, one new Tool call succeeds, file metadata preserved | Storage/authentication/protocol assertions; no new trace-count claim | 101.316s |
| Open-stream shutdown/restart | Nine Compose services including PostgreSQL exit zero and restart in the same containers; two Watches close server-side, ACP closes with 1001; same Session, unchanged Runtime and retained workspace recover | Two cancellation/export traces (18 spans), including `5a00311bc08f3f14fa51be2a70843e26` | 55.379s |
| Runtime health/CPU | Initial/restarted healthy at 2.183s/2.177s; steady probes every 10s; two approximately 60s windows measure container CPU 0.4478%/0.4498%, with 96.873% during the three-second calibration; three consecutive failures cause unhealthy, then recovery/restart pass | Actual process/cgroup counters and Docker health observations; not a claim about every service or historical spike | 204.631s |
| Console process signals | SIGTERM and SIGINT, two upstream Watch cancellations, same-container restart, exit codes 0/0 and cleanup pass on the final Console image | Controlled-upstream signal regression, not live Jaeger navigation | Not separately timed |
| Gateway process signals | SIGTERM and SIGINT across four HTTP receive routes; eight upstream cancellations, same-container restart, exit codes 0/0 and cleanup pass on the final Gateway image | Controlled-upstream signal regression; final Gateway image ID independently checked | Not separately timed |

Representative execution traces are `8c4d98e4ead1aae8441c6c9b15e530a3`
(active-Run rebuild), `07e53feacbe2b0d2680f1edd83e5d2b5` (network), and
`c235cf88eacc35ffebc6807693f2bd7b` / `4e383a3a57f77a5484dcbed5abb55cdf`
(live/cold loss). A lifecycle causal chain includes its admission and linked
worker attempts; it is not one trace or an inferred span count. References
identify assertions collected before disposable Jaeger storage was removed.

C6-01 is accepted after this final reconciliation: all deployed entry points
in the boundary have current-candidate results, including the Workspace
integration recorded below. Workspace uses its own ACP helper; the later
identity-helper correction does not change its assertions or owning product
code. Cross-connection cancellation, state subscriptions and recovery are not
deferred with C4. Repository admission, targeted fixture tests, documentation
checks and exact-scope cleanup pass. The read-only boundary review's missing
test-image qualifications are corrected above. The remaining C5-04 page checks
and C6-02/04 were completed in the final browser/reconciliation sections below.

### Docker Foundation Batch

`make -j1 docker-build-stage3` completes in 26.384s, serially building all nine
product images from current sources. Existing build caches are reused; this is
not another uncached Rust test run. Compose export metadata can change an image
ID even when its build steps are cached. The resulting identities are:

| Product image | Image ID |
| --- | --- |
| `antnest/antnest-runtime:local` | `sha256:f9cc91d38c5ae6e59df430e54e6f0e649ca57f5c76e888ae6e23860ebb544ad3` |
| `antnest/runtime-egress:local` | `sha256:fe5f2a553e1df999174342da6a807668372efd32bf87860fe512aa45c5a2ca6f` |
| `antnest/runtime-controller:local` | `sha256:e1acd34e00fd78e6c7f0af3900f37085cc8d0eff6f03495fd6521bb8e51759f9` |
| `antnest/agent-acp-service:local` | `sha256:58ae941442e4ac3d9908d22fc9dcfedb91b6a7856aa34b3bd8375e5d6ff9ef30` |
| `antnest/identity-service:local` | `sha256:5c22f2b51c09382f727f8c82f423da63b74f3ca71cff346c596eebec596aa802` |
| `antnest/agent-controller:local` | `sha256:4fa820f1cdd04a673da4c0e61f3870f52eba3a89f58aa5090d9f287d0c756ddd` |
| `antnest/admin-console:local` | `sha256:d9f57f3b39f61301351af11cdd3d6abc65463fbb38698686af0b6068a64721b1` |
| `antnest/agent-ui:local` | `sha256:2117b794203f3ebdcf97d751525bee5ad63c5ab673b363786aaf03621ecd98c3` |
| `antnest/edge-gateway:local` | `sha256:d137c22dd51130eb9d1f2d59408f4d99c2857b8a4ae2e02958039a182623db51` |

| Profile | Current result |
| --- | --- |
| `sh scripts/e2e-stage1.sh` | Pass, 40.498s, project `antnest-stage1-e2e-44629`. Real write/edit/read/bash, UID/GID 1000, process restart identity, initially closed attachment, open-state control isolation, public IP/domain traffic, deny/allow transitions, Egress restart and closed-attachment network release |
| `sh services/runtime-controller/scripts/e2e.sh` | Pass, 31.942s, project `antnest-runtime-controller-e2e-45339`, explicitly isolated scope `antnest-final-runtime-controller-55c6c9ad`. Initialize, persisted Controller restart/observation cursor, Runtime restart/old-execution 409, update, disable/enable and deletion of compute/workspace |
| `sh scripts/e2e-stage2.sh` | Pass, 58.399s, project `antnest-stage2-e2e-53066`. Distinct administrator/member owner, asynchronous create/delete, actual Runtime write, owner offboarding, original workspace preservation, exact replay, inactive-owner denial and new ACP upgrade 403 |
| `ANTNEST_E2E_ACP_CLOSEOUT=true sh scripts/e2e-stage3a.sh` | Pass, 195.153s, project `antnest-stage3-e2e-53749`. Default Gateway identity/SCIM/OIDC and administrator/workspace flow, plus stable-v1/draft-v2 recovery: 8 actual SIGKILL/restarts, 26 model requests, cross-identity isolation, unknown-effect fencing, explicit rebuild and replay without repeated Tool effects |

The Stage 1 test initially exercised an obsolete caller contract: assigning an
allow policy did not open the separately managed attachment, and release used
the policy-assignment version rather than the network version. The corrected
harness explicitly opens after readiness, retains independent CAS versions,
closes and removes compute before release, and keeps the production default
closed. Review also moved control-plane denial checks after proven public
connectivity and added a real rejection check after open-to-closed transition.
The final result above uses those stronger assertions. It does not by itself
prove established-connection drain or add packet-level tracing. Literal-IP
reachability uses the existing `curl -k`; the domain request verifies TLS.

All successful and failed projects in this batch are cleaned. Independent
checks cover Compose labels, Runtime scope labels and the manually named
Stage 1 Runtime containers; 25 scope/name inventories contain no remaining
resources. Product images and retained development stacks are preserved.
The Stage 1 correction passes repository format/lint/type gates and shell syntax.

The Stage 2 correction changes only its fixture and evidence verifiers. Its
23 reusable tests include adversarial message-order, interleaved-message,
phase-order, cross-trace-link and privacy cases. The final Docker rerun uses
the strengthened verifiers: admission has 8 spans, three ordered workers link
to exact admission/predecessor spans, and the execution trace has 180 spans
across ACP, Controller, Identity and Runtime. Worker trace IDs are
`eb6f0edbc6b2cb631b231724d706a68b`,
`ae08194bd7e2c741495df632da7c28c0`, and
`f33a764c6966df392d05a0369d3f9db4`. This does not claim Stage 3 or browser
acceptance. No production behavior, default network policy or test threshold
was relaxed to satisfy the old caller.

The latest Stage 3 execution verifies four Gateway-rooted Runtime Tool traces
(812 spans): `5f3afc594804f23a20e84b43ea827fad`,
`1ad6890bbbafa4b0c76d1e96c374a25f`,
`0febb6c8c7c465b6ecc22201c2ebb7c0`, and
`3cf2003c62dab7b7ffc39f68e12859bf`. It covers the default Stage 3 entry and
the ACP-closeout profile in the regression boundary, not all other profiles.
An earlier attempt encountered an HTTP 503 whose late WebSocket error escaped
fixture diagnostics. The corrected fixture owns those errors and supplies the
SDK cancellation signal with bounded waits; it does not retry upgrades.
The 503 did not recur in the final run, but its server-side cause remains
unproven and must not be described as a fixed product defect.
Both Stage 2 attempts and both Stage 3 attempts in this increment are cleaned:
24 independent Compose/scope-label inventories contain no containers, volumes
or networks, and no test/lint worker remains. Final repository format/lint/
Clippy/type gates, the 86-file/392-local-target documentation check and
`git diff --check` pass. Reviewers are closed; retained development stacks and
product images are unchanged.

## Deployed Trace Increment

The shared lifecycle oracle replaces the older service-presence verifier. It
requires one exact Controller admission span under Console/Gateway, a connected
Identity call, the complete phase/attempt chain, exact predecessor links, and
terminal state. Create publication also requires its Egress descendant.
Dynamic session/CSRF canaries are checked before and after JSON decoding;
malformed responses cannot expose their body through parser diagnostics.
The helper suite now passes **241 tests** (previously 220), with no skips.
`make -j1 fmt-check lint`, shell syntax and whitespace checks pass again.

All nine Stage 3 images were built from the current service sources before these
serial deployment runs; build caches were reused. The foundation profile also
checks eight application-container image identities against the current tags,
eleven running services and four exact loopback bindings. Its Runtime image is
resolved and compared independently. Each run uses one disposable PostgreSQL
instance with private service databases. OTLP is enabled over HTTP/protobuf to
Jaeger; traces are exported, metrics/log exporters disabled, no sampling override
is set by either launcher. Packet forwarding is outside tracing.

| Profile | Final result |
| --- | --- |
| `node scripts/lifecycle-closeout/run.mjs` | Exit 0; 9 operations, 7 verified lifecycle sequences, 10 main-Agent events, 2 network CAS changes; exact replay, workspace preservation/deletion and failed-start cleanup pass |
| Active-Run rebuild within that profile | 2 completed and 2 rejected prompts; Controller exits 0 while draining; same Session after rebuild, exact physical Tool effects, closed Run admission and connected Runtime spans |
| Final `sh scripts/e2e-stage3a.sh` | Exit 0; 78 local-identity/SCIM requests across 9 check groups; 7 OIDC check groups, 12 authorization attempts/grants; ACP v1/v2 revoked prompts rejected with close code 1008 and empty-session recovery; create phase chain verified |

The final OIDC increment runs in `antnest-stage3-e2e-26484`, using Gateway
44485, PostgreSQL 44484 and Jaeger 44486. The controlled HTTPS IdP records four
Discovery requests, twelve Token exchanges, twelve JWKS requests and one
authenticated UserInfo fallback. Seven selected OIDC traces contain nine exact
outbound spans: four Discovery, two Token, two JWKS and one UserInfo. Each
must be a finished successful client span under the same nearest Identity
server span as its owned persistence. Registration performs Discovery; login
start persists the browser authorization transaction; callback performs the
credential exchange. The profile fallback converges to the same provisioned
User and Membership. No real external IdP/Provider acceptance is implied.

The final targeted suite passes **317 tests** (76 Identity helpers and 241
lifecycle helpers), zero failures/skips, 6.914s. Negative cases reject missing,
client-masquerading and differently named nested server spans, detached/foreign
requests and failed/duplicate/unfinished calls. Gateway/Jaeger/fixture transport
errors omit original errors and nested causes; malformed fixture-canary JSON
and trace responses cannot escape through parser diagnostics. Independent
review findings were reproduced and fixed; the read-only reviewers are closed.

The following are measured diagnostic references, not screenshots or a browser
acceptance claim. The disposable Jaeger stores were removed during successful
cleanup; these links identify the original captures and are no longer live.
Terminal worker links lead back through the verified predecessor/admission chain.

| Scenario evidence | Verified path and trace references |
| --- | --- |
| ID-01 local login | Gateway -> Identity -> owned token repository: [trace](http://127.0.0.1:44486/trace/669721f395b33908b5aa7c41df7f2968) |
| ID-02 registration/start | Gateway -> Console -> Identity -> Discovery/provider persistence: [registration](http://127.0.0.1:44486/trace/c7a409966f760cc65d20fddb8c06289d); separate Gateway -> Identity authorization transaction: [start](http://127.0.0.1:44486/trace/049e1736685013f87891742e7f31e7fd) |
| ID-02 callback | Gateway -> Identity -> Token/JWKS and owned login persistence: [callback](http://127.0.0.1:44486/trace/bf2347affa802cf2752e06b1a0f1a771); Token/JWKS/UserInfo fallback and same User/Membership: [profile callback](http://127.0.0.1:44486/trace/b08a746ff4fb0e1ae63de29d12c4f0cd) |
| ID-03 SCIM | Gateway -> Identity -> owned SCIM repository: [trace](http://127.0.0.1:44486/trace/0ecea6cd2bc8c1a1238aed67819fa3d5) |
| MG-01 create | Gateway/Console/Identity -> Controller admission -> 3 worker attempts with Runtime Controller/Egress descendants: [admission](http://127.0.0.1:44486/trace/06b6d9e98949e6813bdb97e59a4b122c), [terminal publication](http://127.0.0.1:44486/trace/d305a00691af68ac8630c739891c9401) |
| MG-02 delete | Exact admission -> 5 attempts -> terminal deletion, including owned physical resource removal: [admission](http://127.0.0.1:60133/trace/66aad07ec46625fdaf18c55af1ad4bf2), [terminal](http://127.0.0.1:60133/trace/40c9598f6869d267bef192ee44e0dedd) |
| MG-01 startup failure | Admission -> executed phase prefix -> failed Runtime RPC, journal read and persisted failure: [admission](http://127.0.0.1:60133/trace/82b037ba30ee4fac0a47db54c20df9c1), [failed terminal](http://127.0.0.1:60133/trace/702e1ba494c89c56a2159712a4965df4) |
| USE-01/03 service-side rebuild | Gateway -> ACP Run -> Controller admission/model/Runtime MCP -> actual Tool -> completed admission: [held bash](http://127.0.0.1:60133/trace/89dc5fa13e460cb1334537422da05137) (253 spans), [post-rebuild read](http://127.0.0.1:60133/trace/9b48002a94e01d334b2c77e01b8e971c) (175 spans) |

These verdicts cover the stated service-side paths, not whole matrix rows with
UI requirements. The OIDC outbound request-span acceptance gap is closed by
the final controlled deployment, including exact nearest-server ownership.
Credential checks cover the supplied synthetic/session canaries, not arbitrary
unknown secrets. No raw trace dump, cookie jar or service log is retained.

The implemented SCIM/Identity consumer path is covered by the separately recorded
[C2-05 deployment](docker-single-node-closeout.md#c2-05-delivery-docker-integration):
four Gateway source traces and twenty linked Disable phase checks, including
SCIM deletion source `a32c4ba9f81b9bc28140010110f37ff9`. Exact source/receipt,
Agent scheduling, worker links and the Egress/Runtime mutation descendants were
verified; the same profile records five automatic Disables and retained data.
This historical consumer result is not a new execution of the OIDC increment.

## Whole-Platform Shutdown Increment

The final `make e2e-lifecycle-shutdown` equivalent (`node
scripts/lifecycle-closeout/run.mjs shutdown`) passes in disposable project
`antnest-lifecycle-9647902f`. The final Gateway image is
`sha256:c0b2412c3d386bcc58a3b2db350c6964e692193bde6f6ef95f8591a5c787f4ba`.
No model prompt, external Provider, production credential or retained stack is
used. Other service images are unchanged from the preceding deployment.

| Check | Final result |
| --- | --- |
| Live maintenance | Administrator event Watch, owner state Watch and ACP v1 remain open before Compose SIGTERM. Both Watches close remotely and ACP receives 1001; no test-side disconnect is accepted |
| Stop/restart | Eight application services and PostgreSQL exit 0 without OOM or daemon failure. All nine restart in the same containers with later process start times |
| Retained state | Same authenticated cookie loads the same empty ACP Session; no Run/model replay. Agent, dynamic Runtime ID, workspace volume and exact sentinel bytes remain; new Watches recover the same authoritative state/history |
| Traces | Administrator Watch: `601a0c882237f7c1705a7a0b1ca4f379`, 11 spans/4 server spans; owner Watch: `a42139e59c3be6ead258c567520d9da5`, 7 spans/3 server spans. Exact Gateway routes and Identity/Console/Controller ancestry verified |
| Cancellation semantics | Administrator Gateway root records `handler_aborted` plus `antnest.http.request_cancelled=true`, HTTP 200 and completion inside the observed stop window. Owner Watch completes normally. All other span errors fail, including intermediate client/internal spans |
| Reusable checks | 300 lifecycle/workspace helper tests pass, zero failures/skips, 6.249s. Gateway's seven test-bearing packages pass with race detection and uncached execution; no new coverage percentage claimed |
| Final-image signals | Isolated Gateway regression passes SIGTERM and SIGINT, restart, four HTTP receive routes, eight upstream cancellations, exit codes 0/0 and exact-scope cleanup |
| Admission | `env GOMAXPROCS=2 CARGO_BUILD_JOBS=2 make -j1 fmt-check lint` passes: Go 0 issues, both Rust Clippy gates deny warnings, configured formatting/ESLint/typechecks pass. 86 Markdown files / 391 local file targets resolve; `git diff --check` passes |

The real maintenance profile reproduced an abnormal ACP 1006 disconnect because
the relay closed sockets before sending its close frame. The correction sends
bounded close frames first, then cancels/closes and joins the two workers; both
v1 and v2 tests require 1001 at the client and upstream. It does not cancel a
durable Run. Gateway telemetry still reports aborted handlers honestly: the
new marker requires the exact `http.ErrAbortHandler` and cancelled context;
ordinary panics are rethrown unchanged and cannot use this exception.

Read-only review identified a false-acceptance gap in intermediate dependency
span errors. Two failing fixtures reproduced it before the oracle was tightened;
the complete final Docker profile above passes with that stricter oracle.
Reviewers are closed. Diagnostic trace IDs identify removed disposable Jaeger
stores; no raw spans, cookie jars or service logs are retained. This accepts
idle-stream maintenance, not browser behavior, force-killed active Tools or
every ACP transport/version combination.

## Business And Trace Acceptance

### Current-Candidate Workspace Integration

`node scripts/workspace-closeout/run.mjs` passes in disposable project
`antnest-lifecycle-55546ce4` after the full service gates and Agent UI image
build. It uses the current local service tags, controlled model responses and
one PostgreSQL instance with private service databases. It completes two
prompts with five model requests and verifies cross-Session contention,
cross-connection cancellation, one physical effect after offline completion,
replay without model/Tool execution, explicit rebuild with retained workspace,
and owner revocation closing access and disabling Runtime without data deletion.

Gateway-rooted state traces `a3ee2e2a0cd98e03137b24bbcfe081fc` (39 spans) and
`9156a88fc1b381c56c775eaa267c2a16` (27 spans) have attributable Identity checks.
The cancelled Run `356655486820be82610ace55c1692e6d` (170 spans) records an
unknown Tool effect and fenced admission. Completed Runs
`3c92d90d9f5249c8725b437e1c6e72f4` (140 spans, actual `bash`) and
`8dddcca81afcd1f5ff3851af8c55aab5` (178 spans, actual `read`) include Runtime
information/catalog discovery, exactly one Tool call and closed Run admission.
These diagnostic IDs identify the removed disposable Jaeger store, not live
browser navigation. No separate wall-clock duration was captured for this
profile. The runner and independent exact-scope cleanup checks both pass.

Cancellation with unknown effects still requires administrator Disable/Enable;
the profile explicitly reports automatic reuse as a pending product decision.
This result closes the current-candidate deployed workspace regression entry,
not C4 rendering/interaction acceptance or the other C6-01 deployment profiles.

The following is a per-scenario reconciliation, not a claim that the final
Rebuild observation repeats every earlier UI action. Existing C3 browser
acceptance on 2026-09-10 covers all five lifecycle kinds, failed startup and
cleanup, durable operation reload and live Controller recovery; see
[Console lifecycle final evidence](docker-single-node-closeout.md#3-agent-control-workflow-closure-c3).
Current-candidate service/image regression remains the separate evidence above.

| Scenario | Business outcome and evidence | Causal reference | Verdict and boundary |
| --- | --- | --- | --- |
| ID-01 | Local administrator login reaches Console with the correct role; earlier C2/C3 logout and final identity-token/revocation regressions pass | Gateway -> Identity -> owned token repository; `669721f395b33908b5aa7c41df7f2968`, final access `b16d776824ddbdb8a8fd97a9e12c7cca` | Pass; Agent Web UI client observations deferred |
| ID-02 | Controlled HTTPS IdP registration/start/callback, Token/JWKS/UserInfo and same provisioned User/Membership pass | Gateway/Console -> Identity -> Discovery; separate start/callback boundaries; `c7a409966f760cc65d20fddb8c06289d`, `bf2347affa802cf2752e06b1a0f1a771`, `b08a746ff4fb0e1ae63de29d12c4f0cd` | Pass with controlled IdP; not real-vendor interoperability certification |
| ID-03 | SCIM changes preserve organization isolation; revocation denies access and initiates automatic Agent Disable, including consumer recovery | Gateway -> Identity ownership; linked Controller -> Runtime/Egress Disable; `0ecea6cd2bc8c1a1238aed67819fa3d5`, final offboarding source `2ecc9cd32288d3adb1b3d506f1ffb600` | Pass; implemented event flow only, not a generic event bus |
| MG-01 | C3 Console model/Template/create workflow and final foundation profile prove ready compute and immutable executable lineage; actual startup failure remains diagnosable | Gateway -> Console -> Controller admission, linked Runtime Controller/Egress phases; `06b6d9e98949e6813bdb97e59a4b122c`, failure `82b037ba30ee4fac0a47db54c20df9c1` | Pass using prior browser plus current-candidate service evidence |
| MG-02 | All five lifecycle UI kinds were accepted in C3; final foundation checks retention/removal/drain, and the final browser batch below proves Runtime-loss Rebuild recovery | Final browser admission `47760da40218888ff0c841882c71643d` and five linked worker phases; earlier deletion `66aad07ec46625fdaf18c55af1ad4bf2` | Pass; no inference from Rebuild alone to the other commands |
| USE-01 | Final ACP capability and Workspace profiles prove ordered updates, durable history, real bash/read effects and replies through Edge | Gateway -> ACP Run -> Controller admission/model/Runtime MCP; `3c92d90d9f5249c8725b437e1c6e72f4`, `8dddcca81afcd1f5ff3851af8c55aab5` | Pass server-side; controlled model, Agent Web UI deferred |
| USE-02 | Both protocol versions recover/replay without duplicated model/Tool effects; cross-connection cancellation and committed-response-loss recovery pass | Run cancellation `356655486820be82610ace55c1692e6d`; committed acquire `312ad983ea9ec09b4a087457020701c3` | Pass within declared protocol profile; unknown Tool effects remain fenced |
| USE-03 | Identity revocation closes existing access and disables Runtime; explicit rebuild preserves Session/workspace and changes the binding for later Runs | Final admission/execution `b8bd964a4ce51c02ca476a9e34907825`, active-rebuild `8c4d98e4ead1aae8441c6c9b15e530a3`, offboarding `2ecc9cd32288d3adb1b3d506f1ffb600` | Pass server-side; open-page Agent Web UI feedback deferred |
| OPS-01 | Fresh deployment, Runtime loss, interrupted update, offline five-DB restore, open-stream shutdown/restart, health/CPU and scoped cleanup pass; final live pages complete diagnosis/navigation | Shutdown `5a00311bc08f3f14fa51be2a70843e26`, interrupted update `8270d7ac77050926323d55f851c8460e`, final Rebuild and Jaeger views below | Pass for Docker single node; no HA, online atomic backup or universal idle-CPU claim |

Trace IDs refer to the original disposable Jaeger captures. The earlier trace
table includes their diagnostic URLs; the final browser batch includes its
observed URL. Stores were intentionally removed after verification. Existing
causal assertions verify parent/link integrity, relevant ownership and terminal
outcomes, not merely the presence of service names. These nine verdicts close
C6-02; the collected candidate, quantitative, trace and cleanup sections close
C6-04. Read-only scope review found no further in-scope requirement after the
Console recovery observation, and its evidence-boundary corrections are reflected
in this table. The reviewer was closed without executing verification.

The captures above satisfy the required service-side causal paths in
[the observability contract](docker-single-node-closeout.md#5-gateway-rooted-observability-contract).
C6-03 is accepted after coordinator reconciliation and an independent read-only
audit of the recorded results and invoked assertions. This does not accept the
subsequent whole-scenario/browser requirements or constitute a fresh regression
of every final-candidate byte. Local span tests and service-name presence are
not substitutes. Packet forwarding remains outside tracing. CPU attribution
and its measured correction remain in the checklist; no new idle CPU measurement
is claimed here.

Chrome CUA recovered after the browser update and host restart. Live Jaeger
navigation and Console recovery pass below. An initial browser-action approval
block was resolved by explicit user approval for the synthetic-account flow;
it was not a product login failure. Agent Web UI validation and the user-facing recovery decision
after unknown-effect cancellation are now explicitly deferred. The existing
server policy still fences unknown effects and requires administrator recovery.
C5-04 and C6-01..04 are accepted. C4 remains unaccepted but outside this closeout.

### Live Jaeger Browser Navigation

On 2026-09-11 the coordinator used the connected Chrome Browser Use extension
against disposable project `antnest-lifecycle-eb7ac01c`, Gateway port 50674
and Jaeger port 50675. Existing final production images were reused without a
build; the deployment verifier confirmed all 11 services and eight application
image identities. The fixture created one synthetic Agent through Gateway and
checked exact-request replay. Node for this interactive fixture was 26.8.2;
this does not change the tool versions of earlier service regressions.

| Browser action | Observed result |
| --- | --- |
| Look up the create admission by Trace ID | `e204859251a689353353a8c37ed86254`: Gateway-rooted POST, 202, 4 services, 14 spans; Console, Agent Controller and Identity are visible |
| Search `agent-controller` by the exact lifecycle request ID | Three create-phase traces appear, including Runtime initialization and Egress control calls |
| Open Runtime initialization and its root details | `e94a7789e8bffd8b8e0c40a2efed9463`: 22 spans across Agent Controller, Runtime Controller and Runtime; phase `runtime_initialize`, attempt 2, next phase `publish` |
| Expand References and follow the admission link | A new tab opens the original admission trace with `uiFind=9edef69a28ea9011`; the Agent Controller admission span is selected under Gateway/Console ancestry |

The second reference targets predecessor trace
`5b921a77971b74e851a82158cf995343`; the terminal publish trace in the search
results is `0a4be7e8b7e0886834969e8e07acfc46`. The exact request is
`lifecycle-44386c32c404d663ff1c68d91bde0dce350f13b8713d09e5f010f7344c36fcbf`.
These are actual page observations, not a claim that every span is error-free
or a replacement for the existing causal-link assertions. They accept only
the live Jaeger navigation portion of C5-04. The Console Runtime-loss/rebuild
browser scenario is not accepted by this fixture setup or these trace views.
The trace IDs identify this disposable store; they are not promised as permanent
live URLs after cleanup. No screenshot or raw trace archive is added to Git.

### Final Console Runtime-Loss Recovery

After explicit user approval, Chrome exercised the synthetic administrator
flow at `http://127.0.0.1:50674` in a fresh disposable project,
`antnest-lifecycle-f4d7b452`. The coordinator reused the same final images and
existing lifecycle setup/trace/cleanup helpers; no product source changed.
The single test Agent was `agent_0ff50c002f56020d6da496b7b325ae97`.

| Check | Final observed result |
| --- | --- |
| Login and initial page | Administrator session reaches Overview with one available Agent; its detail shows Assigned/Published and live updates |
| Unplanned loss | Coordinator removes only the exact scoped test Runtime. Without reload, the open detail shows `unavailable`, `runtime_deleted`, Runtime missing event 3, Not assigned/Not published, and an available Rebuild action |
| Rebuild from page | Select the existing Template revision in the dialog and submit. The page shows request accepted, a disabled lifecycle action and `running/drain`; this is not counted as completion |
| Completion from live updates | Page reaches `available`, Assigned/Published, last operation `rebuild/completed` and Rebuild completed event 5. The old missing-Runtime alert disappears; lifecycle actions return |
| Independent physical/business assertions | Replacement container differs, the same owned workspace volume and exact sentinel bytes survive, one requested/one completed rebuild is recorded, operation is completed, model fixture has zero requests/errors |
| Console-to-Jaeger navigation | Expand the requested event's Trace details and enter that ID in Jaeger lookup. The real page shows Gateway -> Console -> Controller plus Identity, 202, four services and 12 spans |
| Causal assertions and cleanup | Existing lifecycle inspector verifies all five phase traces, admission/predecessor links and terminal publication; interactive runner exits 0 and exact-label cleanup is empty |

The browser lookup opens
[the Rebuild admission trace](http://127.0.0.1:50675/trace/47760da40218888ff0c841882c71643d).
This is a manual Trace ID lookup using Console's displayed identifier, not an
implemented one-click Console link. The exact operation is
`lifecycle-ed3f2635499c76a355c75a7606045153d51a71d720516eb57f6ddeebae90c0b5`.
Its verified phases are `drain` (`08174fc9fbe92997351482bc96fbabb2`),
`network_fence` (`1a342399f1ab3ee23d008ae6906010c2`),
`runtime_update` (`0c04ee18638573843f3182e555ea4c74`),
`network_ensure` (`9e2a15eb4a381569214e50f3e89229e8`) and
`publish` (`5b9d0177330b2db9eb9a17ab6a7cec76`). The recorded request and terminal
events are 3.823s apart; no end-to-end browser latency benchmark is claimed.
This closes C5-04's final missing page observation without repeating unrelated
service suites, extending C4 scope or claiming a real external model test.

## Cleanup

Temporary PostgreSQL `antnest-final-regression-1a08b25eca4` was removed and its
label inventory is empty; its data used tmpfs, not a persistent volume. Both
temporary Linux build-image tags and the unused temporary verification Dockerfile
were removed. No test-created network was needed for this database-only batch.
All verification command handles reached a terminal state. Final process
inspection found no remaining test/build/lint workers from this batch; the
pre-existing Vite development server was left untouched. The read-only review
agent was closed. Retained deployment stacks and application images were not
replaced. Generated coverage profiles are disposable; only these final metrics
are retained in versioned documentation.

The later projects `antnest-lifecycle-bd211b0f` and
`antnest-stage3-e2e-23179` also finished with exit 0. Independent post-run
container/volume/network inventories for both their Compose and Runtime ownership
labels are empty. The delegated reviewer was closed after its report. Final
process inspection again found only the pre-existing Vite server among the
examined test/build/lint process names; no worker from these runs remains.

The final OIDC deployment `antnest-stage3-e2e-26484` also exits 0. Independent
exact-label inventories for its Compose and Runtime scopes contain zero
containers, volumes and networks. Its shared PostgreSQL and fixture certificate
volumes are removed; the retained development stacks are unchanged.

Shutdown profiles also clean their owned resources. Independent exact-label
checks find zero containers, volumes and networks for the final lifecycle and
Gateway signal projects, as well as every preliminary shutdown attempt. Normal
Agent deletion removes its compute/workspace before profile teardown. Retained
development stacks are untouched; the Gateway image tag alone was rebuilt.
All owned verification handles reached terminal states; process inspection found
no surviving test/build/lint workers. Pre-existing development and browser-tool
processes were not stopped. CUA availability was rechecked after verification:
it still returns an empty browser inventory with `nodeRepl.fetch request failed`.

The current service-regression PostgreSQL container
`antnest-final-regression-1a08bbbd9f2` and workspace project
`antnest-lifecycle-55546ce4` are also removed. Independent exact-label checks
find zero owned containers, volumes and networks; both temporary Linux
build-image tags are absent. The generated final-candidate Go coverage profile
is removed after retaining its compact statement totals above. All verification
handles are terminal, the read-only scope reviewer is closed, and host process
inspection finds no remaining workers from this batch. Existing development
stacks are unchanged; the Agent UI product image tag is updated for subsequent
acceptance deployments. The final fingerprint is unchanged after these checks.

The seven capability profiles and both managed-MCP versions use nine additional
disposable projects. All nine exit successfully; 54 independent inventories across both
Compose/Runtime labels find no owned containers, volumes or networks, and host
inspection finds no remaining profile workers. Their input fingerprint remains
`9505aeb3f3e5139854420b061f9247c28e24c35b3c165f2182c37e69e6aa9815`.
The test-only managed build/integration image tags remain cached for repeatable
verification; retained human-acceptance deployments are unchanged. The read-only
browser-scope reviewer is closed. Documentation checks pass for 86 Markdown
files and 392 local file targets; `git diff --check` passes.

The subsequent identity/lifecycle/signals batch independently checks 15 test
projects, including both discarded ACP fixture attempts. All 84 exact-label
container/volume/network inventories are empty; both interrupted-update image
tags and all profile workers are absent. Nine production image IDs remain as
listed above; retained development stacks are untouched. The input fingerprint
still matches `52a327467c48a1df93a5c4871da970290fbe45960e2f4a8f4027e784fd467422`.
Both read-only reviewers are closed. CUA was rechecked only for the still-required
Console/Jaeger acceptance: it returns no browsers and `nodeRepl.fetch request
failed`. This is missing browser evidence, not a product failure or a reason to
rerun completed service regression.

The later browser-navigation fixture and its discarded setup project are both
cleaned: 12 exact-label inventories across
`antnest-lifecycle-eb7ac01c` / `antnest-lifecycle-cdac6e5e`, Compose/Runtime
ownership, and container/volume/network kinds all return zero. Both interactive
handles are terminal. They were deliberately aborted rather than reported as
passing the unperformed Console recovery scenario; only the observed Jaeger
navigation is accepted. The preflight setup was replaced to use the documented
`operation_request_id` event field, not because a service regression failed.
No production code or image changed. The two edited reports pass local-file
link checks (49 targets) and `git diff --check`; no new full-suite execution is
claimed.

The final approved Console project `antnest-lifecycle-f4d7b452` exits 0 after
explicit finish and cleanup. Six independent inventories (both ownership labels,
all three resource kinds) return zero. The coordinator closed its test tabs;
no retained stack, volume or image was removed. The scope reviewer is closed.
Final host inspection contains only browser-tool Node processes among the
examined Node/Docker/test executable names, not leftover verification workers.
The root README is aligned with the accepted/deferred scope.
Only these final observations and metrics are retained, not the interactive
fixture command, temporary credentials, screenshots or raw logs.
