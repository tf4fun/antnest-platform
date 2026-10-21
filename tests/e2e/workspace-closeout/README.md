# Workspace E2E Suites

These suites exercise the Agent workspace end to end: private ACP execution
state, real Runtime tools, cancellation and recovery, and the Agent UI in a real
browser. Historical public-path fixtures retain the earlier Gateway admission
and stream baselines. Deterministic fixture tests run without Docker; the
profiles below start disposable Docker stacks.

Run the fixture tests first:

```sh
make test-workspace-fixtures
```

## Protocol profile

`make e2e-workspace` builds fresh scoped candidate images through the shared
authenticated shell entry and runs `current-flow.mjs` against a disposable
Foundation stack with the installed official ACP SDK. `current-flow.mjs` connects
`private-flow.mjs` and `protocol-business.mjs` to private ACP. Component wiring
and strict inventory/admission have passed local checks and a fresh-candidate
protocol Docker run. The separate C4 browser Docker batch has also passed. The
[protocol contract](protocol-migration-contract.md) defines the required result.

Workspace-owned private components are implemented and covered by fixture
tests:

- `private-connection.mjs` records actual initialization, requests and original
  notification receipts; its two deliberate Prompt disconnects require the
  original Error and connection-close receipt.
- `private-watch.mjs` preserves raw private SSE, stable event indices and a
  pre-revocation boundary; the denied terminal state must end at remote EOF.
- `private-authority.mjs` records each operation's actual Identity response and
  exports an Identity HTTP CLIENT with its original outgoing `traceparent`.
  The real service does not return a Trace header; its absence is preserved.
  `private-state.mjs` binds complete response bytes to its own exported HTTP
  CLIENT and preserves original reader and cleanup errors.
- `private-access.mjs` gives each connection, watch or state read a distinct
  authority scope using the original login. A denied new connection requires
  the actual Identity 401. Closing joins in-flight resource construction and
  state reads, closes connections and watches, then joins existing collectors
  before shutting down the exporter. Collector, archive and late parent-abort
  failures remain failures after their callers have observed them.
- `private-requests.mjs` projects each recorded RPC independently, binding its
  original input and result or typed rejection to the actual wire frames and
  connection/request IDs. Business annotations remain separate from raw rows;
  a damaged sibling does not prevent another request's Trace collection.
- `private-http-trace.mjs` binds original JSON state and SSE bytes, complete
  states and closure receipts to the actual exported HTTP CLIENT and ACP
  SERVER, including their readiness and protection reads. Local watch closure
  and revocation's denied terminal state with remote EOF have distinct gates.
- `private-authority-trace.mjs` validates each operation's original Identity
  response bytes, status, Session and Principal against the actual CLIENT,
  receiving Identity SERVER and token SELECT. It owns the exact original 401
  diagnostics for a denied new connection.
- `private-collectors.mjs` dispatches request, notification, state/watch,
  Identity and offboarding evidence to their owning inspectors. Collection
  requires three consecutive identical complete snapshots, including current,
  connection and source traces where applicable and late diagnostics. HTTP
  source collection archives original Jaeger response bytes with their lengths
  and SHA-256 hashes before inspection, retaining query, inspection and archive
  failures. Collection and archive errors are preserved together.
  Request convergence failure also retains the original owning assertions in
  the private failure archive.
- `private-flow.mjs` invokes the original business through its work adapter,
  preserves partial observations after failure and independently collects
  sibling evidence. It joins held requests, connections, watches and collectors
  before exporter shutdown, retaining original business, cleanup and late
  parent-cancellation errors. `protocol-business.mjs` keeps the original Run,
  audit, process-group, effects, Rebuild, offboarding and Delete assertions.
- `private-denial-trace.mjs` checks the original `access_denied` Prompt response
  and its three admission SELECTs, with no Run, Provider or Tool activity.
