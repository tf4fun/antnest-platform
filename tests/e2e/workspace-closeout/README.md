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
protocol Docker run. The separate C4 browser batch remains pending. The
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
ancestry and awaits separate C4 acceptance.

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
`make e2e-workspace-browser` (`browser-run.mjs`) runs it. It creates a
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

C4 remains a separate pending acceptance batch. The private protocol's
component wiring does not complete its browser Docker acceptance.

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
node tests/e2e/workspace-closeout/c4-run.mjs
```

`ANTNEST_C4_AGENT_UI_IMAGE`, `ANTNEST_C4_AGENT_ACP_IMAGE` and
`ANTNEST_C4_EDGE_GATEWAY_IMAGE` optionally select separately built candidate
images. The Runtime image is `antnest/antnest-runtime:local`. The runner uses
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

The script accepts `--gateway`, `--env-file` and `--secret-file`; the target
must be localhost. Real model calls incur usage.

The default flow requires empty provider, model, template and Agent
inventories. It logs in, connects the built-in DeepSeek model, creates a
template and Agent, waits for Runtime availability, follows Console's Open chat
link, sends a greeting, writes and reads `/workspace/acceptance-note.txt`,
reloads the conversation, and calls the read tool again. It also checks
collapsed tool activity, mobile overflow and the explicit Agent chooser.

To repeat only the chat flow on an existing Agent:

```sh
node tests/e2e/workspace-closeout/development-browser.mjs --confirm-development --agent agent_REPLACE_ME
```

This creates a new Session and overwrites only the synthetic
`/workspace/acceptance-note.txt` file. Never run it against business data.
Metrics and credential-free screenshots are written under
`artifacts/verification/development-acceptance/`. The stack and its data remain;
remove them through the Agent lifecycle API.

### Trace check

The development profile queries Jaeger after a six-second export wait.
`chat-trace.mjs` checks each prompt's Gateway SERVER -> Gateway CLIENT -> ACP
SERVER -> Run -> model/Runtime ancestry. It rejects duplicate or missing
parents, warnings and error spans, and verifies that content capture and
credentials are absent. Tool prompts must contain actual Runtime `tools/call`
SERVER spans. The profile requires RPC content capture to be disabled; the
`--jaeger` option defaults to `http://127.0.0.1:16686`.

```sh
node --test tests/e2e/workspace-closeout/chat-trace.test.mjs
```

Known clock-skew warnings between services still fail the strict check;
business, topology and timing results are reported separately.

Passing the deterministic fixture suites alone does not show that a real
external model responds correctly.
