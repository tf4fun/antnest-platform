# Platform tests

This document describes where tests live, how to run them from the repository
root, which external dependencies each level needs, and the resource-hygiene
rules every test runner follows.

Deployment secret regression is in `tests/integration/deployment/development-secrets.test.mjs`:
the generator, file mode/non-overwrite checks and all twelve unset/empty Compose
fields run in `make test-repo` / `make test-deployment-wiring` with Compose CLI,
without an Engine. `make e2e-deployment-wiring` uses a fresh generated `.env` and
verifies administrator login and public-password rejection in the actual stack.
Fixed disposable workflows explicitly select `tests/support/compose.public-development-secrets.yaml`
and opt in through their fixture environment. This setting is absent from standard
Compose and never inherited from a retained deployment.

Dependency secret admission has shell unit/drift tests in
`tests/support/development-secret-admission.test.mjs`, entrypoint component tests
in `tests/support/storage-shell-entrypoints.test.mjs` and source/render wiring
checks in `tests/integration/deployment/dependency-secrets.test.mjs`. The disposable
override opts in PostgreSQL, Temporal database/schema/server and Skill Registry
database initialization as well as the six platform owners. Tier A dependencies
retain non-published `integration-*` passwords and use no container opt-in.

Run the required Tier B dependency gate serially after rebuilding
`antnest/temporal:local` from `scripts/temporal/Dockerfile`:

```sh
docker build -f scripts/temporal/Dockerfile -t antnest/temporal:local .
node tests/e2e/service-authentication/deployment-credentials/dependency-secrets.mjs
```

The runner requires local `postgres:17.11-bookworm`,
`temporalio/admin-tools:1.32.0` and `temporalio/server:1.32.0` images; it never pulls
or rebuilds. It verifies the actual images' `sh` and inherited Temporal metadata,
all five dependency rejections with sanitized logs, explicit opt-in readiness and
per-start WARN counts, generated-password readiness without WARNs, normal server
stop/restart, and PostgreSQL rejection on an initialized volume. Each scenario
has an isolated project and ownership-checked cleanup. Private logs and results
remain under ignored `artifacts/verification/dependency-secrets/`.

`make e2e-stage1`, `make e2e-stage2`, `make e2e-runtime-controller` and
`make e2e-lifecycle` use `tests/support/authenticated-shell-e2e.mjs`. It builds
uniquely tagged images from the current checkout, provisions private workload
tokens/CCT keys for an isolated project, and removes its containers, volumes,
networks, credentials and candidate tags afterward. Stage1 selects base Compose
without the debug overlay; Stage2 and RC select the diagnostic relay explicitly.
Direct private API probes use the fixture's allowed caller identity, real
Identity login session and organization/Agent scope. Native
Runtime probes also supply the per-instance credential before checking execution
fences. Stage2 uses deterministic model replies and never calls a real Provider.
Private logs and cleanup results live under `artifacts/verification/shell-*`.
Stage2 starts the bounded Runtime OTLP ingress and a separate loopback ingress
for its host-side test client's spans; Jaeger remains on the isolated
observability network. It records the established clock-only warning review
without changing raw spans. Missing parents and
unknown warnings still fail normal scenarios. Its explicit SIGKILL diagnostic
keeps business recovery assertions but excludes the killed Run and its source
trace from stable Trace admission. Expected-503 fault probes outlive the
standard 150-second dependency deadline.
Lifecycle waits up to 60 seconds for RC's asynchronous Skill-volume cleanup
after Delete, then requires every owned Runtime container and volume to be gone.
Its Trace review also checks preparation retries, expected busy rejections and
the deliberate graceful Controller restart against their complete topology and
exact error classes. Raw warnings and error spans remain in the evidence;
unrelated errors or missing parents fail admission.

## Layout

Tests are placed by the boundary they exercise, not by filename suffix.

| Location                               | Contents                                                                                                                                                                                                                                            |
| -------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `services/<name>/`, `runtimes/<name>/` | Service unit and contract tests that use only fake adapters. They stay with the owning service or Runtime package.                                                                                                                                  |
| `tests/integration/`                   | Tests that use real dependencies (PostgreSQL, Temporal, Docker), real protocol peers or several components. Browser tests against synthetic backends are integration tests.                                                                         |
| `tests/e2e/`                           | Complete deployed workflows, usually a disposable Docker Compose stack reached through the Edge Gateway. Browser tests through the deployed Gateway are E2E tests. Fixture validators (`*.test.mjs`) beside each scenario check the harness itself. |
| `tests/support/`                       | Shared fixture, process, dependency, environment and evidence utilities, plus tests of that infrastructure. See [verification tools](support/verification/README.md) and [diagnostic tools](support/diagnostics/README.md).                         |
| `tests/suites/`                        | Explicit serial command manifests, including the fixed `dependencies/` profiles. See [suites](suites/README.md).                                                                                                                                    |

Some integration tests need private symbols of their owning language package.
Their sources still live under `tests/integration/`, and the runners keep the
original package identity: Go sources are compiled through overlays by
`tests/integration/go/run.mjs`, and Rust sources are wired in as test targets
of the owning crate. This must not add public production APIs, and root entry
points must not silently omit integration cases. The ACP service configuration
and lockfile stay with the service; root ACP integration sources reuse that
installation.

## Main targets

| Command                            | Coverage                                                                                                                                                                                                                                                                                     | Dependencies                                                      |
| ---------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| `make fmt-check`                   | gofmt, `cargo fmt`, Prettier for the ACP service and root `tests/**/*.mjs` / `*.ts`. `make fmt` applies the same formatters.                                                                                                                                                                 | Go, Rust, installed ACP service dependencies                      |
| `make lint`                        | `go-lint` (Go services and root Go integration/E2E sources, compiled but not executed), `rust-clippy` with `-D warnings`, and `node-lint` (syntax checks, ESLint and TypeScript type checks).                                                                                                | Go, golangci-lint, Rust, Node dependencies                        |
| `make test`                        | Test-storage policy, Go service and portable root integration sources, Rust tests, Python verification tools, Node support tests, ACP, Admin Console and Agent UI unit tests, and all E2E fixture validators. External database and Temporal profiles are not included.                      | Go, Rust, Node, Python 3                                          |
| `make test-go-unit`                | Go service-local unit tests only. `make test-go` also includes root sources through overlays.                                                                                                                                                                                                | Go                                                                |
| `make test-service-authentication` | Platform CCT schemas/signed vectors, token receiver/header/file/rotation/mode vectors, enforced caller catalogs and missing-route checks, JSON media-type probes, and development credential/PKI provisioning, CLI, cancellation and real TLS checks. Does not prove full-platform security. | Node, Go, OpenSSL, installed ACP dependencies; no Docker          |
| `make test-integration`            | Go PostgreSQL and Temporal tests, Rust dependency and SDK probes, ACP PostgreSQL and audit tests, and Admin Console and Agent UI browser integration.                                                                                                                                        | Docker, local PostgreSQL and Temporal images, Playwright browsers |
| `make test-postgres`               | All service PostgreSQL tests in one disposable dependency project, including the Agent Controller Temporal tests.                                                                                                                                                                            | Docker, local PostgreSQL and Temporal images                      |
| `make test-<service>-postgres`     | One service's PostgreSQL tests: `egress`, `runtime-controller`, `agent-acp`, `identity`, `agent-controller`.                                                                                                                                                                                 | Docker; `agent-controller` also needs Temporal                    |
| `make e2e-*`                       | Deployed workflows under `tests/e2e/`; see below.                                                                                                                                                                                                                                            | Docker; some targets need Playwright                              |

