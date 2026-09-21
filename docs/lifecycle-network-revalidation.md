# Lifecycle network acceptance migration

Date: 2026-09-21. Source baseline: `866d0aa`. This batch migrates the standalone
`make e2e-lifecycle-network` acceptance consumer. Production service code, SDKs,
retained development deployment and old shared assets are unchanged.

## Contract and implementation

The [network migration contract](../scripts/lifecycle-closeout/network-migration-contract.md)
was written before implementation. The network profile now uses the current
Foundation setup and lifecycle command/replay implementation: Provider connection,
stable Model ID, the actual returned Template revision, immutable Runtime image
and readiness before taking replay baselines. The default Foundation scenario
remains the default; other historical profiles retain their separate migration
scope.

Thirteen services are required, including private Temporal and one healthy
network target attached only to the disposable Egress network, without published
ports. Eight application image identities are checked. Dynamic allocation excludes
reserved infrastructure addresses; RPC content capture stays disabled.

The physical network scenario is preserved: two UID/GID 1000 Runtime Bash clients,
raw TCP/NDJSON, bounded DNS, a fail-closed Egress forwarding guard and a test-only
DNAT destination. No host firewall or routing changes are made and no external
model or Internet endpoint is called. Exact target responses/hit history, both
original conntrack entries, reverse push, same-socket continuation and prompt
connection reset distinguish policy enforcement from endpoint failure or timeout.

Every prompt now requires exactly one completed public Run audit for the expected
Agent, Session and immutable execution revision. Actual SDK JSON-RPC request IDs
and connection links identify Session creation and prompt traces. Actual model
HTTP parents, durable Run identity and Runtime Tool descendants replace the old
Controller acquire/finish admission oracle. No private Runtime snapshot or
service-owned database admission query is needed.

Policy traces preserve Gateway/Console/Controller/Egress ancestry and exact Agent
identity. A timing warning makes strict status failed while topology can pass;
unexpected errors, missing parents and credential leakage still fail topology.
Supplied synthetic secrets and actual session cookies are scanned. Raw traces
remain unchanged and private. Independent trace failures do not stop collection
of later trace evidence.

Both Agents must be deleted through Gateway before teardown. Each original Runtime
must have one exit-zero die/stop/destroy sequence without OOM or SIGKILL. Seven
remaining trace producers stop gracefully and must exit zero before collection.
Cleanup remains restricted to owned project/Runtime resources.

## Verification

Verification is serial. New negative tests cover wrong/multiple public Runs,
wrong Agent/Session/execution state, target exposure or extra network membership,
raw warning preservation, actual credential scanning and unexpected policy errors.
Existing real TCP target, server push, peer reset, deterministic model and protocol
fixtures remain applicable.

The first deployment, `antnest-lifecycle-9b8328e6`, completed six real probes and
reached exact target-history inspection. It then failed the physical-identity
comparison because Docker returned the same mounts in a different array order.
Its failure is retained. A test-first fix compares mounts sorted by destination
without changing the raw inspection or omitting any mount attribute. Negative
cases still reject changed volume name, source, destination and read/write mode.

The final network project, `antnest-lifecycle-db6c8d75`, passes business and all
20 Trace topologies:

| Evidence | Result |
| --- | --- |
| Deployment | Thirteen services and eight application images verified; private target and Temporal |
| Lifecycle | Two Creates and two Deletes, all terminal with exact replay and no repeated effects |
| Execution | Six completed public Runs, twelve actual model requests, six Runtime Bash probes |
| Policy enforcement | Allow, deny and restored allow; A's old conntrack removed, reverse push blocked, continued write promptly rejected |
| Agent isolation | B retains its original conntrack and socket across A's denial and B's stale CAS conflict; reverse push, continued write and DNS succeed |
| DNS/private target | Denial includes bounded DNS failure plus direct resolver connection rejection; direct private TCP target is rejected |
| Independent target | Exactly five expected TCP requests and two recorded reverse-push attempts; no unexpected target errors |
| Identity/data | Same Runtime image/container/start time, configuration, execution revision, mount attributes and workspace sentinel across policy changes |
| Trace | Twelve request traces, four lifecycle traces and four policy-write traces, all topology checks passed |
| Completion | Both original Runtimes exit zero during business Delete; seven other trace producers exit zero before collection |

The denied public and private TCP probes both report rounded elapsed time 0 ms;
timeouts cannot satisfy either assertion. The held-A reverse-push receive timeout
is only the no-delivery check: denial additionally requires prompt reset/rejection
on the same connection and conntrack removal. B's continuation succeeds on its
original socket. Exact deny-request replay occurs after those socket checks.

The runner returns `business_and_topology_passed` with `strict_exit: 2`.
Eleven traces retain timing warnings and fail strict validation; there are no
ERROR spans or missing-parent edges. This is not full strict Trace acceptance.
Raw warnings and span identities are unchanged. Both network projects are cleaned
by the runner, including the failed first attempt.

The final affected local regression passes **894 tests**, with zero failures and
five skips among 899 cases. The five skips are the separately gated ACP
PostgreSQL commit-receipt-loss cases; this migration does not modify ACP service
code. The run includes current and historical lifecycle helpers, both protocol
adapters, request/lifecycle topology negatives and real TCP/HTTP fixture components.

Because the network consumer now shares Foundation's runner and setup, the
default Foundation profile was independently redeployed as
`antnest-lifecycle-d04ea924`. All nine lifecycle operations and 16 topologies pass,
including active-Run drain, actual exit-zero Controller restart and same-Session
continuation. Its strict exit remains 2: twelve traces fail, with ten warning
traces and the expected canceled-drain/busy-rejection errors retained. This is
scoped regression of the shared entry, not a rerun of every historical consumer.

All three projects have zero owned containers, volumes and networks. No
verification children remain. The retained development baseline's twelve
container IDs, images, mounts, running states and health states are unchanged.
Raw network trace inspection independently confirms twenty traces, zero missing
parent edges, zero ERROR spans and eleven traces with the recorded Jaeger timing
warning class. No production deployment or data migration was performed.

## Evidence and remaining scope

Private local logs and retained-container snapshots are under
`.cache/lifecycle-network-migration-20260921/`; deployment inspection, raw traces
and failure diagnostics are under `.cache/lifecycle-network/<project>/`. Ignored
artifacts are not guaranteed in a fresh clone and must not be published.

Shutdown, health, restore, loss, interrupted-update, older Workspace and retained /
extended historical Stage 3 consumers remain separate migration batches. No old
shared helper is removed. The accepted clock investigation remains deferred.
