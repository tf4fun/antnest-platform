# Managed MCP Docker Acceptance

This disposable integration profile exercises real Controllers, PostgreSQL,
Temporal, Runtime, ACP, Gateway and Jaeger. Only the Provider is deterministic.
The stdio child uses the installed Rust MCP SDK and runs inside Runtime as
UID/GID 1000. The [fixture contract](contracts.md) defines this migration batch;
[revalidation evidence](../../docs/managed-mcp-revalidation.md) records its result.

## Run serially

With current local service images and Docker available:

```sh
docker build --target build -f runtimes/antnest-runtime/Dockerfile -t antnest/antnest-runtime:managed-build .
docker build -f scripts/managed-mcp/Dockerfile -t antnest/antnest-runtime:managed-integration .
make test-managed-mcp-fixtures
make e2e-managed-mcp-v1
make e2e-managed-mcp-v2
```

`make docker-build-stage3` builds service images if needed. The build target
runs the Rust child's official-client handshake/catalog test before copying the
executable into the test-only image. The production Runtime image is unchanged.
The child declares the installed SDK's `2026-07-28` protocol. Legacy handshake
fallback is covered by separate Runtime tests.

The parent creates an isolated Compose project and separate service databases,
uses synthetic local accounts, reads no `.env`/`.secret`, calls no external LLM,
and cleans owned resources on success or failure. Temporal has no host port;
Gateway, PostgreSQL and Jaeger bind only to dynamically selected loopback ports.
Do not run another build/test profile concurrently. The existing flags
`ANTNEST_E2E_MANAGED_MCP=true` and `ANTNEST_E2E_MANAGED_MCP_VERSION=1|2` select
this same independent profile; v1 is the default.

## Current behavior

Provider/Model/Template setup uses public Console APIs. Templates reference a
stable Model ID and the Agent uses the returned Template revision. No fixture
writes another service's database. Read-only Runtime operation inspection
corroborates Create/Rebuild/Delete; Console execution audit corroborates ACP Runs.

Six successful Runs make 15 Provider requests and nine real Tool calls:

1. `managed-bootstrap` writes workspace guidance and a Personal Skill.
2. `managed-exercise` sees guidance and Skill summary/locator without its full
   body, handles an ordinary alpha Tool error, then successfully calls alpha.
3. `managed-mutate` edits guidance. `managed-fresh` sees that edit immediately
   and proves child reuse through the next process counter.
4. A new beta Template revision leaves the Agent's built configuration intact.
   `managed-draining` holds two Provider responses around its two alpha calls.
   While each response is held, the exact Rebuild remains in drain, ACP's busy
   Session is closed to new work, the durable Run is running and the original
   Runtime remains healthy and unchanged. Another Session gets the precise
   `-32020 / agent_busy / retryable=false` error, without a Run or Provider call.
   The second hold proves completed Tools alone do not release the Run.
5. After the final response, ACP completes settlement and Rebuild replaces the
   Runtime. `managed-rebuilt` uses the existing connection and beta's new
   counter starts at one. Guidance, Skill and workspace survive replacement.
6. Reconnect/load (v1) or resume-from-start (v2) preserves all six inputs, Tool
   IDs/results and answers in order, without executing work. v2 completion is
   authoritative `idle/end_turn`, not the immediate prompt acknowledgment.
   Delete reclaims the Agent's Runtime container and workspace volume.

The active drain checks use explicit barriers and service-owned observations,
not comparisons between independent clocks. Final lifecycle traces prove
publication/settlement and official Temporal activities for the same operation.
Each model request identifies the actual HTTP CLIENT under `model.complete`,
with fresh Runtime information/catalog preparation, a pinned execution snapshot,
real Runtime dispatch descendants and actual PostgreSQL Run closure. Actual SDK
JSON-RPC IDs identify each independent Gateway request trace. Rejections and
replay must have no Run/model/Runtime execution. Privacy checks include encoded
cookies, credentials, child environment, guidance and full Skill content.

Business and topology diagnostics are reported separately. Clock warnings and
lifecycle Docker absence-probe ERROR spans keep the strict gate nonzero. The
script does not claim an overall pass when strict checks fail. Raw evidence
stays under private `.cache/managed-mcp/<project>/managed-traces/` directories.

## Historical boundary

The 2026-09-10 result (both versions, 15 model requests, nine Tool calls and two
connection-wide traces each) belongs to the retired Controller Run-admission
architecture. Its stale-connection denial and admission-tagged preparation
assertions are no longer current. The old drain/pinned-snapshot validators have
been removed. `trace.mjs` still exposes the legacy oracle because other
closeout consumers have not migrated; this profile uses `request-trace.mjs`.
Unknown in-flight Tool effects, process crash recovery and legacy closeout
profiles remain separate acceptance work.
