# Workspace State Integration

This disposable C4 profile uses the real Docker services behind Edge Gateway,
the official ACP SDK and a deterministic OpenAI-compatible model peer. The model
is the only synthetic business dependency; it requests real Runtime tools.
No production/provider credential or retained acceptance project is used.

## Scenarios

1. Member login, scoped state snapshot/watch, new/load Session and real Tool work.
2. Two Sessions contend for one Agent. A fresh connection cancels the owner's
   active Session after the original connection closes. Verify physical tool
   termination separately from the existing unknown-effect admission fence.
   An explicit administrator Disable/Enable must recover that fence without
   deleting workspace. This is not automatic recovery after cancellation.
3. A closed state observer misses completion. A replacement reads current state
   and ACP replay returns one history without resubmitting model/Tool effects.
4. Explicit rebuild is visible to an open state observer. Workspace bytes survive;
   later work uses the replacement Runtime and receives environment-change context.
5. Owner deactivation closes observation/admission. Invalid identity responses
   must not masquerade as ready state or disclose configuration/credentials.
6. Jaeger verifies actual parent/child ancestry from Gateway to Identity,
   Controller repository, ACP and Runtime; service-name presence is insufficient.

Run `node --test --test-concurrency=1 scripts/workspace-closeout/*.test.mjs`,
build current images serially with `make -j1 docker-build-stage3`, then run
`node scripts/workspace-closeout/run.mjs`. The runner reuses the lifecycle
fixture's scoped resource creation/cleanup and private service databases in one
PostgreSQL instance. An interrupted or failed run cleans only its own project.
Only compact final results are retained, never raw requests or credentials.

These protocol-driven scenarios supplement Agent UI component tests. Actual
desktop/mobile browser acceptance remains separately required before C4 closes;
a SDK client alone is not evidence of browser recovery or layout correctness.
Automatic reuse after cancelling an in-flight Runtime Tool is a pending product
decision: the current MCP cancellation drops the response and preserves unknown
effects, as documented in the earlier F02 acceptance. This profile must not
declare all of C4 accepted while that usability decision remains unresolved.

## Interactive Browser Acceptance

`node scripts/workspace-closeout/browser-run.mjs` creates a separate disposable
stack and prints its Gateway URL and synthetic member login. It generates only
known test uploads in a temporary directory; neither real credentials nor user
files are required. Use the browser's normal login and attachment picker.

1. Send `c4-browser-write`, then `c4-browser-read` in one conversation. Inspect
   the real bash/read results, default-collapsed activity and enabled composer.
2. Attach the generated `workspace-notes.md` and `sample.png`, send
   `c4-browser-attachments`, and inspect both previews and the reply. The model
   peer requires exact file/image bytes, not just a successful HTTP response.
3. Reload and re-enter the conversation. Check one copy of each message,
   attachment and Tool result, without another model or Tool execution.
4. At a narrow viewport create another conversation and send
   `c4-browser-mobile`; inspect navigation, composer and content bounds.
5. Enter `finish` on the runner's stdin. It independently checks exact model
   requests and workspace bytes, then removes only its own Docker resources and
   uploads. EOF, interruption or the 30-minute deadline also trigger cleanup,
   but are not passing acceptance. Browser observations are recorded separately;
   the runner does not assert screenshots or a complete C4 milestone.

## Real Provider Development Acceptance

The real-browser profile also queries Jaeger after a six-second export wait.
`chat-trace.mjs` checks each prompt's Gateway SERVER -> Gateway CLIENT -> ACP
SERVER -> Run -> model/Runtime ancestry, rejects duplicate/missing parents,
warnings and error spans, and verifies that content capture and credentials are
absent. Two tool prompts must contain actual Runtime `tools/call` SERVER spans.
Run `node --test scripts/workspace-closeout/chat-trace.test.mjs` for the reusable
positive and negative trace fixtures. This profile requires RPC capture disabled;
the `--jaeger` option defaults to `http://127.0.0.1:16686`.

`development-browser.mjs` exercises an already-running, disposable development
instance through the real Console and Agent UI. It does not mock ACP, the model,
or the Runtime, and deliberately retains the created data for human review.

From the platform repository root:

```sh
node scripts/workspace-closeout/development-browser.mjs --confirm-development
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
node scripts/workspace-closeout/development-browser.mjs --confirm-development --agent agent_REPLACE_ME
```

This mode creates a new Session on the existing Agent. It overwrites only the
synthetic `/workspace/acceptance-note.txt` file. It does not prove blank-instance
initialization again. Never run it against business data.

Final metrics and credential-free chat screenshots replace the previous files
under `.cache/development-acceptance/`. Scripts themselves live here, not in the
cache. Browser processes close on success or failure. The stack and acceptance
data remain; use the Agent lifecycle API for their eventual removal.

The deterministic fixture suites and `browser-run.mjs` have separate scopes.
Passing those fixtures alone is not evidence of a real external model response.
