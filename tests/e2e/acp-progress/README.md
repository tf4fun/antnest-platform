# ACP Tool progress E2E

This scenario verifies live Tool progress from the Runtime (producer) to ACP
clients (consumer) on a disposable full stack. It is a deployment test, not a
service or a public protocol.

## Private ACP migration checkpoint

`connection.mjs` and `scenario.mjs` implement the private WebSocket consumer
for both ACP versions. The connector uses the original browser Principal and
issued workspace caller context, omits browser cookies, and records the actual
SDK initialize and business request identities separately. An outstanding v1
prompt receives deliberate replay-disconnect evidence only when its original
error is the SDK's exact locally created close reason and no response arrived.
Protocol, serialization, peer-close and deadline errors cannot borrow that proof.

The scenario joins every opened connection before reconnecting or reporting
success. It retains the original closed connection for request and notification
inventory, including when Session validation fails. Early progress, all replay
frames and the single terminal Tool identity are bound to the original Session.
The cancellation admission budget is one monotonic 10-second interval covering
notification writing and the stop probe; a late successful probe remains failed.
Cleanup and inventory failures retain the original business error.

`tool-cancellation.mjs` validates the original dispatched cancellation subtree:
ACP discovery, Tool dispatch and joined close; both HTTP exchanges; Runtime
operation, Tool and Bash or managed stdio work. It requires the original
unreceived result, cancellation cause and failure diagnostics, and rejects
additional work or errors. Runtime work diagnostics must precede their owning
Tool and operation classification. A completion log cannot approve arbitrary
error fields. The proof preserves original spans and timestamps, records the
existing same-Node sub-millisecond observations separately, and cannot establish
successful cleanup or actual process stopping.

Connection tests use the locked SDK and real TCP peers. Scenario tests use a
controlled producer to exercise all twelve paths: 28 separate initializations,
44 business RPCs and four cancel notifications. These are local contract and
scenario checks; cancellation Trace fixtures cover both Runtime protocol-error
timings and held discovery responses. They do not prove real Runtime processes
stopped. `trace.mjs` now composes the complete private Run/prompt inspection for
all twelve paths, including their twenty model calls. The owning collector now
archives requests and original cancel notifications with complete source
receipts. The main client still
uses the previous Gateway flow and must be migrated to the new collector
signature. Host-owned Runtime gates, candidate deployment, entry-point wiring
and Docker acceptance remain pending; these local checks do not complete the
migration.

## Scope

The target deployment flow is: login through the Gateway and Admin Console BFF,
create a Provider connection, Model, Template and Agent, then call the private
ACP v1 and v2 listeners with the issued workspace caller context against the
real Rust Runtime's Bash Tool or a managed stdio MCP server,
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
  the Executor process delivering that result still exits 0. Managed MCP
  `isError` is a failed Tool whose observed result can continue to the final
  model response and a completed Run.
- Cancellation must stop the actual Bash PID or notify the managed child, not
  just hide the Run in a client. On HTTP cancellation the result is unobserved:
  v1 returns `stopReason: cancelled`, v2 reports `_unresolved`, and further
  admission without Runtime stopping evidence stays blocked with
  `runtime_barrier_required`. Tool status is `failed` in v1 and `cancelled` in
  v2. The test separately verifies that execution was alive before
  cancellation and stopped within 10 s. Cancellation does not claim rollback.
- When that deadline is missed, the client prints one `cancel_timeout` line
  before failing. It reports whether the process stopped within 30 more
  seconds, the Tool and state frame transitions, and payload-free spans of the
  prompt and `session/cancel` traces, including
  `executor.exit.classification`. It never extends the deadline.

Synthetic accounts and all Agent management go through the Gateway. The
test-only driver mounts the Docker socket solely to release gate files and
inspect PID and child cancellation markers. It validates the disposable scope
and Agent labels before running fixed probes as UID/GID 1000. Runtime admission
deliberately rejects a second native MCP call while Bash is active, and probes
do not relax that rule. This auxiliary access is absent from product images and
never stands in for the Agent Tool call. There is no cross-service SQL, new
production endpoint or new deployment authorization.

## Trace checks

`inspectTrace(trace, expected, secrets, requests)` binds the original private
RPC ID, Session, actual upgrade Link and ACP process resource. Admission creates
an independent Run request resource ID; it is preserved separately from the
SDK RPC ID. The live Tool ID must match the normalized original Run/model call.
Model HTTP CLIENT spans map one-to-one to the recorded model requests: one for
cancellation and two for every completed path. Preparation, complete Runtime
HTTP inventories, one Tool dispatch and committed Run persistence are checked.
No preview payloads or credentials may appear in either raw Trace.

Every accepted diagnostic belongs to an individually checked original span.
Managed `isError` requires the exact stdio, Tool, protocol and ACP diagnostics.
Cancellation requires an unresolved, quiescent Run with unknown Runtime effects;
its errors remain visible. A deliberate v1 success disconnect requires the
actual closed-before-response receipt and its precise original dispatch error.
An optional v1 post-prompt refresh is checked separately; v2 admission may finish
before its Run. Unrelated SQL errors and extra work cannot use these proofs.

Both request and upgrade sources must have finite nonnegative span lifetimes
and events inside their own spans. Existing exact same-Node sub-millisecond
endpoint observations and Rust integer-microsecond representation observations
remain attached to their original values. Warnings remain visible and keep
`strict_trace` failed; no timestamps or raw diagnostics are rewritten. The
collector archives complete original query bytes, including failed attempts.

`control-trace.mjs` checks all five barrier-admission reads and the exact
`runtime_barrier_required` error and origin, with no Run or model work. Cancel
notifications require the original successfully closed connector receipt, an
INTERNAL root linked to its actual upgrade, and the committed cancellation
transaction. The notification only proves cancellation was requested; the
Runtime stop probe remains a separate requirement.

`collector.mjs` composes these owning checks with the shared private collector.
Initialization and empty-MCP Session setup/replay reuse the strict contracts
already used by Cost. Every result requires three consecutive stable complete
source samples, original query hashes and raw diagnostic inventory. Warning
review uses the same complete-source causal policy as Cost: only the previously
deferred same-Node endpoint observation can qualify, with explicit matching
process identity. Unknown or cross-process warnings fail. Original errors and
warnings retain strict failure status; reviewed known diagnostics do not erase
them. Admission binds the exact returned result and rechecks its archived bytes,
so copied, mutated or repeated results cannot authorize success. These collector
checks use controlled Jaeger responses and real SDK notification receipts; the
actual client, Runtime gates and deployment acceptance remain pending.

## Running

The main entry point below is pending private collector and host-driver wiring;
it is not an admission command for the current migration checkpoint.

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
