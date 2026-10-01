# ACP persistence recovery E2E

This scenario verifies that the ACP service recovers correctly when a committed
PostgreSQL response is lost at Run intent, input acceptance or Run completion.
It runs for both installed official ACP SDK versions. The [contract](contract.md)
defines the recovery obligations. Process interruption and unknown Tool effects
are covered separately by [ACP restart](../acp-restart/README.md).

## Running

```sh
npm --prefix services/agent-acp-service ci
make test-acp-persistence-fixtures
make e2e-acp-persistence
```

`make test-acp-persistence-fixtures` runs serial unit, contract and HTTP checks.
Set `TEST_POSTGRES_URL` to a disposable test database to include the real
PostgreSQL proxy component tests; they recreate their fixture tables. Without
the URL those tests are reported as skipped, not passed.

`make e2e-acp-persistence` requires Docker and the local Stage 3 images
(`make docker-build-stage3`). It creates an independent Stage 3 project, a
private PostgreSQL wire proxy and a deterministic Model. Set
`ANTNEST_E2E_CONTROLLER_IMAGE` to test a Controller image other than
`antnest/agent-controller:local`. The profile cannot target an existing stack.

## Scenario

The client uses the public Provider, Model, Template and execution-audit APIs and
has neither database credentials nor a Docker socket. Only the host observes
ACP's natural exit code 1 and restarts the same owned container.

The proxy confirms PostgreSQL's successful command tag and idle ReadyForQuery
before holding the result; it never issues or retries SQL. Public audits prove
the write is already durable while ACP is blocked. After the loss and restart,
two independent reconnects must preserve ordered message, Tool and usage
history. Subsequent real Bash work verifies recovery and that physical effects
happen exactly once.

The 60-second database timeout is fixture-only and allows inspection before the
explicit drop. A proxy hold expiring is a different, failing fault outcome.

## Results and evidence

Strict Trace warnings, observed error spans and missing evidence are failures
and return nonzero even when business checks pass. Abrupt shutdown can lose
unexported spans; the fixture reports those gaps instead of inventing them. Raw
audits, fault receipts, process observations and Traces are private artifacts
under `artifacts/verification/acp-persistence/<project>/`.

## Cleanup

Root cleanup removes only the test project's Compose and Runtime resources.
