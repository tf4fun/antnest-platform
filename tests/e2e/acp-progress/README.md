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
receipts. The main client now uses the actual login Principal, private connector,
scenario and collector. It indexes all 28 initializations, 44 business requests,
four original cancel notifications and twenty model requests before admitting
76 distinct original Traces. It retains all four Agents until it consumes the
host's candidate Runtime inspection receipt, then uses the shared four-Agent
cleanup recorder to join every actual delete operation. Connection capture
itself joins close before reading the original notifications. Runtime gates now
use a file channel serviced by one host loop, followed by the final four-Runtime
inspection. Timeout diagnostics now use the original closed connector and
archived private Trace sources. Candidate deployment and shell entry points now
use the owning deployment helper. Full Docker acceptance remains pending;
local checks do not complete the migration.

The deployment builds ten service candidates, a production Runtime base and
the managed MCP fixture source, then copies only the fixture executable into
the final `progress-<run UUID>` Runtime. It records original image inspections
and build arguments, checks the isolated source references against their original
image IDs before and after the final COPY, and checks the production layer
prefix and Runtime configuration remain unchanged. CI may supply the base and
fixture carrier; the final COPY still runs. These test images are local to the
run and are removed after the stack, never published as service packages.

Both harness containers run as the host credential UID/GID. The client mounts
exactly two read-only service grants, the three required contract files and
the tests read-only, plus separate writable Trace, gate IPC and Runtime ACK
directories. Host Docker inspections remain in unmounted sibling directories.
Actual inspections check the complete mount inventory and user. The host loop
checks the original client/model identities and start times before probes and
around the final ACK, so an early client exit or restart fails admission.

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
  before failing. It first joins the original connection, then probes only
  within the original deadline plus 30 seconds; close time counts against that
  interval. It reports observed Tool/state transitions and spans from the actual
  prompt and original cancel notification, linked to their exact ACP upgrade.
  The separate diagnostic collection budget is bounded to 60 seconds and joins
  cancellation. Late stopping or successful collection never changes the
  original business failure or produces a successful scenario outcome.

Synthetic accounts and all Agent management go through the Gateway. The migrated
gate gives the client a run-scoped file channel. Only the host driver executes
fixed probes as UID/GID 1000. It binds the original candidate image, container,
Agent, generation and complete StartedAt string, and rechecks them before and
after every probe and at the final four-Runtime ACK. Bash stopping requires the
same PID file and the original process start ticks; a changed PID, inaccessible
process, malformed output or Docker error fails. Runtime admission
deliberately rejects a second native MCP call while Bash is active, and probes
do not relax that rule. This auxiliary access is absent from product images and
never stands in for the Agent Tool call. There is no cross-service SQL, new
production endpoint or new deployment authorization.

Every gate request has its own sequence and nonce, an immutable receipt and a
consumption hash. Final inspection rechecks all original request, receipt and
host evidence bytes, and rejects an unconsumed or newly pending request. Raw
Docker inspection remains outside the client channel. Interrupted commands are
joined before a failed receipt and partial evidence are saved. The scenario
passes each stop probe the remaining original ten-second monotonic budget;
publication, host queueing and receipt reading all count, and late success fails.
The deployment shell starts this host loop after the client. A completed ACK
does not replace the actual client exit code; strict exit 2 remains unchanged,
and host or cleanup failures remain fatal. Cleanup uses recorded original
container IDs or the unique run-labelled recovery result, preserves logs and
attempts removal even when inspection or evidence writing fails.

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
checks use controlled Jaeger responses and real SDK notification receipts;
deployment acceptance remains pending.

Timeout diagnostics reuse the shared v3 search/v1 detail collector, including
three consecutive complete stable samples and private raw query bytes/SHA.
Failed and interrupted responses retain their received prefix. The diagnostic
request/reader observer also preserves original fetch, reset and cancellation
errors with their causes before the shared collector reports a fixed error.
The original CLIENT flush failure, including its Span identity and export
cause, is retained before any Jaeger query can start.
Failure to save them aborts collection and retains the original error together
with the storage failure. Public output permits fixed field values only;
arbitrary operations, values, warnings, frames and error details stay private.
These diagnostic results always have `admitted: false` and are never inputs to
the business strict-outcome function. Tests include actual SDK/TCP notification
receipts and an actual HTTP body reset; they do not complete Progress Docker
acceptance.

## Running

The main entry point is wired to the host driver and candidate deployment.
`make e2e-tool-progress` runs the complete stack; its Docker acceptance is still
pending for this checkpoint.
The local fixture command remains available:

```sh
make test-tool-progress-fixtures
```

`gate-container.mjs <private-evidence-directory> <existing-runtime-image-id>`
checks the fixed probes and file IPC in one isolated Linux container. It uses
an existing local image by immutable ID, overrides the product entrypoint with
a child-process fixture, and restores its temporary container and image alias.
This check does not validate managed MCP cancellation, the production Runtime,
four-Agent final admission, client container permissions or the Progress business
workflow. Those require the complete candidate deployment below.

The candidate managed image must add only the official-SDK fixture executable
to this run's production Runtime candidate, with a private `progress-<run-id>`
image reference. The new Runtime receipt contract rejects the old shared managed
image tag. The fresh Compose project shares one PostgreSQL
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
