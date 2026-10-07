# ACP Tool progress E2E

This scenario verifies live Tool progress from the Runtime (producer) to ACP
clients (consumer) on a disposable full stack. It is a deployment test, not a
service or a public protocol.

## Scope

The flow is: login through the Gateway and Admin Console BFF, create a Provider
connection, Model, Template and Agent, then call ACP v1 and v2 through the
Gateway against the real Rust Runtime's Bash Tool or a managed stdio MCP server,
with durable Tool updates and reconnect replay. The only fake business
dependency is a deterministic OpenAI-compatible SSE model. No external Provider
or `.secret` file is used.

There are twelve paths: two ACP versions, two Tool sources, and success, error
and cancellation.

- Each successful path disconnects after the first preview and reconnects before
  completion. The test releases the Tool only after receiving its preview, so a
  buffered final response cannot pass as live output. Terminal status, Tool ID,
  complete replay, no duplicate Tool dispatch and a preview-free model context
  are asserted.
- A Bash exit code 7 is a completed Tool result, validated by the model fixture;
  managed MCP `isError` is a failed Tool.
- Cancellation must stop the actual Bash PID or notify the managed child, not
  just hide the Run in a client. On HTTP cancellation the result is unobserved:
  v1 returns `stopReason: cancelled`, v2 reports `_unresolved`, and further
  admission without Runtime stopping evidence stays blocked with
  `runtime_barrier_required`. Tool status is `failed` in v1 and `cancelled` in
  v2. The test separately verifies that execution was alive before
  cancellation and stopped afterwards. Cancellation does not claim rollback.

Synthetic accounts and all Agent management go through the Gateway. The
test-only driver mounts the Docker socket solely to release gate files and
inspect PID and child cancellation markers. It validates the disposable scope
and Agent labels before running fixed probes as UID/GID 1000. Runtime admission
deliberately rejects a second native MCP call while Bash is active, and probes
do not relax that rule. This auxiliary access is absent from product images and
never stands in for the Agent Tool call. There is no cross-service SQL, new
production endpoint or new deployment authorization.

## Trace checks

Jaeger must show Gateway ancestry and Runtime child spans for ACP Tool calls,
correlated through the model HTTP CLIENT span to the owning `agent.run` and
`antnest.run.id`. Preview payloads must not appear in Traces. Packet forwarding
is not traced.

Traces are collected after Agent deletion and Runtime telemetry shutdown. Three
identical span-ID sets sampled one second apart are required before counting
calls; this is a bounded convergence check, not proof that no span arrives
later. The oracle checks complete parent topology, one Run, preparation before
every model request, exactly one ACP dispatch and one Runtime invocation. A
deliberate managed Tool failure permits errors only inside that Tool call;
cancellation also permits the owning Run error. Bash exit 7 and successful paths
permit no error spans, except that a v1 successful path disconnected before its
prompt answered may record the failed response dispatch on that ACP prompt span. Clock warnings stay visible and cause exit 1 even when all
business and topology checks pass (the parent `make` reports exit 2). Warning
evidence includes the original cross-service timing differences, without
rewriting timestamps or exempting small durations. Only compact final counts and
verdicts are saved.

## Running

Build the service images serially (explicit iteration avoids parallel Compose
Bake builds):

```sh
make docker-build-runtime-controller
for service in agent-acp-service identity-service agent-controller admin-console agent-ui edge-gateway; do
  docker compose --profile stage3 build "$service" || break
done
docker build --target build -f runtimes/antnest-runtime/Dockerfile -t antnest/antnest-runtime:managed-build .
docker build -f tests/e2e/managed-mcp/Dockerfile -t antnest/antnest-runtime:managed-integration .
make test-tool-progress-fixtures
make e2e-tool-progress
```

The managed integration image adds only the official-SDK fixture executable to
the production Runtime image. The fresh Compose project shares one PostgreSQL
instance across service-owned databases. The progress-specific Compose override
disables the host Temporal port, allocates dynamic endpoints outside the fixed
Egress and Jaeger addresses and uses `--env-file /dev/null`. Do not run this
alongside another test or build profile.

## Cleanup

The parent trap removes all owned containers, volumes and networks on success or
failure and never targets other deployments.

### Interruption harness

`interruption.py --config /path/to/interruption.json` verifies that a real
SIGTERM to the fixture cleans up its own resources. The configuration requires:

```json
{
  "output": "artifacts/verification/example-progress-interruption",
  "command": ["sh", "tests/e2e/e2e-stage3a.sh"],
  "environment": { "ANTNEST_E2E_TOOL_PROGRESS": "true" },
  "project_template": "antnest-stage3-e2e-{pid}",
  "trigger_filter": "name=^/{project}-progress-client$",
  "trigger_description": "progress-client created"
}
```

Use the direct shell command: the project name uses that child's PID, so
wrapping it in Make would select the wrong project. Configuration and durable
output paths are checked before startup. The trigger deadline is 160 seconds,
and the fixture has 150 seconds to exit after TERM. An optional positive
`cleanup_grace_seconds` (default 150) controls the harness fallback without
changing either deadline.

The harness records the fixture exit code, both resource-label scopes, captured
descendant PIDs and live members of the original process group before fallback
cleanup. It passes only when TERM was delivered, the fixture exited nonzero and
no resources or processes remain. A wait timeout keeps `exitCode: null` and fails
even if fallback later kills the process. External SIGINT or SIGTERM cancels the
harness with 130 or 143 while still cleaning its owned group.
