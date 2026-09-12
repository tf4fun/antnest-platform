# Managed MCP Docker Acceptance

This is an extension of `scripts/e2e-stage3a.sh`, not another production service.
It exercises real Controllers, PostgreSQL, Runtime, ACP, Gateway and Jaeger.
Only the model is deterministic; the managed stdio child uses the official Rust
MCP SDK and runs as UID/GID 1000 inside the actual Runtime.

## Run Serially

From the repository root, with Docker available:

```sh
make docker-build-stage3
docker build --target build -f runtimes/antnest-runtime/Dockerfile -t antnest/antnest-runtime:managed-build .
docker build -f scripts/managed-mcp/Dockerfile -t antnest/antnest-runtime:managed-integration .
make test-managed-mcp-fixtures
cargo test --manifest-path runtimes/antnest-runtime/Cargo.toml --locked --example managed-mcp-fixture
ANTNEST_E2E_MANAGED_MCP=true sh scripts/e2e-stage3a.sh
ANTNEST_E2E_MANAGED_MCP=true ANTNEST_E2E_MANAGED_MCP_VERSION=2 sh scripts/e2e-stage3a.sh
```

Do not run this profile concurrently with another build/test profile. The parent
script creates an isolated Compose project, one PostgreSQL instance with separate
service databases/roles, synthetic login accounts and a disposable Runtime
workspace. It removes its resources on both success and failure. It does not read
`.secret`, use external LLMs, or reset an existing development instance.
The version selector defaults to stable v1; only `1` and `2` are accepted.
Run each version separately and serially. Both execute the same six business
phases; v2 uses its official SDK, `state_update` completion and `resume` replay,
not v1's prompt result or `load` method.

Internal catalog RPC seeds the synthetic model profile. Template creation/revision
including MCP command/environment, Agent creation, rebuild, deletion, login and
chat use Gateway product entrypoints and Console BFF. No test writes another service's
database directly. The test-only image adds a fixture executable; the production
Runtime image remains unchanged.

The example child speaks the current SDK's `2026-07-28` discovery protocol.
Its official-client handshake/catalog regression runs in `make test-rust` and
the image build, so a stale version declaration fails before deployment. Actual
pre-discovery child fallback is covered separately by Runtime's SDK tests;
this profile does not impersonate a legacy server using a modern SDK handler.

## Required Outcomes

1. Create an Agent with child `alpha`, and use Runtime `write` to produce
   `AGENTS.md` and a Personal Skill.
2. Next Run sees guidance and Skill summary/locator, not the full Skill body.
   An ordinary child tool error returns to the model; the next tool succeeds.
3. Another Run updates guidance. A following Run sees the update without a
   rebuild, and the managed child counter proves process reuse across Runs.
4. Admit `managed-draining` on `alpha`. Hold its second model response after
   the first echo (process counter 3), then publish a `beta` revision through
   Gateway. Publication alone must not change the Agent or Runtime.
5. Request explicit rebuild. Before releasing the held response, observe an
   actual matching lifecycle worker drain span, not just the initial operation
   row. The Agent keeps its published available projection with the rebuild
   operation attached; its Runtime remains healthy with the same
   execution/revision, and another Session's prompt rejects with
   `agent_rebuilding` without a model request or Tool execution.
6. Release the model response. The original Run executes its second `alpha`
   echo (counter 4); hold its final model answer and again verify a fresh drain
   observation and the unchanged Runtime. Completed Tools alone do not release
   a Run admission. Release the answer; only after admission closure may rebuild
   complete (HTTP response arrival order is not the synchronization contract). Load the
   same Session and verify `beta`, retained guidance/Skill/workspace, a new
   Runtime execution and a fresh managed-child counter 1. Replay must not call
   the model or Tools. A pre-rebuild connection cannot admit a new Run after
   the access revision has changed; reconnect restores use.
   For `session/prompt`, the captured revision is checked by Controller Run
   admission: the exact error is `-32021 / access_denied / retryable=false`.
   Other Session operations use ACP's explicit binding check and may instead
   return `connection_binding_stale`; that is not the Prompt path's contract.
   A v2 prompt acknowledgment is not completion. Each successful Run must
   progress from `running` to exactly one `idle/end_turn`; both held responses
   must leave the Run unfinished. Replay must retain terminal Tool IDs/results
   and the unified user/Tool/answer order, including all five historical answers.
   v2 emits exactly one idle after the business history; setup/catalog
   notifications may follow it.
   v1 does not echo the initiating user's input during live execution. On load,
   require exactly one persisted input matching each sent phase, with a nonempty
   unique message ID before that Run's Tool/answer sequence. Compare the received
   Tool/answer identities and content against live output; do not drop replayed
   user messages just to make the two notification streams equal.
   Because this scenario deliberately rejects a stale prompt in the same
   Session before reconnecting, its latest intent is failed: replay must report
   `idle/_failed`, while retaining prior successful Tool results and answers.
   The later `managed-rebuilt` Run must complete with `idle/end_turn`.
   The rejected second Session must receive no notifications on either version.
7. Inspect actual Jaeger spans: Runtime information and tool calls descend from
   Gateway, and have Runtime descendants. Shared trace IDs or service presence
   alone cannot satisfy the assertion. No process secret, guidance or Skill body
   may appear in trace payloads.

The C1-05 active-Run batch uses a bounded HTTP barrier rather than an assumed
sleep duration. Read-only Runtime Controller inspection corroborates the
public Agent projection; no fixture writes any service database. Six successful
phases require 15 distinct model requests and nine actual Tool calls. This does
not accept unknown in-flight Tool effects or crash recovery during rebuild;
those are separate closeout cases. Stable-v1 and draft-v2 Docker profiles passed
serially on 2026-09-10. Each has 15 model requests, nine Tool calls and two
execution traces (v1: 1,002 spans; v2: 1,020). Both holds on each version had
fresh drain-worker observations, and all owned resources were removed before
final evidence publication. All 31 managed-MCP Node tests passed, within 161
shared fixture/oracle tests. The v2 extension reuses the existing verified SDK
fixture image; it does not require or claim a new production image build.

Each model request's actual parent span is matched to its admission. Every Run
must have exactly one completed information read and catalog discovery before
its first model request. The oracle also rejects appended old guidance, duplicate
Runtime blocks, non-ACP spans impersonating the client, or a Runtime span used
as its own descendant. Fixture tests run in `make test-node`; formatting is part
of `make fmt-check`.

`model.mjs` rejects incorrect actual model requests rather than returning canned
success unconditionally. `fixtures.test.mjs` tests negative oracle cases, including
stale guidance, leaked full Skill context, process restart and disconnected spans.
`client.mjs` emits one compact final result; complete trace/model dumps are not
committed. Existing Runtime E2E separately tests background Bash survival and
targeted cancellation, child exit and failed initialization.