`node tests/e2e/service-authentication/deployment-credentials/run.mjs` checks
private read-only generated mounts for every static service and sender-file atomic
replacement with no container network or host ports. It cleans its own containers
and credentials; it is deployment preparation evidence, not a business workflow.

`node tests/e2e/service-authentication/development-pki/run.mjs` checks each
static service's private, read-only leaf/key and public CA mounts in an isolated
nonroot container. Actual loopback mTLS accepts the generated identity and rejects
missing certificates and wrong server names. Containers have no network or host
ports and cannot see the CA private key. It cleans owned containers/keys and is
PKI preparation evidence, not platform mTLS or business acceptance.

The PostgreSQL targets run through `tests/support/dependencies.mjs`, which
starts a uniquely named Compose project, runs the command and removes the
project's containers, volumes and network on exit. It explicitly loads
`compose.debug.yaml` and assigns loopback ports; base Compose has no dependency
publications. Full-stack entry points select the same overlay before stage3,
so application diagnostic ports remain suppressed.

`make test-deployment-ports` renders all Compose profiles and both overlay orders,
verifying the Gateway-only base and exact loopback diagnostic mappings. It needs
the Compose CLI, but no running Engine. It also exercises the Stage 3a runner's
Compose dispatch for every profile and checks the lifecycle foundation and C4
overlays. Disposable suites keep only their assigned loopback publications and
allocate dynamic endpoints above the fixed service addresses. The eight ACP and
managed-MCP profiles share `tests/e2e/support/compose.isolated-networks.yaml`;
their PostgreSQL and Jaeger publications come from `tests/e2e/stage3a.compose.yaml`.
`make e2e-deployment-ports` uses a fresh
PostgreSQL/Temporal project to verify a real database query and Temporal's gRPC
system-info/namespace calls through Docker-assigned host ports, then verifies
owned resource cleanup. This is deployment-tooling evidence; full platform
security and business acceptance remains in the final integration batch.

To compile all root Go sources for one service without running them:

```sh
node tests/integration/go/run.mjs SERVICE --profile all -- -run '^$'
```

Go profiles default to `integration`. Runtime crash recovery uses the separate
`e2e` profile and requires its explicit environment opt-in.

## E2E targets

E2E targets build or reuse local images, start a disposable stack, run the
scenario and remove every resource they own. They are never part of
`make test`.

| Targets                                                                                                                                                                                                                                                                                | Scenario directory                                                         | Coverage                                                                                                                                                                                                                                                                                           |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `e2e-stage1`, `e2e-stage2`, `e2e-stage3`, `e2e-stage3-local`, `e2e-runtime-controller`                                                                                                                                                                                                 | `tests/e2e/`, `runtime-controller/`, `stage3-base/`                        | Runtime and Runtime Controller, identity and Agent orchestration, and the full admin control plane through the Gateway.                                                                                                                                                                            |
| `e2e-runtime-controller-observation-retry`                                                                                                                                                                                                                                             | `runtime-controller/`                                                      | Docker socket loss during startup and Watch, HTTP 200/503/200 recovery without process restart, shared observation readiness and Runtime initialize/delete. Watch-only loss also verifies lifecycle calls remain available. Uses an isolated socket proxy and a separately tagged candidate image. |
| `e2e-acp-session`, `e2e-acp-closeout`, `e2e-acp-restart`, `e2e-tool-progress`, `e2e-file-observations`, `e2e-structured-plan`, `e2e-tool-permissions`, `e2e-slash-commands`, `e2e-multimodal`, `e2e-session-cost`, `e2e-rpc-response-loss`, `e2e-managed-mcp-v1`, `e2e-managed-mcp-v2` | `acp-*/`, `rpc-response-loss/`, `managed-mcp/`                             | ACP protocol behavior on the full stack. Each is an opt-in flag of `tests/e2e/e2e-stage3a.sh`.                                                                                                                                                                                                     |
| `e2e-identity-core`, `e2e-identity-access`, `e2e-agent-access`, `e2e-organization-display`                                                                                                                                                                                             | `identity-closeout/`                                                       | Login, sessions, access control, Agent access and real local/OIDC Organization display through Node/SSR/browser.                                                                                                                                                                                   |
| `e2e-lifecycle`, `e2e-lifecycle-shutdown`, `-health`, `-restore`, `-interrupted`, `-network`, `-loss`, `-crash`                                                                                                                                                                        | `lifecycle-closeout/`                                                      | Agent and platform lifecycle, normal shutdown, health, backup restore, interruption, network loss and Runtime loss. `e2e-lifecycle-crash` is an abnormal-exit diagnostic excluded from the stable targets.                                                                                         |
| `e2e-workspace`, `e2e-workspace-browser`                                                                                                                                                                                                                                               | `workspace-closeout/`                                                      | Agent UI workspace protocol and browser behavior.                                                                                                                                                                                                                                                  |
| `e2e-agent-ui-receipt-contract`                                                                                                                                                                                                                                                        | `agent-ui/`                                                                | A real failed Run through Gateway and Chromium; actual ACP receipt/observation JSON validates against the shared schema and Node parsers; workspace failure survives reload. Builds isolated current ACP, Agent UI, Gateway, Identity and RC candidates without replacing local tags.              |
| `e2e-gateway-security-headers`                                                                                                                                                                                                                                                         | `edge-gateway/`                                                            | Existing-conversation navigation/reload through Gateway and Chromium, one upstream CSP, nonce script execution, blob image/audio loading, and zero CSP violations. Uses the local model fixture and isolated current candidates; verifies cleanup preserves the retained Docker environment.       |
| `e2e-browser-sessions-https`                                                                                                                                                                                                                                                           | `edge-gateway/`                                                            | Real Identity, Console and Workspace through the TLS proxy: default OIDC linking refusal, explicit binding/restoration, exact notices, paired SCIM, lockout confirmation, session/stream retirement without cancelling an accepted Run, password replacement and idle expiry.                      |
| `e2e-stage3-skill-delivery`, `e2e-stage4-skill-*`, `integration-stage4-skill-*`                                                                                                                                                                                                        | `stage3-base/`, `lifecycle-closeout/`, `tests/integration/skill-registry/` | Skill package delivery to Runtimes, including Registry outage, races, response loss, drift and restore.                                                                                                                                                                                            |
| `e2e-skill-learning-*`, `e2e-runtime-tool-usability`                                                                                                                                                                                                                                   | `skill-learning/`                                                          | Automatic Skill learning: creation and update, notices, preemption, policy and lifecycle cancellation, install interruption and resend, key rotation, model failure and recovery, restart and browser checks.                                                                                      |
| `e2e-skill-discovery-*`, `e2e-skill-temporary-*`, `e2e-skill-deployment`, `e2e-skill-source-lifecycle`, `e2e-skill-registry-trace`                                                                                                                                                     | `skill-registry/`, `skill-learning/`                                       | Skill Registry discovery, temporary Runtime use, Console promotion, Template propagation and source lifecycle.                                                                                                                                                                                     |

