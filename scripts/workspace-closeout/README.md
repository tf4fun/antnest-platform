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
