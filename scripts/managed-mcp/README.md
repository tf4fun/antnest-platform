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
ANTNEST_E2E_MANAGED_MCP=true sh scripts/e2e-stage3a.sh
```

Do not run this profile concurrently with another build/test profile. The parent
script creates an isolated Compose project, one PostgreSQL instance with separate
service databases/roles, synthetic login accounts and a disposable Runtime
workspace. It removes its resources on both success and failure. It does not read
`.secret`, use external LLMs, or reset an existing development instance.

Internal catalog RPC seeds the synthetic model profile. Template creation/revision
including MCP command/environment, Agent creation, rebuild, deletion, login and
chat use Gateway product entrypoints and Console BFF. No test writes another service's
database directly. The test-only image adds a fixture executable; the production
Runtime image remains unchanged.

## Required Outcomes

1. Create an Agent with child `alpha`, and use Runtime `write` to produce
   `AGENTS.md` and a Personal Skill.
2. Next Run sees guidance and Skill summary/locator, not the full Skill body.
   An ordinary child tool error returns to the model; the next tool succeeds.
3. Another Run updates guidance. A following Run sees the update without a
   rebuild, and the managed child counter proves process reuse across Runs.
4. Publish a revision with child `beta`, explicitly rebuild via Gateway, load
   the same Session, and verify the new catalog, retained workspace and new child.
5. Inspect actual Jaeger spans: Runtime information and tool calls descend from
   Gateway, and have Runtime descendants. Shared trace IDs or service presence
   alone cannot satisfy the assertion. No process secret, guidance or Skill body
   may appear in trace payloads.

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