`e2e-skill-learning-runtime` verifies that the default Runtime image has an empty
test-feature label, no test-feature startup opt-in, and `test_features: []` on
its live `/status`; that signed requests for the retired transaction actions are
unknown; and that `install` and `digest` work across dual-key trust and old-key
removal. It then runs the gate-image install suite. The `e2e-skill-learning-install-after-rename-*` variants
explicitly build `--target e2e` with `skill-maintenance-e2e-gate`, check its
image label and startup opt-in, and verify the live status and single feature
warning before pausing an install after its rename. The install interruption
harness accepts isolated RC/Identity candidates through
`ANTNEST_E2E_RUNTIME_CONTROLLER_IMAGE` / `ANTNEST_E2E_IDENTITY_IMAGE` and the
Gateway candidate through `ANTNEST_C4_EDGE_GATEWAY_IMAGE`; deploy the new RC
reader before using the new Runtime status producer.

The Stage 3a profile runners start their client detached and read its result
with `docker logs`. Docker splits output lines longer than 16 KiB, and the
json-file log driver replaces a multi-byte character cut by that split with
U+FFFD. These clients therefore print every JSON line through
[`support/ascii-json.mjs`](support/ascii-json.mjs), which escapes non-ASCII
characters; `support/ascii-json.test.mjs` finds the clients from the runners
and rejects raw `JSON.stringify` output.

`make e2e-skill-discovery-caller` waits up to 90 seconds for the source Agent's
projection acknowledgement before starting its caller Run. Registry recovery,
live discovery results and the peer Agent's acknowledgement do not establish
that this source's persisted delivery backoff has finished. Only an active
projection at the expected sequence with matching managed candidate and digest
may wait; a missing, withdrawn or changed source fails immediately. The checks
after the caller Run remain immediate invariants. Fixture tests cover delayed
acknowledgement, its deadline, cancellation and invalid source states.

