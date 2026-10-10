# RPC response-loss E2E

This scenario verifies that the platform recovers correctly when the Agent
Controller loses a successful response from the ACP service. It covers the
execution-snapshot publication and Agent settlement calls; the
[contract](contract.md) lists the recovery obligations.

## Running

```sh
npm --prefix services/agent-acp-service ci
make test-rpc-response-loss-fixtures
make e2e-rpc-response-loss
```

`make test-rpc-response-loss-fixtures` runs the proxy, oracle and fixture tests
without Docker. `make e2e-rpc-response-loss` requires Docker and the local
Stage 3 images (`make docker-build-stage3`). It runs the official ACP SDK v1 and
v2 clients serially against a fresh disposable stack, using synthetic accounts
and a deterministic model Provider. No production fault-injection switch is
used. Set `ANTNEST_E2E_CONTROLLER_IMAGE` to test a Controller image other than
`antnest/agent-controller:local`.

To exercise delayed Admin Console span export, run
`ANTNEST_E2E_ADMIN_SPAN_DELAY_MS=30000 make e2e-rpc-response-loss`.
This fixture setting changes only the Admin SDK batch interval in this disposable
stack; the default remains 5000 ms. The same business and strict trace gates apply.

## Scenario

The Controller's `apply-execution-snapshot` and `settle-agent` calls pass
through a private fixture proxy to the real ACP service. The Gateway and Admin
Console still address ACP directly. The proxy holds one validated, complete
upstream HTTP 200 without sending any response headers or bytes downstream, then
drops the held response when the scenario requests it. Retries come from the
real publication worker or Temporal; the proxy never retries.

- **Publication loss.** ACP already executes with edited Model parameters while
  the Controller's persisted acknowledgement is behind. A delivered retry
  catches up the acknowledgement without duplicating the completed Run.
- **Settlement loss.** A Rebuild stays in `drain` with its original Runtime
  while the successful settlement reply is held. Closed ACP admission rejects
  another prompt without creating a Run intent. The retry preserves the
  operation, minimum revision, mode and absolute deadline, then permits exactly
  one Runtime replacement.
- Each of the four cases (two per SDK version) preserves its completed audit,
  execution snapshot, ordered message and Tool history, and two independent
  reconnect replays. A real Bash append followed by a read must find exactly
  one marker, including after Runtime replacement.
- The host checks ACP's container identity, start time, restart count and
  health before and after the cases. A lost Controller acknowledgement must not
  restart ACP.

## Evidence

The client uses public Admin Console audits plus read-only Runtime operation and
identity inspection. Neither the client nor the proxy has database access or a
Docker socket. Receipts contain only bounded identities and canonical hashes,
never credentials or request and response bodies. Propagated HTTP span IDs
connect each receipt to its Controller CLIENT span and ACP SERVER span; driver
SQL spans establish the durable effects. Each SDK request is correlated by its
JSON-RPC ID and connection.

Each publication attempt must own an `agent_controller.execution_publication`
span and its source read. The oracle rejects missing, foreign or premature SQL.
Strict timing warnings and unrelated ERROR spans are reported as failures,
separately from the scoped business and topology result. Only the reviewed
clock-skew warning (`clock skew adjustment disabled; not applying calculated
delta of ...`) is reported without failing the exit.

Full Traces stay in the private directory
`artifacts/verification/rpc-response-loss/<project>/rpc-traces`; console output
is compact metrics.

The collector waits for every same-trace `CHILD_OF` parent to be present before
requiring three identical span-ID samples. It retains the existing 40-query
limit, 5-second query timeout and 1-second sampling interval. A permanently
missing parent still fails. Stability alone cannot establish that an incomplete
trace is ready; the final topology and warning checks remain unchanged.

Lifecycle `*.samples.jsonl` files retain each parsed sample's query start and
receipt times along with the raw trace. On failure, one bounded diagnostic query per known
lifecycle writes a separate `*-after-failure.json`; it never replaces the failed
sample or changes admission. Cleanup also saves Admin Console logs beside the
trace directory before removing the client. These private artifacts may contain
sensitive diagnostic data and are excluded from Git and Docker build contexts.

## Cleanup

The profile uses no fixed host ports or fixed IP ranges. The parent owns
container, volume, network and process cleanup. Agent deletion also checks that
no Runtime containers or volumes remain before the parent cleanup runs. Only
successful cleanup may publish final E2E success.

## Not covered

ACP database commit-receipt loss and interrupted-Run recovery are covered by
the [ACP persistence scenario](../acp-persistence/README.md) and the
[ACP restart scenario](../acp-restart/README.md); these Controller
acknowledgement cases do not substitute for them.
