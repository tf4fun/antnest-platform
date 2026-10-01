# Managed MCP E2E

This disposable scenario verifies managed stdio MCP servers inside the Runtime,
together with Agent Rebuild while a Run is active. It uses the real Controllers,
PostgreSQL, Temporal, Runtime, ACP service, Gateway and Jaeger; only the
Provider is deterministic. The stdio child uses the installed Rust MCP SDK and
runs inside the Runtime as UID/GID 1000. The [fixture contract](contracts.md)
defines the required behavior.

## Running

Run serially, with the current local service images (`make docker-build-stage3`)
and Docker available:

```sh
docker build --target build -f runtimes/antnest-runtime/Dockerfile -t antnest/antnest-runtime:managed-build .
docker build -f tests/e2e/managed-mcp/Dockerfile -t antnest/antnest-runtime:managed-integration .
make test-managed-mcp-fixtures
make e2e-managed-mcp-v1
make e2e-managed-mcp-v2
```

The build target runs the Rust child's official-client handshake and catalog
test before copying the executable into the test-only
`antnest/antnest-runtime:managed-integration` image. The production Runtime
image is unchanged. The child declares the installed SDK's `2026-07-28`
protocol; legacy handshake fallback is covered by separate Runtime tests. The
same image is used by the [Tool progress](../acp-progress/README.md) and
[Tool permission](../acp-permissions/README.md) scenarios.

The flags `ANTNEST_E2E_MANAGED_MCP=true` and
`ANTNEST_E2E_MANAGED_MCP_VERSION=1|2` select this profile; v1 is the default.
The parent creates an isolated Compose project with separate service databases,
uses synthetic local accounts, reads no `.env` or `.secret` file and calls no
external LLM. Temporal has no host port; Gateway, PostgreSQL and Jaeger bind only
to dynamically selected loopback ports. Do not run another build or test profile
concurrently.

## Scenario

Provider, Model and Template setup uses public Admin Console APIs. Templates
reference a stable Model ID, and the Agent uses the returned Template revision.
No fixture writes another service's database. Read-only Runtime operation
inspection corroborates Create, Rebuild and Delete; the Console execution audit
corroborates ACP Runs.

Six successful Runs make 15 Provider requests and nine real Tool calls:

1. `managed-bootstrap` writes workspace guidance and a Personal Skill.
2. `managed-exercise` sees the guidance and the Skill summary and locator
   without its full body, handles an ordinary alpha Tool error, then calls alpha
   successfully.
3. `managed-mutate` edits the guidance. `managed-fresh` sees that edit
   immediately and proves child reuse through the next process counter.
4. A new beta Template revision leaves the Agent's built configuration intact.
   `managed-draining` holds two Provider responses around its two alpha calls.
   While each response is held, the exact Rebuild remains in drain, ACP's busy
   Session is closed to new work, the durable Run is running and the original
   Runtime stays healthy and unchanged. Another Session gets the precise
   `-32020 / agent_busy / retryable=false` error without a Run or Provider call.
   The second hold proves that completed Tools alone do not release the Run.
5. After the final response, ACP completes settlement and the Rebuild replaces
   the Runtime. `managed-rebuilt` uses the existing connection, and beta's new
   counter starts at one. Guidance, Skill and workspace survive replacement.
6. Reconnect and load (v1) or resume from the start (v2) preserves all six
   inputs, Tool IDs and results, and answers in order, without executing work.
   v2 completion is the authoritative `idle/end_turn`, not the immediate prompt
   acknowledgement. Delete reclaims the Agent's Runtime container and workspace
   volume.

The drain checks use explicit barriers and service-owned observations, never
comparisons between independent clocks.

## Trace checks

Final lifecycle Traces prove publication, settlement and the Temporal activities
for the same operation. Each model request identifies the HTTP CLIENT span under
`model.complete`, with fresh Runtime information and catalog preparation, a
pinned execution snapshot, Runtime dispatch descendants and PostgreSQL Run
closure. SDK JSON-RPC IDs identify each independent Gateway request Trace.
Rejections and replay must have no Run, model or Runtime execution. Privacy
checks cover encoded cookies, credentials, the child environment, guidance and
full Skill content. This profile uses the per-request oracle in
`request-trace.mjs`; `trace.mjs` keeps the connection-wide oracle used by other
scenarios.

Business and topology diagnostics are reported separately from the strict gate.
Clock warnings and lifecycle Docker absence-probe ERROR spans keep the strict
gate nonzero, and the script never reports an overall pass when strict checks
fail. Raw evidence stays in the private
`artifacts/verification/managed-mcp/<project>/managed-traces/` directory.

## Cleanup

The parent removes all owned containers, volumes and networks on success or
failure. Agent deletion also reclaims the Runtime container and workspace
volume.

## Not covered

Unknown in-flight Tool effects and process crash recovery are covered by
[ACP restart](../acp-restart/README.md).
