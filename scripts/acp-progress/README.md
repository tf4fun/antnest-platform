# F02 Deployed Tool Progress Acceptance

This profile closes the Runtime producer / ACP consumer integration boundary.
It is a disposable deployment test, not another service or a public protocol.

## Scope

Login -> Gateway / Console BFF -> create Provider connection, Model, Template and Agent ->
ACP v1/v2 through Gateway -> real Rust Runtime Bash or managed stdio MCP ->
durable Tool updates -> reconnect/replay. The only fake business dependency is
a deterministic OpenAI-compatible SSE model. No external Provider or `.secret`.

Twelve paths: two ACP versions, two Tool sources, success/error/cancellation.
Each successful path disconnects after the first preview and reconnects before
completion. The test releases the Tool only after receiving its preview, so a
buffered final response cannot masquerade as live output. Terminal status and
Tool ID, complete replay, no duplicate Tool dispatch, and preview-free model
context are asserted. Cancellation must stop the actual Bash PID / notify the
managed child, not merely hide the Run in a client. Unconfirmed effects retain
the existing unresolved classification; cancellation does not claim rollback.

Synthetic accounts and all Agent management go through Gateway. The test-only
driver mounts the Docker socket solely to release gate files and inspect PID /
child cancellation markers. It validates the disposable scope and Agent labels
before executing fixed probes as UID/GID 1000. Runtime admission deliberately
rejects a second native MCP call while Bash is active; probes do not relax that
rule. This auxiliary access is absent from product images and does not stand in
for the Agent Tool call or receive its trace ID.
No cross-service SQL, new production endpoint or new deployment authorization.

A Bash exit code 7 is a completed Tool result, validated by the model fixture;
managed `isError` is a failed Tool. On HTTP cancellation the result is unobserved:
v1 returns `stopReason: cancelled`, v2 reports `_unresolved`, and further admission
without Runtime stopping evidence remains blocked with `runtime_barrier_required`. Tool status is `failed` in v1 and `cancelled` in v2. The test separately
verifies that execution was alive before cancellation and stopped afterwards.

Jaeger evidence must show actual Gateway ancestry and Runtime child spans for
ACP Tool calls, correlated through the model HTTP CLIENT span to the owning
`agent.run` and `antnest.run.id`. Retired admission tags are not required. Preview payloads
must not appear in traces. Packet forwarding is not traced. Save only compact
final counts and verdicts, not complete event/trace dumps or credentials.
Collect after Agent deletion / Runtime telemetry shutdown, then require three
identical span-ID sets sampled one second apart before counting calls. This is
a bounded convergence check, not a claim that eventual-consistency storage can
prove the absence of arbitrarily delayed spans.

The current trace oracle checks complete parent topology, one Run, preparation
before every model request, exactly one ACP dispatch and one Runtime invocation.
Deliberate managed Tool failure permits errors only inside that Tool call;
cancellation additionally permits the owning Run error. Bash exit 7 and successful
paths permit no error spans. Clock warnings remain visible and cause exit 1 even
when all business/topology checks pass; the parent `make` command reports exit 2.
Compact warning evidence includes the original cross-service timing differences,
without rewriting timestamps or introducing a small-duration exemption.

## Run

Build service images serially (explicit service iteration avoids Compose Bake
parallel builds):

```sh
make docker-build-runtime-controller
for service in agent-acp-service identity-service agent-controller admin-console agent-ui edge-gateway; do
  docker compose --profile stage3 build "$service" || break
done
docker build --target build -f runtimes/antnest-runtime/Dockerfile -t antnest/antnest-runtime:managed-build .
docker build -f scripts/managed-mcp/Dockerfile -t antnest/antnest-runtime:managed-integration .
make test-tool-progress-fixtures
make e2e-tool-progress
```

The managed integration image adds only the official-SDK fixture executable to
the production Runtime image. The fresh Compose project shares one PostgreSQL
instance across service-owned databases. Its parent trap removes all owned
containers, volumes and networks on success/failure. Retained acceptance stacks
are never targeted. Do not run this alongside another test/build profile.
The progress-only Compose override disables the unnecessary host Temporal port,
allocates dynamic endpoints outside fixed Egress/Jaeger addresses, and uses
`--env-file /dev/null`. It does not change the other Stage 3 profiles.

## Current Revalidation

The [2026-09-17 revalidation](../../docs/tool-progress-revalidation.md) updates
Provider/Model/Template setup and current Run/HTTP-span correlation. All 12
deployed business paths, 20 model requests and 12 trace topologies passed. Six
traces failed strict timing warnings; the script retains exit 1 rather than
claiming a whole-profile pass. Sixteen progress tests and ten shared collector/
model tests passed. No production implementation changed.
Real SIGTERM cleanup and independent resource/process scans passed for all three
disposable projects; the retained development stack remained healthy.

## Historical Evidence

The 2026-09-16 ACP SDK fix changes v1's cancellation acknowledgment while retaining
unknown-effect protection. The 2026-09-08 results below predate that fix and the
Controller/ACP boundary refactor; their old preparation correlation and strict
Trace coverage are not current-candidate evidence.

Deployment passed on 2026-09-08: 12 scenarios, 20 validated model requests,
12 Jaeger traces. Each trace has one preparation, one ACP Tool dispatch and one
Runtime Tool invocation. All owned containers, volumes and networks were removed.
No production implementation changes were needed in this integration batch.

Eight unit tests exercise negative oracle cases: missing early progress, wrong
Tool ID, repeated terminal / late updates, preview pollution in any message role,
malformed model requests, command text mistaken for a preview, nonzero Bash
results and v1/v2 cancellation mapping. A shared trace regression test additionally
injects delayed duplicate spans before the sampling window converges.
A green fixture suite alone is not deployment acceptance. A read-only review
also drove stricter replay-prefix, execution-alive and cleanup assertions.

Historical gates: root `make fmt-check`, `make lint` (Go: zero issues; both Rust
Clippy targets; Node lint/typechecks), and `make test-node` (583 cases) passed.
Two read-only reviewers were closed after their reports. Test instrumentation
findings were fixed without changing product admission or cancellation semantics.