The discovery-tools client also reads the target Agent's public execution state
with the same member session before opening ACP. Controller readiness alone
does not establish that ACP has applied the binding (tracked in #44). Only an
authorized target reporting `offline/agent_unavailable` may wait, for at most
90 seconds; each read is limited to 15 seconds and the remaining deadline.
Denied, busy, protected, malformed and HTTP-error states fail immediately. The
first Prompt must succeed without retry, and a later `agent_unavailable` from
session creation still fails. Failure diagnostics retain the request stage and
last public state. This fixture precondition does not close #44's product
readiness contract.

All Skill E2E flows use a local deterministic model fixture. The browser
targets (`e2e-workspace-browser`, `e2e-skill-learning-browser`,
`e2e-skill-learning-diagnostics-browser`, `e2e-skill-discovery-console`) need
installed Playwright Chromium and close their browsers before Docker cleanup.
Browser-backed API probes use `tests/support/gateway-browser-request.mjs` to
retain Chromium's Secure-cookie session on literal loopback HTTP, which
Playwright's API client otherwise omits. The bridge preserves cookie attributes
and domain/path filtering, honors explicit negative-test headers, and never
follows redirects. Real page requests continue to use Chromium's cookie handling.
Scripted clients share `tests/support/gateway-session-cookies.mjs` to select
session and CSRF values from actual Cookie names. `__Host-` names take
precedence as one mode; helpers never add legacy aliases or infer mode from
the URL. HTTPS admission assertions still require the prefixed names explicitly.
Its `gatewayBrowserSessionCookies` helper injects API-login sessions with their
mode's Secure, HttpOnly, host-only, root-path and Lax attributes. Chromium's CDP
requires an HTTPS injection URL for `__Host-` cookies, including on loopback;
the browser and API requests retain the deployment's actual URL.

`e2e-browser-sessions-https` verifies sign-out-everywhere with independent quiet
SSE and WSS connections opened using the peer Console session's original Cookie
before the Workspace action. Both original Cookies must return 401, the current
private page must retire, and both remote transports must close within 30 seconds
and before natural CCT expiry; WSS must report 1008. Local observer cleanup runs
after that evidence and waits for the actual socket close, even on failure.
Fixture tests hold a real upgraded socket's close handshake to prove that HTTP
101 cannot substitute for completed cleanup.

The same HTTPS suite checks OIDC admission with two Node client containers on
the TLS ingress network. A exhausts the deployed 30-start budget; B uses an
independent Cookie jar and a prebound ordinary user to complete a real signed
OIDC callback and read its exact Principal. A remains refused afterward, within
the same 10-minute window. Every response Trace ID is matched to the Gateway's
actual client address and the exact Identity request inventory, including zero
upstream requests for refusals. The private evidence preserves complete raw
traces, partial receipts and logs before teardown; authorization URLs, Cookies,
state, nonce and codes never enter client receipts. Both clients verify the
private CA and TLS proxy hostname, and expose no host ports.

SCIM lifecycle acceptance uses actual Console browser commands to issue and
rotate credentials, and HTTPS bearer requests to the real Identity service.
It checks persisted User/Group versions, successful conditional mutations and
stale PUT/PATCH/DELETE refusals; both credentials remain usable during rotation,
and explicit revocation affects only the selected credential. Expiry uses one
controlled database timestamp change on a minimum-lifetime credential. Separate
organizations prove read, write and Group-member isolation. Administrator
demotion revokes the issuer's credentials, and restoring authority requires a
new credential rather than reviving a revoked one. Rejection snapshots cover
Identity domain, token usage, audit and revocation state after browser mutations
have drained. Every observed command has a complete HTTP parent chain, exact
response-byte counts and a final raw Trace archive. Expected 4xx diagnostics keep
their raw strict failure classification with explicit owning error attribution;
unknown errors and warnings fail admission.

Browser login inspection retains the original response in a bounded Chromium
CDP buffer so an application navigation cannot discard it. It reads through the
same CDP session and request ID, checks status and Trace ID against Playwright,
and preserves the original HSTS and Cookie assertions. It never intercepts or
replays login, or replaces the response with a later session read. A real Chromium
regression verifies capture after a cross-process navigation, and covers duplicate
requests, redirects, truncated/oversized bodies, closure and capture deadlines.

The password flow records both the Chromium fetch/body-consumption result and
Playwright's response observation for each single POST. Their shared request ID
prevents an unrelated response from satisfying the observer. The private progress
evidence keeps status, validated Trace ID, bounded network failure kinds and
elapsed time, without passwords, CSRF values, Cookies or exception messages.
Both sides must complete consistently; the existing 25-second fetch and
30-second observer deadlines remain failures without retry or fallback.

`e2e-agent-ui-receipt-contract` also uses the local model fixture and needs
Playwright Chromium and the standard local stack images. Its captured receipt
evidence defaults to `artifacts/verification/`; override its directory with
`ANTNEST_UI_RECEIPT_E2E_OUTPUT`. It closes Chromium, removes its labeled candidate
images and compares the retained Docker environment after cleanup.

`e2e-gateway-security-headers` has the same prerequisites and uses no external
model provider. Set `ANTNEST_GATEWAY_SECURITY_E2E_OUTPUT` to override its private
evidence directory. It also removes its owned candidates and verifies that
retained containers, volumes, networks and image references are unchanged.

`e2e-gateway-tls` adds OpenSSL and the pinned `caddy:2.11.7-alpine` image to those
prerequisites. It runs the reference proxy overlay with a disposable private CA,
verifies Node's CA/hostname checks, and pins the temporary leaf key in Chromium
without changing system trust. Fresh Gateway, Console and Agent UI candidates
exercise `__Host-` Secure cookies, Console writes and Workspace prompt/SSE while
legacy CSRF cookies are planted; an authenticated ACP client uses WSS. Raw
requests reject planted cookie/header pairs, cross-session replay, duplicate
session cookies and legacy production names. A valid bound header still works
without the CSRF delivery cookie. Browser logout covers both confirmed `204`
and already-invalid `401` sessions and removes their private pages.
Two separate container addresses verify independent login source limits despite
forged forwarding headers. `ANTNEST_GATEWAY_TLS_E2E_OUTPUT` selects the private
evidence directory. Cleanup removes the fixture keys, candidates and deployment.

`node tests/e2e/edge-gateway/resolve-cache-docker.mjs` runs the policy revision 4
Bridge cache workflow. Its load measurer and Trace collector
use 100 sequential HTTP workspace sessions requests, including cold ACP
initialization and complete response bodies within eight seconds. The last
request must trigger a completed half-TTL refresh; actual Gateway attempts and
Identity receipts have independent budgets. The SQL verifier binds queries to
the actual list operation and process, and excludes connection/transaction
observations from query counts. The private ACP HTTP receipts require a 200
Initialize connection response and 202 session-list acceptance on the existing
connection stream; the browser must still receive each complete 200 JSON page.
Runtime catalog completion logs keep their empty `error.type` placeholders
only with exact Trace/span/Agent binding and successful HTTP, MCP or Executor
outcomes. Duplicate fields and additional failure diagnostics remain failures;
raw logs are never removed. Admission requires the complete current-source
Docker load/outage report and verified cleanup in addition to unit regressions.

The Docker runner builds seven current candidates, including Agent Controller,
and checks their actual container references, immutable IDs and ownership;
the RC preparer must use the same selected RC image. An explicit
`ANTNEST_E2E_RUNTIME_IMAGE` is captured before fixture environment filtering.
The final Compose image choices are recorded before startup, and the eight
load participants are checked against independently selected image IDs.
Both the load Agent and the independent cold-scope Agent are created once and
waited ready during the normal 150-second provisioning budget. A private receipt
binds the cold Agent to its owner, create operation and executable revisions.
Only then is Gateway recreated with the two-second request budget needed for
outage refusals. The outage flow reads the existing Agent through the setup
administrator; the later warm member Cookie does not visit that Agent before
its cold-scope rejection. Creation is never retried after an HTTP timeout, since
the accepted lifecycle workflow may still be running.

Policy revision 4 retains six complete HTTP outage refusals: two independent
cold Cookies for Console and Workspace; the warm workspace Cookie against an
unused session profile and a second ready Agent; a new login; and the expired
short-idle session. The raw rejection inspector requires that warm Cookie's
actual workspace cache hit and distinct, same-owner cold Agent setup. It checks
all prior HTTP and public SSE requests using the Gateway's decoded profile and
Agent key, including the empty Agent key for workspace bootstrap. Missing
request metadata or Resolve admission cannot prove a key was unused. Each
refusal has its own archived Trace, a complete no-store directive, no Cookie
issuance, one failed Identity CLIENT and no business forwarding. The original
expired Cookie must receive the authoritative database-backed 401 after
recovery. Revision 3 remains a separate historical five-refusal reader and
rejects Bridge-only labels or transport. All raw errors and warnings survive;
an isolated rejection replay does not admit the other outage gates, extend an
authorization deadline, or turn an earlier failed Docker run into a success.

The revision 4 authority reader follows Gateway's actual workspace Resolve
through its HTTP CLIENT to the Agent UI receiver and that receiver's private
ACP Initialize request. The same credential, Agent and original RPC source
must match the later workspace cache hit. Because the cache retains that
source's complete Principal and CCT, its clipped remaining lifetime supplies
a conservative deadline for the original private admission. Console and
workspace origins, the original SSE admission, exact terminal-empty feed proof
and the complete Identity stop must all satisfy their original deadlines.
A later successful stream revalidation cannot extend them. The historical WSS
admission and ACP profile are excluded from revision 4; raw closure diagnostics
remain the responsibility of their separate owning gates.

Runtime inspection and configuration acknowledgement polling use independent
preparation credentials before the final member and audit logins. The final
Principals must match the preparation identities, while their Cookies must be
new. Before either final scope is used, arm the independent short-idle fixture
once, protecting those exact final tokens, and complete its two successful
session reads and unchanged database observations. Its expiry may precede the
stop; the stopped-period database read must prove expiry before the real 503,
and recovery must still return 401 without Cookie loss. The audit Cookie then
makes one fresh acknowledgement request, followed by the member's actual
workspace admission. A stale final acknowledgement fails the run. Preparation
does not extend the original ten-second authorization budget; the original
Cookie still opens the SSE and submits the single prompt. Reuse the prepared
PostgreSQL container identity for Run observations, retaining each read's
ownership check. Immediately after Identity becomes healthy, require the
original SSE to remain open before Rebuild or any recovery mutation.

Revision 4 recovery authority binds each new Cookie's Session-creation POST201
to its actual Resolve RPC and SQL, then independently traces the initial view
and SSE cache admissions back to that source. Existing private Bridge owners
can be reused; these checks do not claim a new ACP initialize or a new private
connection lifetime. The actual remote closure must precede both original
public-admission deadlines, without renewal by a later Resolve. The complete
recovery business gate retains Principal, Session, Run, mutation and restoration
checks. Transport-end observations do not establish an explicit revoked event;
the stream gate must separately account for their exact raw close diagnostics.

The stream reader accepts a terminal RPC revalidation 401 only after the complete
recovery HTTP inspector proves that exact revocation. It binds the dispatched
credential and Principal, preserves successful initial/intervening admission,
and requires the original zero-row browser-token SELECT after the committed
mutation on the same Identity instance, host and PID. Gateway Date bounds apply
only to Gateway spans; Identity uses its own transaction/SELECT clock. Only the
exact rejected decision, CLIENT and unauthenticated SERVER errors are claimed.
Shared/unavailable decisions and extra diagnostics remain failures. The original
strict result is retained. Tests include independent service-clock offsets and
missing/foreign transaction, feed, query, process and closure evidence.

Outage cleanup capture reconciles independent close/DELETE searches against the
entire raw Trace map. It verifies three final complete snapshots, their equality
with the final search and archive, and every search's actual receiver; process
resources and warnings remain part of the comparison. The collector passes these
inventories and all rounds to the stream reader. Capture still reports
`captured_owning_admission_pending`; it establishes inventory, while the stream
reader performs owning admission. The reader binds POST session creation and
successful views to actual initializations, UI generations and owner scope.
Restored disabled-Agent 403 views are enumerated from both HTTP and recovery
receipts even when they create no private connection. Their original credential,
Principal, parent chain, generation and UI process must match; complete recovery
proof admits only the exact forwarding error without inventing a private owner.
Later GETs retain their actual HTTP parents. Every private GET and execution
watch, including successful ones, must finish within its observed lifecycle.

ACP and UI clocks are calibrated separately from actual HTTP windows, with
awaited Session-view execution reads refining the ACP interval. The outage
preparation separately captures a complete control-listener `GET /status` in
the original ACP container before its restart. Its generation-0 process and
Docker lifecycle must match the preparation owner. Three complete stable query
rounds reconcile the entire health inventory against the archive in both
directions; one unambiguous raw probe must strictly intersect the independently
bounded process clock. This outage probe is distinct from the load probe below.
Docker process
timestamps are compared only with other Docker timestamps. Normal closes require
the complete producer receipt, one actual DELETE 202, its independent lifecycle
bounds and compatible UI close ordering. A failed close needs its own old-ACP
shutdown watch, exact stopped-peer request failure, one completed attempt with
no response, no pending work, a joined SDK stream and no actual DELETE receiver.
The original failure remains an error claim; missing receipts, extra diagnostics,
unbound owners and contradictory clocks fail. Historical records without the
new producer fields cannot be admitted by changing the reader.
Coverage is in `resolve-cache-outage-stream.test.mjs`,
`resolve-cache-outage-owner.test.mjs`,
`resolve-cache-outage-close-capture.test.mjs` and
`resolve-cache-outage-collect.test.mjs`. A retained archive replay never rewrites
the original Docker outcome or substitutes for a new complete integration run.

`resolve-cache-runtime-cancellation-clock.mjs` separately checks the timing of
the held Runtime cancellation. Completed metadata RPCs before and after the
internal ACP cancellation bound the Runtime clock; all eligible samples must
have a common offset interval. Their CLIENTs must finish within their owning
ACP operations, and Run children must start within the original Run. Every
Runtime end interval must fit inside the internal cancellation window. Raw
cross-process differences and microsecond representation ambiguities remain
recorded. Coverage is in `resolve-cache-runtime-cancellation-clock.test.mjs`.
Its `timing_proved_business_admission_pending` result is consumed by
`resolve-cache-runtime-cancellation.mjs`, which separately verifies the actual
HTTP prompt/cancel and ACP process, one model dispatch, the original Run and
stored snapshot, and the same Runtime execution, image, generation and process
group. Audit readiness is optional and cannot replace the organization/Run
scoped business query; SQL must remain within its owning operation. Same Node
SDK joined-end differences below one millisecond are recorded separately.
An awaited Run/terminal-SQL end in another Trace uses a distinct join receipt,
not a synthetic parent. Both ACP resources and integer-millisecond anchors must
match; the actual successful cancel application must be a direct dispatch child
and cover those completions. Each difference from internal cancellation must be
strictly below one millisecond, without stacking allowances. Original raw times
and strict diagnostics are retained.

`resolve-cache-runtime-cancellation-diagnostics.mjs` validates five explicit
ERROR spans and the Runtime HTTP error event as six exact raw error claims.
It retains the two cancellation transport receipts and separately checks
successful metadata, including EOF CLIENT diagnostics and each info executor's
exit and completion identity. SDK-closed metadata is never a clock sample.
The revision 4 collector archives all raw sources before awaiting this complete
consumer and retains its full result; failures and unknown revisions still
preserve raw evidence. Revision 3 retains its original model-read cancellation
reader. Coverage is in the cancellation, diagnostics and collector test files.
The current final report explicitly marks policy 4. Its completion boundary
reuses full HTTP load admission and joins the actual outage business result,
four recovery Runs and their current view/SSE identities, owner-close inventory
and exact error-claim union. The raw diagnostic inspector exports each original
Trace's span/error/warning counts once; closure summaries are checked against
that inventory without counting shared source warnings twice. Required receipts
remain mandatory even when optional failed-close or direct-login fields are
present as `undefined` in a live JavaScript object. Coverage is in
`resolve-cache-completion.test.mjs`; historical policy-3 completion remains
isolated. The full suite can finalize only after verified cleanup, retaining
`strict_trace=failed` and the corresponding strict-CI warning result.
Offline replay does not change the original Docker outcome or replace a fresh
complete Docker integration run.
This cache admission proves the sequential HTTP load, same-Run/Runtime output
and cancellation during the bounded Identity outage, and recovery. Its Runtime
quiescence bound is the outage window. Two-user large-attachment reception and
EOF processing overlap with cancellation within one second, and the full
64-SSE capacity case, require separate integration evidence for #64.

The load flow captures the original participants before the first request and
waits for all 100 complete bodies before invoking its owner lifecycle helper.
The helper stops only the fixture's Agent UI, checks complete stdout/stderr
for forced shutdown, preserves peer processes, and restores the same container,
image and configuration after collection, including on collection failure.
The flow waits for restoration before archiving its final lifecycle receipt;
measurement and archive failures retain both original errors.
Container configuration fingerprints sort object keys and only the observed
mount list; all mount fields and the order of configuration arrays remain
significant. Duplicate mount destinations fail. Baseline and pre-stop failures
retain per-field digests and serialized/canonical fingerprints without copying
Docker environment values or other credentials. A failed comparison or archive
before the stop command does not restart any participant; both failures survive
when the comparison and its diagnostic archive fail together.
Before the first measured request, a read-only Node probe in the original ACP
container reads the control listener's exact `GET /status`. Its ready/command
handshake excludes child startup from the host interval while retaining all
IPC and HTTP uncertainty; it consumes the full body, archives its actual Date
and hash, and joins the child. Cancellation first closes the remote request;
an unresponsive Docker process fails the run and still requires outer container
cleanup. The original clock receipt is passed through the owner lifecycle.
The clock verifier requires one unambiguous independent health SERVER root,
the same ACP instance, and an intersecting offset interval across all 100 actual
list-request starts. It keeps the SDK's sub-millisecond anchor model separate
from transport uncertainty. The collector now includes the independent control
health, Agent UI close and ACP DELETE searches in the same three-round raw
closure as the 100 HTTP requests and refreshes. Each search uses the same
per-round cutoff through the actual Jaeger v3 adapter; one failed search still
archives the other available sources, while global cancellation stops dispatch.
Query and archive failures are both retained.

The inspector requires one independent requested/closed Agent UI root with an
exact Link to the first actual UI HTTP receiver, and one directly parented
workspace DELETE SERVER with status 202. DELETE start/end and every private
GET/watch completion must fall wholly inside the actual UI stop interval using
the original ACP clock. It enumerates every private stream, checks the actual
login's organization and Agent on watch receipts, and classifies only the exact
plain stream-interrupted/disconnected errors; unrelated diagnostics remain
failures. All original ERRORs and warnings remain in raw evidence and strict
status. The container receipt alone does not prove protocol cleanup.

The HTTP load's final admission checks a body-free measurement projection
with normalized JSON/no-store metadata rather than arbitrary remote header text,
all 100 ordered HTTP/ACP receipts, the final request's actual refresh Link and
both independent Resolve inventories. Raw error identities must correspond
exactly to the classified private streams, with no duplicate or unowned claim.
Three consecutive collector rounds retain the full raw snapshot hash, archive
inventory and independent causal query inventories. Final admission also
rechecks the original eight participants and the complete healthy restoration
receipt, including its 30-second deadline, before writing `load-completed.json`.
It binds the cleanup scope to the actual login and retains all strict findings.
This admits only the HTTP load sub-scenario. The historical completion reader
rejects policy 4 reports instead of combining new HTTP load with old WSS outage;
the current completion reader requires that load result together with all eight
Bridge outage gates, complete raw diagnostic ownership and verified cleanup.

The following paragraphs describe historical #59 policy revision 3 evidence,
not admission for the current Bridge workflow. That runner used separate
HTTPS/WSS load and warm-outage batches with the same local stack, Node and TLS prerequisites.
It includes the real upgrade, initialize and 100 sequential `session/list`
exchanges in an eight-second window, crossing half of the default 10-second
cache TTL to exercise refresh. Actual Gateway Resolve attempts and Identity
receipts are independently limited to three. It archives raw wire frames,
independent Jaeger searches and complete trace sources, then verifies resource
cleanup; exit 2 retains strict trace findings. `ANTNEST_RESOLVE_CACHE_E2E_OUTPUT` selects an
unused private evidence directory. These batches are not yet registered as the
complete Resolve-cache CI suite.

The warm-outage flow restarts its two Node consumer processes, waits for a fresh
Controller configuration acknowledgement and a ready Agent, then establishes
actual WSS and SSE admissions. The fixture uses the existing Controller resync
setting at one second and verifies its deployed value. Successful admissions
and the earlier restart-call timestamps give a conservative 30-second JWKS
deadline; setup and the complete five-second Identity stop must fit inside it.
While Identity is stopped, the same Run produces new text, completes a real
read, and is cancelled with a settled, quiescent durable terminal audit. The
flow retains actual container states, wire frames, Workspace projections, model
observations and complete raw Trace closures. Search/inventory or individual
Trace failures retain independent evidence and fail the archive.
The same stop window also observes five complete HTTP 503 responses: cold
Console, Workspace and ACP scopes, a new local login, and an independently
warmed browser session after its idle deadline. Only this disposable Gateway
uses a verified two-second request timeout; cache TTL remains ten seconds.
Provisioning keeps its normal 150-second budget. The fixture then recreates only
its Gateway, verifies its ownership, image, health and deployed settings, and
starts load and outage observations against that fresh process.
All rejection requests are joined, and their responses must arrive inside the
original five seconds without Cookie writes or business forwarding. Client
timeouts cannot substitute for responses. A fixture binds the exact new token,
user, organization, membership and browser kind in the owned Identity database,
first proves that a wrong Membership cannot match or change it, then shortens
only that row's idle deadline. Full rows are compared only in memory to prove
the two warm credentials remain unchanged; durable evidence contains counts
and booleans. Two ordinary session reads must not renew the short deadline.
Database observation proves expiry before dispatch; the
same Cookie receives an authoritative 401 after recovery. Raw failed Identity
CLIENT spans and HTTP roots remain in strict diagnostics.
After Identity recovery, the fixture issues one explicit Rebuild with a fresh
stable idempotency key under the unchanged two-second Gateway request budget.
It retains the actual 202 or 503, queries the public preparation receipt with
that same key, waits for its ready/released state and exact completed operation,
then independently verifies the Agent and new physical Runtime/execution ID.
Pending preparation states and operation 404 are bounded read-only waits; the
POST is never retried. The original workspace effects and complete old Run,
execution events, audit inventory and stored snapshot digest must remain
unchanged. No cached status or old PID marker can prove the new Runtime.
`resolve-cache-rebuild-trace.mjs` independently binds these HTTP observations to
the completed lifecycle workflow, six committed Controller phases and the
Runtime's serializable admission/completion transactions. It admits the exact
503 cancellation chain only after durable completion, and an early operation
404 only when its zero-row read precedes the operation insertion in the same
Controller process. Unknown diagnostics remain failures. Successful Runtime
status completion events with an empty error type require matching request,
process identity and timestamps and cannot carry transport errors. The final
policy-4 boundary requires this preparation proof under `recovery_http`, bound
to the original Run/Runtime and Bridge Agent, with every transaction/write
reference and error claim reconciled against the archived Trace inventory.
Four fresh Bridge HTTP-created Sessions each hold one real model request while
logout, password change, an active Membership role change, and Membership
deactivation retire their original SSE observers. Remote closure must precede both
the 30-second revocation bound and the original credential's conservative
validity bound. Old Cookies receive actual 401 responses without Cookie writes;
an independent peer SID survives logout and is revoked by the other mutations.
The first three accepted Runs remain running after transport retirement, then
complete after an explicit model release; a fresh login reads the same Run's
answer. Deactivation instead cancels and settles the held Run. Restoring the
Membership permits login but the Bridge Agent view still returns an exact 403
access_denied response; independent Admin readback remains disabled with no
Runtime, and the complete accepted Run inventory remains unchanged.
The denial must carry a complete `no-store` directive. Repeated directives,
case and surrounding whitespace follow the existing load check; the actual
Header receipt stays unchanged, and partial or parameterized matches fail.
All observers, model requests and HTTP responses enter the raw Trace inventory.
Run identity, input and execution snapshot remain fixed across the mutation.
If an accepted prompt loses SSE before its Run ID is observed, failure cleanup
queries only that same Session/intent receipt before releasing work; it never
resubmits a prompt. Cleanup releases only the observed owned model request and joins the
same Run's quiescent terminal under a separate finite budget, retaining cleanup
and business failure evidence separately. Its failure/interruption paths have
local callback tests; successful Docker execution does not exercise those paths.
After the recovery observation and public connection cleanup, this batch drains
its Agent UI process so internal ACP HTTP watches can finish their real SERVER
spans before collection; raw parents are never fabricated or discarded.
Policy 4 also searches owner-close and ACP DELETE traces independently, retaining
three stable raw snapshots and each close's exact initialization HTTP source.
Failed closes and rejected DELETE responses are archived with their full parent
chains. `cleanup_capture` records diagnostic capture only; the owning cleanup
and outage gates still decide admission, and original errors remain failures.

The Workspace owning inspector also binds the actual two model CLIENT IDs to
the first successful tool response, one settled Runtime `read`, the second
model's observed disconnect, and the same Run's terminal SQL and public audit.
It keeps the exact response-reader cleanup cancellation and the two expected
model ERROR spans; other failures are rejected. The original held-model
cancellation still requires one request and no Tool execution. The archive
reports this cancellation gate separately from the remaining outage gates.
The authority gate binds the dispatched HTTP/WSS/SSE Cookies using private
random observation IDs; no Cookie, token hash, SID or new header is retained.
Three actual prewarm requests must have cache decisions whose original Resolve
source is unambiguous. Their send times plus the smaller of `valid_for_ms` and
remaining feed TTL must cover the whole stop. The original WSS initialize and
SSE admission must still use their initial snapshots, whose remaining validity
also bounds the original CCT and session deadlines. These checks use observer
monotonic times and Gateway span times separately, without comparing service
wall clocks. Feed evidence includes Gateway attempts with no receiving SERVER;
a proof must fit between the preceding attempt's completion and the actual
terminal empty page's CLIENT start, with successful SQL before admission.
The Gateway search uses a fixed time window, must include the observed receiving
feed Traces, and must stabilize across three rounds within twenty attempts.
Every search round is retained. Incomplete inventories fail this gate. Only the
initial decision before long-connection forwarding can establish its original
authority; later guard revalidation cannot renew that evidence.
Original lifecycle errors and strict
diagnostics remain unchanged and require their separate owning checks.
For joined Node span ends, the inspector records inversions below one
millisecond only when both starts use millisecond resolution in the same ACP
process. Larger inversions, missing parents and cross-process comparisons are
not admitted; raw timestamps and warnings remain unchanged.
`node tests/e2e/edge-gateway/resolve-cache-outage-replay.mjs INPUT OUTPUT`
rechecks a retained outage archive in an unused output directory, retaining
source hashes and strict findings. It is an offline replay, not a new Docker run.

Observer and failure-first coverage is in `resolve-cache-outage.test.mjs`,
`resolve-cache-outage-collect.test.mjs`,
`resolve-cache-outage-authority.test.mjs`,
`resolve-cache-outage-rejection.test.mjs`, `resolve-cache-expiry-fixture.test.mjs`,
`resolve-cache-recovery.test.mjs`, `resolve-cache-recovery-authority.test.mjs`,
`resolve-cache-recovery-cleanup.test.mjs`, `resolve-cache-rebuild.test.mjs`,
`resolve-cache-outage-replay.test.mjs`, `workspace-closeout/chat-outage.test.mjs`,
`resolve-cache-stream.test.mjs`, `workspace-closeout/c4-cache-model.test.mjs`
and `lifecycle-closeout/acp.test.mjs`. The model fixture holds two stages of the
same Run, with fresh text and a settled read between them. The Workspace
observer validates named SSE events with the production projection decoder,
retains raw frames without reconnecting, and distinguishes remote closure from
local cleanup. The ACP helper can negotiate delivery marks and target a cancel
at the observed Run. A passed business window and raw archive do not establish
complete outage/recovery admission. Authority, cancellation and HTTP rejection
have separate owning results. Recovery Run and original-authority gates are
also separate; mutation HTTP receipts, stream retirement diagnostics, stopped
feed errors and complete CI registration/admission remain pending. Successful
Run telemetry uses `outcome=ok` with `terminal_class=completed`. Explicit
principal-revocation cancellation permits the observed `DomainError` /
`access_denied` Provider rejection with its exact event and ModelError origin;
other model failures still reject the gate and raw strict findings stay intact.

Some contract checks can be run directly:

```sh
node --test tests/integration/skill-learning/contracts.test.mjs
node --test tests/integration/skill-registry/discovery-contract.test.mjs
node --test tests/integration/runtime-tools/contracts.test.mjs
make test-skill-deployment
```

The drivers in [`tests/e2e/development/`](e2e/development/README.md) target an
existing development deployment, require explicit configuration and are not
part of any default target.

## Continuous integration

`.github/workflows/integration.yml` runs the suites on every push to `main`,
on manual runs, and on every push to a pull request that is not a draft: when
it is opened, reopened, marked ready for review or updated. A newer head
cancels the run for the older one. A draft runs only `Repository checks` and
the path-filtered service workflows (lint, unit tests, image build) and reports
`Integration checks (not run)`, so the required `Integration checks` stays
pending until it is marked ready. Labels never start a run: GitHub checks a
required status against the newest run of the workflow for the head commit,
so a run that does nothing would hide the full one.
[`support/ci-mode.mjs`](support/ci-mode.mjs) decides the mode.

[`support/ci-changes.mjs`](support/ci-changes.mjs) holds the suite
catalog: each suite lists its commands, host setup, prebuilt images and the
paths it exercises. The workflow runs only the suites that match the changed
files (prose-only changes select none). Changes to the workflow, `tests/support/`,
`contracts/` or the `Makefile` select every suite.

Suites are grouped into shards by product area (`shards` in the catalog).
Each shard is one CI job, `Tier <tier> / <shard>`: it installs the setup and
images its selected suites need and runs them in order on one runner through
[`support/ci-shard.mjs`](support/ci-shard.mjs). Every selected suite runs even
after an earlier one fails, each in its own process group with a timeout, and
the job summary lists each suite's result and elapsed seconds. Each shard
also preserves a separate log for every started suite and incrementally writes
`artifacts/verification/ci-shards/shard-*/results.json`, with start/end times,
duration, exit status, timeout and interruption. Suites skipped after an
interruption have no execution timestamps. Destructive suites come last in
their shard. Every suite starts and removes its own stack, so a shard reuses
pulled images and host setup but no platform state.

- **Tier A:** PostgreSQL and Temporal component suites, browser suites,
  deployment render contracts and the Runtime SDK probe.
- **Tier B:** service-owned Docker E2E runners and the protected-listener
  network/credential matrix. Each starts an isolated stack; runners that start
  images with `--no-build` get `antnest/<image>:local` first. `b-auth` includes
  `auth-acp` (`make e2e-acp-authentication`) alongside the Console, Controller,
  Egress, Gateway, Identity, Runtime Controller and Runtime suites. The separate
  `b-auth-matrix` shard runs `auth-network-matrix`
  (`make e2e-service-authentication-matrix`) across every production purpose
  network, followed by real issuer/context/grant and native Runtime checks.
  Both shards block `Integration checks` when selected. The full authentication
  and Skill workflow remains Tier C `c-service-authentication-integration`.
  `b-gateway` also checks Gateway SIGTERM/SIGINT, upstream cancellation and
  restart through `gateway-shutdown`. `b-skills` runs the Runtime Controller
  archive package with the `e2e` Go overlay and a real Runtime image; this does
  not include the separate control-process crash diagnostics.
- **Tier C:** whole-platform scenarios whose rule spans services (stage 3a,
  authenticated shell stage 2 and lifecycle, lifecycle and workspace closeout,
  skill learning). Platform targets that test one service's rule, or behavior
  that is not settled, stay out of CI; `outsideCI` in `ci-changes.mjs` names
  the issue that moves each one to its service or re-admits it. At most six
  tier C shards run at a time, and every selected Tier C shard blocks
  `Integration checks`. The authenticated encryption-key rotation journey runs
  last in `c-skill-discovery`, independently of its ordinary authentication
  journey. The 22 `outsideCI` targets remain unfinished work in #165–#169;
  making the current catalog required does not deliver those replacements.
  Lifecycle and
  workspace foundation runners and the Stage 3a identity, tool permission and
  tool progress profiles exit 2 when business and topology checks pass but
  strict trace findings remain. The shard passes such a suite with a warning
  only when a final business/topology completion report is present and
  [`support/strict-findings.mjs`](support/strict-findings.mjs) finds
  no Jaeger warning other than clock skew adjustments in its output. Empty
  output, a failed prerequisite and incomplete business reports fail even if
  they exit 2; a later explicit failure invalidates a prior completion.
  Error spans on denial and cancellation paths
  are recorded by contract and checked by each runner's topology. The findings
  stay in the evidence artifact. The Stage 3a profiles run their make
  recipe directly because make reports every failed recipe as 2. Tool permission
  and tool progress build scoped Runtime candidates from the production Runtime
  and official fixture carrier. CI supplies those source images; each owning
  deployment still performs the final fixture COPY and verifies the original
  production layers, configuration and source identities.

Only the ten implemented service and Runtime images listed in
[`docs/service-layout.md`](../docs/service-layout.md#current-state) are published
as `ghcr.io/tf4fun/antnest-<image>:inputs-<hash>`,
where the hash covers the image's Dockerfile, `.dockerignore` and every path
the Dockerfile copies. Suites pull images that GHCR already has. The image job
builds each missing image once per run and hands it to the shards as an
artifact; shards that need no image start without waiting for it. Runs on
`main` build and publish every missing service/Runtime release image, so a pull
request that does not change a release image's inputs never rebuilds it.
Every shard job runs the steps in
`.github/workflows/_suite.yml`.

The local Temporal dependency image and three Runtime test variants
(`antnest-runtime-fixture`, `antnest-runtime-managed`,
`antnest-runtime-skill-gate`) are not release packages. Selected suites build
them once per run with GitHub Actions build caches and load them from that
run's image artifacts. They never query, pull or publish a GHCR package, even
if an old package still exists. Unselected dependencies and variants are not
built merely because a run is on `main`. Temporal remains a local build in
the base Compose deployment; its entrypoint and readiness checks are unchanged.
Image artifacts expire after one day; rerun the whole workflow if a shard's
required artifact has expired.

Runners never rebuild a provided image. The shard lists its images in
`ANTNEST_CI_PROVIDED_IMAGES`, and
[`support/candidate-images.mjs`](support/candidate-images.mjs) turns each
candidate build into a label-only build `FROM antnest/<image>:local` that
keeps the labels cleanup checks ownership with. Outside CI the runner builds
from source. The catalog also defines Runtime test variants: the `e2e` stage
with the Skill install gate, the managed MCP fixture alone and the release
image with that fixture. The image job builds them with their own cache.
The provided Runtime images passed the Dockerfile's `fmt`, `clippy` and test
gates when the image job built their inputs.

A manual run (`gh workflow run integration.yml --ref <branch> -f suites='<id> <id>'`)
runs only the named catalog suites, in their shards; without `suites` it runs
every suite. A targeted manual run reports `Integration checks (partial)` and
cannot satisfy the merge requirement. Drafts report `Integration checks (not
run)`. Other events retain the required name even if selection fails before
producing its outputs.

Each shard uploads `artifacts/verification/` (excluding fixture credentials,
private key files, environment files and the deployment credential-generation
log) as
the `evidence-<shard>` artifact. The `Integration checks` job is the single
required integration status; it fails if selection or any selected Tier A, B
or C shard fails, is cancelled, or unexpectedly skips. A matrix may skip only
when its validated selection count is zero, so a docs-only run still passes.
Workflow cancellation and invalid or missing selection counts fail the gate.
Add a suite by extending the catalog and naming it in one shard of its
tier; the catalog's unit tests check that every `make` target and runner it
names exists and that every suite belongs to exactly one shard. A suite with a `disabled` reason stays in the
catalog but is never selected until its known breakage is fixed.

A failed Stage 3a run (`tests/e2e/e2e-stage3a.sh`) omits raw service logs
because they may contain credentials. Instead it prints one
`{"startup_failures":[...]}` line from `tests/support/startup-failure-summary.mjs`.
That line covers each exited, restarting, OOM-killed or unhealthy container and
gives its exit code and health, the `msg` and `error.code` of its ERROR-level
structured records, and the first line of any panic or uncaught error. A field
containing a credential the run provisioned is replaced with
`[withheld: credential]`.

## Resource hygiene

- Run verification commands serially. A runner preserves the failure exit
  status, owns and reaps its child processes, and leaves none behind after
  interruption.
- Disposable Docker scenarios compare the Docker environment before and after
  the run. Every container, volume, network and candidate image a scenario
  creates is removed.
- `.cache/` holds only reproducible dependency and compiler caches. Test
  sources, manifests, fixtures, recovery inputs and lasting evidence never go
  there, even temporarily. `make test-storage-policy` (part of `make test`)
  checks the layout of the allowed cache directories and rejects cache aliases.
- Versioned test sources belong under `tests/`. Durable private logs,
  snapshots and backups belong under `artifacts/verification/`, which is
  excluded from Git and Docker build contexts. Credentials, saved environment
  files, database contents and machine-specific results stay private.
