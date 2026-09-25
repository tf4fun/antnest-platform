# Workspace State Integration

Current results and implementation boundaries are indexed in
[current status](../../../docs/current-status.md). The protocol entry and automated
C4 browser entry use current contracts, with separate scope and evidence.
The former manual four-scenario profile now runs as a repeatable browser test.
The [retirement audit](../../../docs/acceptance-retirement-audit.md) identifies old
orchestration/admission helpers; the [first cleanup](../../../docs/acceptance-retirement-revalidation.md)
removes that superseded graph. The shared byte checker and model peers still
have current consumers.

## Current protocol profile

`make e2e-workspace` runs `current-flow.mjs` through the disposable Foundation
setup with the installed official ACP SDK. The [migration contract](protocol-migration-contract.md)
and [revalidation report](../../../docs/workspace-protocol-revalidation.md) define
the six-field Gateway/ACP state, public execution audits, real bash
process cancellation, explicit Rebuild recovery, offline completion/replay,
replacement Runtime context and owner revocation/offboarding.

Run `make test-workspace-fixtures` first. The Docker profile requires the current
local application images, isolates its subnets and removes its own labeled
containers, volumes and networks even on failure. Evidence and raw traces are
private under `artifacts/verification/lifecycle-workspace/<project>/`; only reviewed summaries
belong in documentation. Exit 1 means business/topology failure; exit 2 retains
strict errors/timing warnings even if business and topology checks pass.

An in-flight Tool cancellation retains unknown effects and
`runtime_barrier_required` until explicit Rebuild replaces that Runtime. The
profile proves physical process exit separately from ACP's immutable unknown
Run facts. It does not claim automatic reuse, browser layout acceptance or a
complete C4 milestone. The superseded `flow.mjs` and Controller admission oracle
are retired; current state/request Trace checks remain.

## Current C4 Browser Revalidation

`c4-run.mjs` is the current-contract automated browser profile. It creates a
disposable project and synthetic member through Provider/Model/Template APIs,
uses real Gateway/ACP/Runtime services, and controls only the external model.
It covers uploads, model-capability rejection, tool approval, cross-Session
cancel during a held model request, offline completion, close/reopen, Rebuild,
member revocation, private-data boundaries and desktop/mobile layout.
Two real browser connections also observe the same Session: its activity time
must change after a new prompt, both pages must display the received title/time,
and a fresh list/load after reload must preserve those exact values.

After the service-owned tests/build and current Docker images are ready, run:

```sh
node --test --test-concurrency=1 tests/e2e/workspace-closeout/*.test.mjs
node tests/e2e/workspace-closeout/c4-run.mjs
```

`ANTNEST_C4_AGENT_UI_IMAGE`, `ANTNEST_C4_AGENT_ACP_IMAGE` and
`ANTNEST_C4_EDGE_GATEWAY_IMAGE` optionally select separately built candidate
images for the three services changed by the Bridge architecture.
The Runtime image is resolved from `antnest/antnest-runtime:local`. The runner
uses isolated subnets with separate fixed/dynamic address ranges and no host
Temporal port, so the retained development stack can remain running. It removes
its labeled containers, volumes and networks on completion/failure/interruption.
Reports, traces and screenshots are written to `artifacts/verification/c4-browser-<timestamp>/`.
Strict trace warnings retain a failing exit code even when browser checks pass.
The current driver uses same-origin HTTP/SSE and requires Gateway HTTP → Agent
UI Bridge → ACP HTTP Trace ancestry; it does not rely on ACP WebSocket frames.
See the [current evidence and limits](../../../docs/c4-browser-revalidation.md).
The later [ACP/Runtime/UI integration batch](../../../docs/acp-platform-integration.md)
records the combined candidate after the SDK and Session metadata fixes.

This cancellation scenario has no in-flight tool effect. Automatic recovery
after an unconfirmed tool effect remains a separate product-policy question;
the historical C4 milestone is not silently broadened or retroactively closed.

