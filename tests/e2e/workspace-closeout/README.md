# Workspace E2E Suites

These suites exercise the Agent workspace end to end: Gateway and ACP execution
state, real Runtime tools, cancellation and recovery, and the Agent UI in a real
browser. Deterministic fixture tests run without Docker; the profiles below
start disposable Docker stacks.

Run the fixture tests first:

```sh
make test-workspace-fixtures
```

## Protocol profile

`make e2e-workspace` runs `current-flow.mjs` against a disposable Foundation
stack with the installed official ACP SDK. The
[protocol contract](protocol-migration-contract.md) defines what it asserts:

- the six-field Gateway/ACP execution state and public execution audits;
- real bash process cancellation and explicit Rebuild recovery;
- offline completion and replay;
- replacement Runtime context;
- owner revocation and offboarding.

An in-flight Tool cancellation keeps unknown effects and
`runtime_barrier_required` until an explicit Rebuild replaces that Runtime. The
profile checks physical process exit separately from ACP's immutable unknown Run
facts. It does not cover automatic reuse or browser layout.

Each state watch must prove a successful `workspace` Resolve decision before
the Gateway starts its actual ACP watch. The initial decision and every later
revalidation use the shared `rpc/cache/shared` contract: cache admission needs a
valid snapshot and feed-proof budget; actual RPCs need their receiving Identity
SERVER and SQL. Shared decisions bind the exact archived CLIENT, with the
original request or refresh root and its cache trigger. Multiple shared waiters
may reuse one actual SQL owner; multiple RPC creators cannot claim one CLIENT.
The collector archives current, source and trigger traces and requires three
consecutive identical complete snapshots before returning evidence.

Revocation evidence records the actual authority request Trace ID and observed
remote-close window. A private feed may close the stream before a final
Identity 401: the oracle accepts only the directly owned Gateway response-read
failure paired with an interrupted ACP watch in that window.
`revocation_verified` requires a validated actual Identity denial; a cancelled
pending check alone does not prove it. Raw errors and clock warnings throughout
the collected traces still fail the strict check.

The observer preserves the first closure's actual Trace ID, time and cause;
cleanup cannot relabel it. A pending unavailable Resolve additionally needs
that independent observation, a matching Gateway cancellation or private-feed
closure, and its exact source state. Global aborts and invalid states fail the
watch gate. Retained shared work may finish after the watch closes, but an
actual-client link cannot point to a CLIENT created after the cancellation
snapshot. A missing RPC CLIENT cannot distinguish caller cancellation from
preflight unavailability, so that case remains unverified. Unknown receiver
5xx and SQL errors also remain failures, including an Identity dependency 503
that might have resulted from query cancellation.

The observer also records the Gateway's actual HTTP `Date` and host request /
response times. These bound the host-to-service clock offset, including the
header's one-second precision, when comparing the local close window with raw
Trace timestamps. The raw timestamps remain unchanged; the observer must be
live before local closure, and the remote-close wait remains bounded separately.

The profile requires the current local application images, isolates its
subnets, and removes its own labeled containers, volumes and networks even on
failure. Raw traces stay private under
`artifacts/verification/lifecycle-workspace/<project>/`. Exit code 1 means a
business or topology failure; exit code 2 means strict errors or timing warnings
remain even though business and topology checks passed.

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

Two real browser connections observe the same Session. Its activity time must
change after a new prompt, both pages must display the received title and time,
and a fresh list/load after reload must preserve those values.

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