- `private-disconnect-trace.mjs` requires the original joined connection receipt
  for each held Prompt. Cancellation proves the unresolved Run and cancelled
  Bash chain; offline completion independently proves successful Bash work and
  its two Provider requests. Both preserve original diagnostics, Run identity,
  preparation, persistence and awaited model/Tool work. Copied receipts and
  successful RPC responses cannot authorize a disconnect exception.
  Physical process-start cancellation also accepts its owned pre-header abort
  without inventing HTTP response metadata, retaining the full unknown-effect
  execution chain. Other consumers keep their original response-start checks.
  Run completion and the closed v1 response are compared using the actual
  `SERVER → admission → Run` chain, with matching process, Agent and Session.
  Existing same-Node sub-millisecond SDK observations retain both original
  endpoints and the admission/receiver identities; the Run need not repeat its
  inherited Agent tags. The shared direct-parent timing checker is unchanged.
- `current-evidence.mjs` binds each actual Runtime ready response to the same
  container's Agent and generation before associating its execution ID with
  the Agent's Runtime revision.
- `private-evidence.mjs` binds the complete connection/request inventory, raw
  state and authority receipts, Runtime bindings, immutable audits and physical
  recovery records before admission. Each complete-source receipt names the
  exact original sources. Notification and HTTP diagnostics keep their precise
  owning operation and Span identities. Automatic Disable requires its original
  owner event and `settled` outcome for the rebuilt Runtime's completed work.
  Its public event has no private payload; the deterministic event ID binds the
  actual revocation sequence and Agent to the original source-linked Disable.

Protocol Docker acceptance has passed. The subsequent C4 browser batch separately proves the
retained Bridge's actual remote stream closure. The required protocol inventory
is five connections and initializations, eleven original business RPCs plus one
actual revocation probe, one cancel notification, two deliberate disconnects,
two state watches, three Runs, five Provider requests, two bash calls and one
read call. Four explicit lifecycle operations (Create, two Rebuilds and Delete)
remain separate from offboarding's automatic Disable.

The private protocol preserves the original business checks:

- the six-field ACP execution state and public execution audits;
- real bash process cancellation and explicit Rebuild recovery;
- offline completion and replay;
- replacement Runtime context;
- owner revocation and offboarding.

An in-flight Tool cancellation keeps unknown effects and
`runtime_barrier_required` until an explicit Rebuild replaces that Runtime. The
profile checks physical process exit separately from ACP's immutable unknown Run
facts. It does not cover automatic reuse or browser layout.

### Historical public-path and browser baselines

The Gateway Resolve, public watch and revocation rules below describe retained
historical public-path fixtures and browser test baselines. They do not require
Gateway ancestry for the current private protocol. Private ACP requests and
state observations begin at their actual exported CLIENT and ACP receiver;
their original Identity delegation is collected independently. Retired public
execution entries remain 404. The retained browser Bridge keeps its own Gateway
ancestry and has passed its separate C4 acceptance.

Each historical public ACP request proves its own Resolve admission before the
actual Gateway forwarding span. In that baseline, WebSocket messages and direct
HTTP ACP requests use the `acp` profile. WebSocket evidence selects the message using its actual
request ID and connection link; HTTP evidence uses the response Trace ID. The
selected message ID remains in failure reports even when source admission
fails. Complete Resolve sources are collected before awaiting the original
command, replay, barrier, cancellation or browser no-Tool inspector. Those
execution, persistence and Runtime-binding checks remain independent of cache
admission, and source diagnostics cannot clear their strict failures.

Each historical public state watch proves a successful `workspace` Resolve
decision before the Gateway starts its actual ACP watch. The initial decision and every later
revalidation use the shared `rpc/cache/shared` contract: cache admission needs a
valid snapshot and feed-proof budget; actual RPCs need their receiving Identity
SERVER and SQL. Shared decisions bind the exact archived CLIENT, with the
original request or refresh root and its cache trigger. Multiple shared waiters
may reuse one actual SQL owner; multiple RPC creators cannot claim one CLIENT.
Creator cancellation snapshots bind the actual same-process CLIENT started
within that decision. A watch's caller closure accepts `caller-cancelled`;
shutdown and shared deadlines cannot substitute for that cause. Cancelled
decisions cannot prove successful admission or an authoritative 401.
The collector archives current, source and trigger traces and requires three
consecutive identical complete snapshots before returning evidence.

