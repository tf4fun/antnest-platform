# Managed MCP E2E

This disposable scenario verifies managed stdio MCP servers inside the Runtime,
together with Agent Rebuild while a Run is active. It uses the real Controllers,
PostgreSQL, Temporal, Runtime, ACP service, Gateway and Jaeger; only the
Provider is deterministic. The stdio child uses the installed Rust MCP SDK and
runs inside the Runtime as UID 2000/GID 1000. The [fixture contract](contracts.md)
defines the required behavior.

## Running

Run serially with Docker available. Each target builds isolated source-based
candidate images, provisions private workload credentials and cleans its resources:

```sh
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

`secrets-docker.mjs 1|2` selects the SDK protocol version. The parent creates an
isolated authenticated Compose project with separate service databases,
uses synthetic local accounts, reads no `.env` or `.secret` file and calls no
external LLM. Temporal has no host port; Gateway, PostgreSQL, Jaeger and the
test-only private relays bind to dynamically selected loopback ports. Do not run another build or test profile
concurrently.

## Scenario

Provider, Model and Template setup uses public Admin Console APIs. Templates
reference a stable Model ID, and the Agent uses the returned Template revision.
No fixture writes another service's database. Read-only Runtime operation
inspection corroborates Create, Rebuild and Delete; the Console execution audit
corroborates ACP Runs.

Six successful Runs make 16 Provider requests and ten real Tool calls:

1. `managed-bootstrap` writes workspace guidance and a Personal Skill.
2. `managed-exercise` sees the guidance and the Skill summary and locator
   without its full body, handles an ordinary alpha Tool error, then calls alpha
   successfully. A normal UID 1000 Bash call then verifies the child's environ,
   memory, descriptors and ptrace are inaccessible, as is the root-only bootstrap.
3. `managed-mutate` edits the guidance. `managed-fresh` sees that edit
   immediately and proves child reuse through the next process counter.
4. A new beta Template revision leaves the Agent's built configuration intact.
   `managed-draining` holds two Provider responses around its two alpha calls.
   While each response is held, the exact Rebuild remains in drain, ACP's busy
   Session is closed to new work, the durable Run is running and the original
   Runtime stays healthy and unchanged. Another Session gets the precise
   `-32030 / agent_busy / retryable=true / retry_after_ms=1000` error without a
   Run or Provider call.
   The second hold proves that completed Tools alone do not release the Run.
5. After the final response, ACP completes settlement and the Rebuild replaces
   the Runtime. `managed-rebuilt` uses the existing connection, and beta's new
   counter starts at one. Guidance, Skill and workspace survive replacement.
6. Reconnect and load (v1) or resume from the start (v2) preserves all six
   inputs, Tool IDs and results, and answers in order, without executing work.
   v2 completion is the authoritative `idle/end_turn`, not the immediate prompt
   acknowledgement. Delete reclaims the Agent's Runtime container and workspace
   volume.

Template secret reads expose only set/opaque HMAC metadata. A keep revision
receives a fresh envelope identity; the value remains unchanged. Real secret_env
values are cached by the MCP fixture in HOME/TMPDIR/XDG and shared `/tmp`, with
mode 0600, and the normal Bash tool must fail to read them. Own cache programs
remain executable under the server UID. The separate Runtime owner gate proves
peer-MCP isolation, unsafe mount rejection and cache recreation on restart.
Template secret reads expose only set/fingerprint metadata. An unchanged secret
is kept in the next immutable revision and then cleared from the head. Disable
and Enable still use the Agent's earlier frozen revision, whose required MCP
process initializes successfully. Final deletion checks all RC-owned containers
and volumes, including private MCP bootstrap volumes. Retained Docker identities
are compared before and after cleanup.

The authenticated Docker runner also checks [Egress peer binding](../runtime-egress/README.md):
create/rebuild/enable must bind the current Docker IPv4, disable clears it, and a
graceful Runtime restart at a new fixture address must update the binding.

The drain checks use explicit barriers and service-owned observations, never
comparisons between independent clocks.

## Trace checks

Final lifecycle Traces prove publication, settlement and the Temporal activities
for the same operation. Each model request identifies the HTTP CLIENT span under
`model.complete`, with fresh Runtime information and catalog preparation, a
pinned execution snapshot, Runtime dispatch descendants and PostgreSQL Run
closure. SDK JSON-RPC IDs identify each private ACP request Trace and its
actual exported CLIENT/upgrade pair. Rejections and replay must not execute
a Run, model or Tool; replay may read the Runtime catalog. Privacy
checks cover encoded cookies, credentials, the child environment, guidance and
full Skill content. This profile uses the per-request oracle in
`request-trace.mjs`; `trace.mjs` keeps the connection-wide oracle used by other
scenarios.

Trace collection, topology, strict inspection and exporter failures are auxiliary
diagnostics. They keep their original warnings and private raw evidence under one
shared collection budget; collectors receive cancellation and are actually joined.
No Trace result changes business admission. Raw evidence stays in the private
`artifacts/verification/managed-mcp-secrets/v<version>-<tag>/traces/` directory.

The business gate reads the complete administrative Run list and each Run's
detail and execution-event page before deleting the Agent. It binds six original
prompt receipts to six completed, quiescent Runs and their captured execution
snapshots, ten paired Tool lifecycles (six Managed and four builtin, including
the expected alpha failure), sixteen model requests, and original/replayed
protocol output. Missing pages, duplicate or foreign records, changed input or
results, unexpected terminal state and unfinished model responses still fail.
`business-evidence.private.json` retains complete or partial originals and read
errors; it contains private input and is not a public report. These Audit DTOs
do not expose a separate Runtime-stop receipt; the existing drain, operation,
peer, restart and actual resource-removal checks remain independent gates.

The host client delegates its original member Session and Principal through
Identity's workspace Resolve, using only the disposable `gateway-identity` and
`agent-ui-acp` grants. Managed's test overlay exposes the existing private relay
routes and a restricted OTLP ingress on dynamic loopback ports. The runner
checks each live container's project/service ownership, health and unique
loopback binding before supplying its endpoints. No production listener changes.
The original host peer binding, egress outage and Runtime restart checks remain
part of both version gates.

Each version retains all 11 business requests and records the three actual
initializations separately (one per official SDK connection). Full private
execution-state responses retain the configuration revision and original member
authority; the two Drain barriers still require the busy Session, running audit,
original Runtime and exact catalog `agent_busy` response. Final close joins
all requests and archives raw wire frames and immutable receipts. The private
collector preserves request and upgrade sources and accounts for every diagnostic,
including the deliberate alpha Tool error. Business errors remain fatal.
Policy 2 writes `managed-complete.json` and emits success only after business
validation, connection/request joins and actual exporter shutdown. Exporter
rejection is archived as an auxiliary warning after shutdown settles. The
receipt uses exit 0 even when Trace is unavailable; old Trace exit 2 alone cannot
satisfy this policy. Build, business-evidence archive and real cleanup failures
remain blocking, as do the parent's final container/volume/network inspections.

## Cleanup

The parent removes all owned containers, volumes and networks on success or
failure. Agent deletion also reclaims the Runtime container and workspace
volume.

## Not covered

Unknown in-flight Tool effects and process crash recovery are covered by
[ACP restart](../acp-restart/README.md).