This disposable C4 profile uses the real Docker services behind Edge Gateway,
the official ACP SDK and a deterministic OpenAI-compatible model peer. The model
is the only synthetic business dependency; it requests real Runtime tools.
No production/provider credential or retained acceptance project is used.

## Former Workspace browser entry

`make e2e-workspace-browser` and `browser-run.mjs` now invoke the current C4
HTTP/SSE browser profile above. The four-scenario ACP WebSocket driver was
superseded by the Node Bridge UI: it waited for a composer immediately after
Agent selection and captured JSON-RPC browser frames that the current UI no
longer sends. The 2026-09-21 [migration contract](browser-migration-contract.md)
and [revalidation report](../../../docs/workspace-browser-revalidation.md)
remain historical evidence for that earlier candidate. The failed old-driver
run and successful current C4 run on 2026-09-25 are retained under
`artifacts/verification/final-regression-20260925/`.
The shared exact workspace-byte validator remains active in C4.

## Real Provider Development Acceptance

The real-browser profile also queries Jaeger after a six-second export wait.
`chat-trace.mjs` checks each prompt's Gateway SERVER -> Gateway CLIENT -> ACP
SERVER -> Run -> model/Runtime ancestry, rejects duplicate/missing parents,
warnings and error spans, and verifies that content capture and credentials are
absent. Two tool prompts must contain actual Runtime `tools/call` SERVER spans.
Run `node --test tests/e2e/workspace-closeout/chat-trace.test.mjs` for the reusable
positive and negative trace fixtures. This profile requires RPC capture disabled;
the `--jaeger` option defaults to `http://127.0.0.1:16686`.

The [2026-09-16 clock-skew maintenance decision](../../../docs/controller-acp-execution-boundary-plan.md#obs-acp-clock)
defers dedicated timing work for inspected, recorded clock warnings. Keep the
strict script failure and report business, topology and timing results separately;
the decision does not mark this browser profile passed. New or unexplained
warnings, structural defects, credential leaks and business errors retain their
existing checks. A small duration alone is not an exemption. Revisit the known
timing issue during an SDK upgrade or if its magnitude or diagnostic impact grows.

`development-browser.mjs` exercises an already-running, disposable development
instance through the real Console and Agent UI. It does not mock ACP, the model,
or the Runtime, and deliberately retains the created data for human review.

From the platform repository root:

```sh
node tests/e2e/workspace-closeout/development-browser.mjs --confirm-development
```

Prerequisites: the Stage 3 stack at `http://127.0.0.1:8090`, a locally available
`antnest/antnest-runtime:local` image, bootstrap credentials in `.env`, and
`DEEPSEEK_API_KEY` in `../.secret`. Install the Agent UI web dependencies and
Playwright Chromium first. The script accepts `--gateway`, `--env-file` and
`--secret-file`; the target must be localhost. Real model calls incur usage.

The default flow requires empty provider, model, template and Agent inventories.
It logs in, connects the built-in DeepSeek Flash model, creates a template and
Agent, waits for actual Runtime availability, follows Console's Open chat link,
sends a greeting, writes/reads `/workspace/acceptance-note.txt`, reloads the
conversation, and calls the read tool again. It also checks collapsed tool
activity, mobile overflow and the explicit Agent chooser.

To retry only chat acceptance without duplicating resources:

```sh
node tests/e2e/workspace-closeout/development-browser.mjs --confirm-development --agent agent_REPLACE_ME
```

This mode creates a new Session on the existing Agent. It overwrites only the
synthetic `/workspace/acceptance-note.txt` file. It does not prove blank-instance
initialization again. Never run it against business data.

Final metrics and credential-free chat screenshots replace the previous files
under `artifacts/verification/development-acceptance/`. Scripts themselves live here, not in the
cache. Browser processes close on success or failure. The stack and acceptance
data remain; use the Agent lifecycle API for their eventual removal.

The deterministic fixture suites and `browser-run.mjs` have separate scopes.
Passing those fixtures alone is not evidence of a real external model response.