Historical public-path revocation evidence records the actual authority request
Trace ID and observed remote-close window. A private feed may close the stream before a final
Identity 401: the oracle accepts only the directly owned Gateway response-read
failure paired with an interrupted ACP watch in that window.
`revocation_verified` requires a validated actual Identity denial; a cancelled
pending check alone does not prove it. Raw errors and clock warnings throughout
the collected traces still fail the strict check.

That public observer preserves the first closure's actual Trace ID, time and cause;
cleanup cannot relabel it. A pending unavailable Resolve additionally needs
that independent observation, a matching Gateway cancellation or private-feed
closure, and its exact source state. Global aborts and invalid states fail the
watch gate. Retained shared work may finish after the watch closes, but an
actual-client link cannot point to a CLIENT created after the cancellation
snapshot. A missing RPC CLIENT cannot distinguish caller cancellation from
preflight unavailability, so that case remains unverified. Unknown receiver
5xx and SQL errors also remain failures, including an Identity dependency 503
that might have resulted from query cancellation.

The public observer also records the Gateway's actual HTTP `Date` and host request /
response times. These bound the host-to-service clock offset, including the
header's one-second precision, when comparing the local close window with raw
Trace timestamps. The raw timestamps remain unchanged; the observer must be
live before local closure, and the remote-close wait remains bounded separately.

The protocol profile builds temporary application and Runtime candidates,
isolates its subnets, and removes its own images, labeled containers, volumes
and networks even on failure. Raw traces stay private under
`artifacts/verification/lifecycle-workspace/<project>/`. Exit code 1 means a
business, topology or unowned diagnostic failure. The summary retains the raw
strict exit code separately; accepted operation-specific diagnostics and the
existing clock warning class do not rewrite raw errors or timestamps.

## Browser profile

`c4-run.mjs` is the automated browser profile, and
`make e2e-workspace-browser` runs it through the shared fresh-candidate wrapper
and `browser-run.mjs`. The application images and Runtime use the same isolated
candidate tag, and the admission overlay follows the C4 image overrides.
It creates a
disposable project and synthetic member through the Provider, Model and Template
APIs, uses real Gateway, ACP and Runtime services, and controls only the
external model through a deterministic OpenAI-compatible peer. It covers:

- uploads and model-capability rejection;
- tool approval;
- cross-Session cancel during a held model request;
- offline completion, close and reopen;
- Rebuild and member revocation;
- private-data boundaries;
- desktop and mobile layout.

C4 has passed its separate fresh-candidate Docker acceptance: all twelve
browser checks, eleven Runs, fourteen Provider requests, four Tool calls and
fifteen complete Trace roots. Each root retains three stable original source
samples. Browser and process cleanup completed and the Docker inventory was
restored. The other consumer batches and final integration remain separate.

Browser reads use the current `/api/app/workspace/v1/agents/{agentId}/view`
contract, with the original browser session and exact requested Agent and
selected Session. The retired `/api/app/agents/{agentId}/state` route is not a
fallback. Validate the complete Bridge DTO before consuming it; private ACP
state fields must never be added to that public view. Rebuild's private
configuration revision is read independently through the fixture's original
member authority, while the browser view and composer prove public readiness.
Capture the nonempty browser Session before Rebuild and retain that exact
selection through completion and the next prompt. A newly selected Session or
a draft cannot stand in for retained history. The private revision changes on
a new Rebuild even with the same template revision because it includes the
execution identity and Runtime configuration; it is not the browser epoch or
Session configuration token.

Revocation observes the actual page-owned EventSource request. Before changing
the member, freeze one live 200 SSE response for the original Agent, Session and
browser Cookie, including its original request path/cursor, Trace ID and HTTP
Date. Only that request's normal remote EOF after the trigger and within 30
seconds can satisfy browser transport closure. A host-created stream, HTTP
failure, preclosed stream, local EventSource close, navigation, page/context
cleanup or copied checkpoint cannot replace it. Observation must not open or
modify network requests. Keep asynchronous observation errors and join them on
every exit path. The transport receipt alone does not prove the revocation
cause; its owning Trace and denial/zero-execution checks remain separate gates.

