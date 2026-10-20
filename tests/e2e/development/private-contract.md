# Development private execution consumer contract

This batch migrates Development consumers of the retired Gateway browser stack
in #64. Management and lifecycle commands retain their existing Console routes.
The completed Workspace and Stage2 batches provide shared private transport
components; they do not prove this batch's driver or browser acceptance.

## Configuration and authority

The `agent-state`, `recover`, `runtime-loss` and `replay` profiles require
`privateAccess: { credentials, acp, identity, otlp }`. ACP and Identity are
explicit HTTP loopback origins; OTLP is the loopback `/v1/traces` endpoint.
Credentials point to a durable directory with the existing `gateway-identity`
and `agent-ui-acp` workload grants. Validate inputs and output reservations
before HTTP or Docker effects. Do not add implicit deployment, Agent, container
or credential defaults.

Use the Principal returned by the actual Gateway login and that same client's
original session Cookie. Identity must resolve that session for the selected
Agent and return the same organization and user. Do not infer the Principal from
Agent ownership or configuration. The ordinary `lifecycle`, `trace-review`
and `rejection-trace` profiles do not acquire private ACP configuration.

## State and lifecycle preservation

Replace the single retired state read in each of `agent-state.mjs`,
`recover.mjs` and `runtime-loss.mjs` with an authenticated private state RPC.
Validate the complete current state schema and selected Agent. Preserve the
original HTTP body and authority receipt, including failed reads.

- Agent state still requires ready, no active Session and allowed access.
- Recovery still performs exactly one explicit Rebuild, requires a new Runtime
  container, and compares the complete workspace SHA-256 manifest, unchanged
  volume and configuration before accepting ready and idle execution state.
- Runtime loss still observes a normal exit with code zero, exited Runtime,
  container removal, absent Runtime and offline execution state before the
  explicit source-missing Rebuild. Keep its publication cutoff and the retained
  Agent comparison.
- Lifecycle retains Create, Disable, Enable, Rebuild and Delete, three independent
  publications, workspace retention/deletion and the unchanged retained Agent.

These state reads are observations, not Prompt admission or execution results.
The retired public state route must return 404 in the driver adapters.

## Replay

Keep the actual PostgreSQL Session ownership and working-directory checks,
decoded messages and file-change comparisons. Open exactly one original
Identity-authorized private connection, initialize once, and send exactly one
`session/load`. The shared connection already initializes; do not initialize it
again. Replay issues no Prompt or Tool request.

Close and join the actual connection before comparing the four original table
counts. Bind connection, initialize and load Trace evidence to the original wire
request IDs and receipts. Preserve raw updates and Trace sources; an archived
old Gateway Trace cannot stand in for the new connection's private evidence.
Unchanged row counts do not claim that no existing activity row changed.

## Browser and Trace consumers

Move `development-browser.mjs` from obsolete WebSocket frame observations to
actual Bridge POST receipts, complete Agent views and the selected turn's
content. HTTP 202 proves admission only; require completion of the original
operation and turn.

Keep all three original Prompts: greeting, actual workspace write/read with the
unique marker, and actual read after reload. Preserve visible assistant text,
successful collapsed Tool activity, identical restored history, zero Prompt
resubmission during reload, mobile layout and explicit Agent selection.
The existing external-provider development mode remains usable. Controlled
provider acceptance must still exercise real deployed services and Runtime
Tools and must identify its provider scope accurately.

Chat Trace review uses Bridge ancestry. Retain configured Trace counts,
Session identity, Runtime-call minimums, capture-disabled boundaries and original
strict diagnostics. Rejection review still proves unsupported content without
model HTTP or Runtime Tool execution. Confirmed external SDK diagnostics remain
non-blocking under the repository policy.

## Evidence and admission

Original login authority, state/connection receipts, browser operation receipts,
database history, Runtime/volume inspections and Trace sources belong in private
durable evidence. Preserve exclusive output files and the Development writer's
ownership checks. Join every connection, exporter, request and child process;
retain business, archive and cleanup failures, and write passing reports only
after cleanup succeeds.

Run the owning configuration, driver and browser tests plus the existing
replay/recovery/runtime-loss/lifecycle Docker adapter gates. Those adapters prove
driver behavior and resource ownership, not the production workflow. Completion
also requires a fresh candidate deployment exercising the migrated drivers and
actual browser. Capacity/cancellation needs current-candidate verification, then
the full integration batch and final PR head review/CI.
