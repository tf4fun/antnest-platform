# Current RPC response-loss fixture

Run `make test-rpc-response-loss-fixtures`, then `make e2e-rpc-response-loss`
from the repository root with the locked ACP dependencies and current local
Stage 3 images available. The profile runs official ACP SDK v1 and v2 serially
against a fresh disposable stack. It uses synthetic accounts and a deterministic
Provider. No service image changes or production fault switches are required.

The [contract](contract.md) defines the current owner of each recovery obligation.
Controller's `apply-execution-snapshot` and `settle-agent` calls pass through a
private fixture proxy to the real ACP service. Gateway and Console continue to
address ACP directly. The proxy holds one validated complete upstream HTTP 200
without sending downstream response headers or bytes, then drops the exact held
receipt when the scenario requests it. Retry belongs to the real publication
worker or Temporal; the proxy never retries.

- Publication loss: ACP already executes with edited Model parameters while
  Controller's persisted acknowledgement remains behind. A delivered retry
  catches up the acknowledgement without duplicating the completed Run.
- Settlement loss: a Rebuild remains in `drain` with its original Runtime while
  the successful settlement reply is held. Closed ACP admission rejects another
  prompt without a Run intent. Retry preserves the operation, minimum revision,
  mode and absolute deadline, then permits one Runtime replacement.
- Each of four cases preserves its completed audit, execution snapshot, ordered
  message/Tool history and two independent reconnect replays. Real Bash append
  and subsequent read must find exactly one marker, including after replacement.
- The host checks ACP's container identity, start time, restart count and health
  before and after the cases. No ACP restart is expected for these lost replies.

The client uses public Console audits plus read-only Runtime operation/identity
inspection. Neither client nor proxy has database access or a Docker socket.
Receipts contain only bounded identities and canonical hashes, never credentials
or request/response bodies. Actual propagated HTTP span IDs connect each receipt
to its Controller CLIENT and ACP SERVER; driver SQL establishes durable effects.
Each SDK request is correlated by its observed JSON-RPC ID and connection.
The [Controller follow-up](../../../docs/controller-publication-trace-revalidation.md)
now exports each publication attempt's source read and acknowledgement UPDATE.
The oracle rejects missing/foreign/premature SQL. Select the verified candidate
with `ANTNEST_E2E_CONTROLLER_IMAGE=antnest/agent-controller:publication-trace-20260917`
when the ordinary `:local` image has not been rebuilt. Strict warnings and probe
errors remain failures; the retained development deployment is unchanged.

The profile has no retained host ports or fixed-IP allocation overlap. Its parent
owns container, volume, network and process cleanup. Agent deletion also checks
zero Runtime containers/volumes before the parent cleanup. Full traces stay in
private `artifacts/verification/rpc-response-loss/<project>/rpc-traces`; output is compact metrics.
Only cleanup may publish final E2E success. Strict timing warnings and unrelated
ERROR spans remain failures, separate from scoped business/topology results.

The obsolete acquire/finish fixture is historical. ACP database commit-receipt
loss and interrupted-Run recovery remain a separate persistence fault batch;
these Controller acknowledgement cases cannot substitute for that evidence.