Capture the actual page login response and bind its Principal and issued Cookie
pair to that browser. The setup client's separate member login cannot replace
this authority. Preserve the original administrator's Principal and complete
deactivation response as the cause receipt. After the original remote close, send one Prompt
with the original Cookie/CSRF pair to the same Gateway, Agent and selected
Session. Retain its raw refusal and compare the complete Run details, execution
events and model inventory before and after revocation; no new or changed work
is allowed.

The observer retains a truncated chunked response as `transport-end` with its
original browser failure. That observation alone proves no authorization cause.
Final acceptance requires the original Gateway failure diagnostics and Identity
revocation feed bound to the administrator mutation. Local abort, navigation
and browser cleanup cannot replace that evidence; normal EOF stays `remote-end`.

Before navigation, the observer attaches an independent Chromium CDP session.
It binds the original network request, response and EOF by main frame, document
loader, complete URL, method, request ID and response Trace ID. The existing
Playwright callback timestamps remain unchanged. Browser `TimeTicks` samples
from `Performance.getMetrics` are bracketed by host monotonic observations;
validation retains the complete calibration interval and observed drift,
rather than treating callback delivery as request dispatch. Failed observation
also preserves the allowlisted native records and clock samples, without
request headers, Cookies or response bodies.

An original native EOF interval wholly before the live checkpoint is rejected. The exact
request-to-EOF interval also bounds the Gateway revocation-feed event, so a
delayed callback cannot move closure after the mutation. A server handler's
epilogue may finish after the browser receives its body; HTTP receipt binding
checks the same-process SERVER start, while C4 feed closure uses the original
termination event and still requires the complete owning revocation proof.
Bridge SDK evidence cannot opt into the page-owned C4 rules.

The C4 Trace inspector binds the original page login window and committed token
issuance to the actual SSE, then reuses the existing directory mutation,
committed revocation/feed, denial and stream-termination checks. Automatic
Disable uses the real public owner/disabled events and settled Runtime proof;
it must not fabricate private event payloads or SDK request fields. These
components have local coverage. The concrete runner now collects and admits
their original evidence independently of business, archival and cleanup
failures. This complete path has passed real Docker acceptance.

The separately tested `c4-flow.mjs` orchestration retains independent business,
collection, archival and cleanup failures. Parent cancellation joins the current
step and prevents later business/evidence steps; an invalid collection inventory
still reaches cleanup. Cancellation during final persistence writes back a
failed verdict. `c4-run.mjs` uses this orchestration with the concrete actions
and admission in `c4-actions.mjs`.

The original page Prompt response supplies the Trace ID even when audio is
rejected before any Provider request. Failed response bodies and body-read
failures retain that original ID for independent collection. The complete
inventory requires eleven Runs, fourteen Provider requests and four Tool calls;
it binds exact attachment input, the observed cancellation, four Sessions and
the initial/rebuilt Runtime generations. Runtime observations read the actual
container, retained workspace and fresh ready status before their corresponding
Prompts. Partial collection keeps both browser and audit Provider observations,
including conflicts, without allowing an incomplete inventory to pass. These
inventory and Runtime components are bound to complete collector/admission
checks and have passed real Docker acceptance together.

Collection archives fifteen independent original roots: eleven Prompts plus
the page login, SSE, administrator mutation and post-revocation denial. Each
root requires three stable samples of its complete source union. Admission
re-inspects the archived HTTP bytes, exact source hashes and original business
inventory. A partial failure still archives every known root. Proved audio,
cancellation and revocation diagnostics retain their raw strict failure; only
the owning contract can accept them. Unowned errors or warnings fail admission.
The revocation inventory copies the original offboarding identities. Its
diagnostic check preserves the empty error code emitted on Runtime success and
the Controller's empty read-only Disable replay: only the proved schedule or
admission may own the BEGIN/empty SELECT/ROLLBACK sequence. Write rollbacks,
nonempty replay failures and additional diagnostics remain failures.

