# ACP persistence recovery E2E

This scenario verifies that the ACP service recovers correctly when a committed
PostgreSQL response is lost at Run intent, input acceptance or Run completion.
It runs for both installed official ACP SDK versions. The [contract](contract.md)
defines the recovery obligations. Process interruption and unknown Tool effects
are covered separately by [ACP restart](../acp-restart/README.md).

## Private transport migration

The client reads execution state through the private
`/rpc/agent-acp/get-agent-execution-state` endpoint. Every read delegates the
original owner's login Principal and Agent scope through Identity, uses the
existing workload grant, and validates the complete execution-state schema.
Every completed read writes the original response to private evidence, including
failed reads. Read and archive errors are both retained; an archive failure
cannot become a successful readiness check or a recovery retry. Denied owner
access and cancellation during the joined archive remain failures. Foreign
Agents and malformed states fail immediately. Only ACP's exact
startup-unavailable response is retried while waiting for readiness; the held
completion check still requires an actual busy state.

The shared reader comes from the already verified Cost consumer. Its Cost
entrypoint preserves the existing recovery error type. Persistence loads the
reader lazily so Restart's existing lightweight readiness import does not gain
a schema or dependency requirement before that consumer migrates.

Private ACP connections now reuse the existing shared connector, including its
single initialization and the owner's original Principal delegation. A joined
private recorder binds every actual outgoing request to its connection, Agent,
protocol and input/returned Session. It preserves original inputs, results,
failures and pre-SDK response frames after each request and after closing.
Business and evidence/cleanup failures remain failures together. The five
unacknowledged fault prompts must fail; v2 completion retains its actual prompt
ACK and the separate busy-state check. No deliberate local-close exception is
borrowed from another scenario.

The six cases require exactly 18 closed connections/initializations and 30
business requests (six new, twelve prompts, six loads and six resumes). Missing,
duplicate, stale or foreign receipts fail the inventory check. Existing real
SDK/TCP peers exercise the recorder; these checks do not replace natural process
exit, database durability, replay or physical Bash effects in Docker.

Private Trace collection and owning Docker deployment remain pending.
Deployment must supply the execution-state schema,
Identity and ACP grants, and private listener reachability before this profile
can run against the retired Gateway routes.

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
and return nonzero even when business checks pass. Two reviewed exceptions are
reported in `strict_trace` without failing the exit: the clock-skew warning
(`clock skew adjustment disabled; not applying calculated delta of ...`), and a
fault Trace whose intercepted SQL is verified and whose errors are only the
injected `database_error` and its propagated ACP `Error` spans. Abrupt shutdown can lose
unexported spans; the fixture reports those gaps instead of inventing them. Raw
audits, fault receipts, process observations and Traces are private artifacts
under `artifacts/verification/acp-persistence/<project>/`.

## Cleanup

Root cleanup removes only the test project's Compose and Runtime resources.