`c4-run-trace.mjs` checks each original page Prompt against its Bridge Run,
both Run/model snapshot bindings, actual finish CTE and complete Runtime
information/tool exchanges. The audio capability failure requires one local
model failure and zero Provider/Tool calls. The held cancellation keeps its
actual Run and Provider cancellation proof separate from Runtime cleanup.
The post-prompt Skill catalog read is optional, including after audio rejection;
the service may yield to active work. Run preparation remains required, and any
actual catalog refresh must retain its complete read and cleanup proof.
Validation views remove only independently proved diagnostics; archives and
strict results retain the complete original traces and timing observations.

The browser scope owns context/browser closure and joins every finite response
read and page observer after success, failure or interruption. A failed context
startup still closes its browser. Business, capture, parent cancellation and
independent cleanup errors retain their original identities; one failed cleanup
must not skip later observers or mask the original business failure.
Awaiting a tracked response still rejects with its original failure. Page errors
are recorded when they arrive, so a later business failure cannot skip them;
an unexpected browser WebSocket also remains a failure on every exit path.
Each page joins its observed finite HTTP response reads before an explicit
navigation, reload or close; all pages drain before going offline or normal
context closure. This group excludes SSE and future bootstrap waiters, which
still belong to the browser scope. Failed reads retain their original errors
and response URL/last completed check and block admission. Failure and
cancellation cleanup still closes resources before joining blocked readers.
One body-audit exclusion is a same-Gateway, main-frame, unredirected
`GET /api/app/workspace/v1/bootstrap` returning 401 without query parameters.
The page consumes that denial and navigates to login itself; the browser SDK
cannot retain its body reliably across that navigation. The observer records
the original URL, status, Trace ID and last completed check, explicitly marks
the body unobserved, and does not count it as a scanned payload. Successful
bootstrap responses and other denials normally retain the body audit.
For the original revocation page, a finite read may instead report the browser
SDK's exact `Network.getResponseBody` resource-unavailable/navigation error.
The observer freezes the original GET URL, status (200, 401 or 403), Trace ID,
main frame and redirect identity before reading. Only bootstrap without query
parameters or the current Agent's view with one exact Session parameter can
qualify. That read must be pending when revocation starts or begin during it,
and cross the same document's automatic navigation to the same Gateway login.
An optional, unique `return_to` must name that Agent/Session document route;
explicit harness navigation, other documents, statuses and errors remain failures.

Such a diagnostic stays pending until the full browser, execution and collected
Trace owning gates pass. Its original error and response metadata remain private;
the body is `not_observed`, contributes zero scanned payloads, and is included in
`browser_bodies_unobserved`. `browser_payloads_checked` counts only bodies actually
read, with `browser_payload_coverage=observed_bodies_only`. No retry or SDK change
is made, and historical errors without their original status cannot be admitted
using this rule. Remote SSE closure, the original authenticated Prompt refusal,
login recovery, cleared UI and no-new-execution checks remain required.

Two real browser connections observe the same Session. Its activity time must
change after a new prompt, both pages must display the received title and time,
and a fresh list/load after reload must preserve those values.

The HTTP Bridge uses the `workspace` Resolve profile and must retain the actual
Gateway → Agent UI → ACP prompt → Run ancestry. Each model-fixture request binds
its exact Provider CLIENT and `model.complete` parent inside that Run, which must
retain successful terminal SQL. Current, shared-source and refresh-trigger
traces are archived in `traces/` and must converge across three full snapshots.

Before Stop, the browser records the member's actual Bridge view and its unique
ACP-accepted Run. Only the declared held-model cancellation phase may classify
the single observed Provider disconnect: it requires that exact Run to finish
cancelled and quiescent without Tool effects, with successful terminal SQL. The
model error must point back to the actual HTTP CLIENT failure. Other Gateway,
Bridge, ACP, SQL or Tool errors still fail business validation. Expected
cancellation retains raw errors and strict failure; every trace must have an
explicit strict verdict, and unknown source warnings still fail CI review.

```sh
node --test --test-concurrency=1 tests/e2e/workspace-closeout/*.test.mjs
make e2e-workspace-browser
```

The Make target builds fresh images and removes its candidate image references
after acceptance. Direct `node tests/e2e/workspace-closeout/c4-run.mjs` remains a
local development entrypoint using local images, including
`antnest/antnest-runtime:local`. The C4 bootstrap Organization name is `Stage 3`,
matching its page-login and stream contracts. The runner uses
isolated subnets and no host Temporal port, so a development stack can keep
running, and it removes its labeled resources on completion, failure or
interruption. Reports, traces and screenshots are written to
`artifacts/verification/c4-browser-<timestamp>/`. Exit code 1 means a browser,
business or topology failure; exit code 2 means only strict trace warnings
remain. The final JSON line lists each trace's warnings, so the CI shard gate
can accept reviewed clock-skew warnings and fail on any other.

The browser uses same-origin HTTP/SSE, and the trace check requires Gateway HTTP
-> Agent UI Bridge -> ACP HTTP ancestry. The cancellation scenario has no
in-flight tool effect; automatic recovery after an unconfirmed tool effect is
out of scope.

## Real-provider development profile

`development-browser.mjs` drives an already-running disposable development
instance through the real Console and Agent UI. It does not mock ACP, the model
or the Runtime, and it keeps the created data for human review.

```sh
node tests/e2e/workspace-closeout/development-browser.mjs --confirm-development
```

Prerequisites:

- the Stage 3 stack at `http://127.0.0.1:8090`;
- a local `antnest/antnest-runtime:local` image;
- bootstrap credentials in `.env`;
- `DEEPSEEK_API_KEY` in `../.secret`;
- the Agent UI web dependencies and Playwright Chromium.

The script accepts `--gateway`, `--env-file`, `--secret-file` and `--output`;
the target must be localhost. Each run requires a fresh output directory.
Real model calls incur usage.

The default flow requires empty provider, model, template and Agent
inventories. It logs in, connects the built-in DeepSeek model, creates a
template and Agent, waits for Runtime availability, follows Console's Open chat
link, sends a greeting, writes and reads `/workspace/acceptance-note.txt`,
reloads the conversation, and calls the read tool again. It also checks
collapsed tool activity, mobile overflow and the explicit Agent chooser.

Each prompt retains its original Bridge POST receipt and waits for that exact
operation's completed Run and projected turn. The driver reads all content and
process pages, checks the current turn's answer and completed tools, and compares
the restored Session and history after reload. Every Prompt POST is counted,
including failed requests, so reload cannot silently resubmit a prompt.

To repeat only the chat flow on an existing Agent:

```sh
node tests/e2e/workspace-closeout/development-browser.mjs --confirm-development --agent agent_REPLACE_ME --output artifacts/verification/development-repeat
```

This creates a new Session and overwrites only the synthetic
`/workspace/acceptance-note.txt` file. Never run it against business data.
The default output is `artifacts/verification/development-acceptance/`.
Original login Cookies, mutation receipts, complete views, turn pages and Trace
sources remain in private evidence alongside screenshots. The final report is
saved after browser tasks and resources are joined; cleanup or final-save
cancellation prevents a passing result. The stack and its data remain; remove
them through the Agent lifecycle API.

### Trace check

The development profile queries Jaeger after a six-second export wait.
`../development/chat-trace.mjs` binds exactly three Traces to the original
Bridge receipts and completed Runs. It requires Gateway HTTP -> Agent UI
Bridge -> ACP HTTP -> Run -> model/Runtime ancestry and matching Agent and
Session identities. It rejects duplicate or missing parents, internal error
spans and unreviewed warnings, and verifies that content capture and credentials
are absent. Both tool prompts must contain actual Runtime `tools/call` SERVER
spans. Raw sources are saved before review. The profile requires RPC content
capture to be disabled; `--jaeger` defaults to `http://127.0.0.1:16686`.

```sh
node --test --test-concurrency=1 tests/e2e/development/chat-trace.test.mjs tests/e2e/workspace-closeout/chat-trace.test.mjs
```

Known clock-skew warnings between services retain a failing strict verdict and
their original timestamp diagnostics without blocking the reviewed Development
result. Business, topology and timing results are reported separately.

Passing the deterministic fixture suites alone does not show that a real
external model responds correctly.
