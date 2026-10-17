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

The private fault Trace inspector binds the held and dropped receipt to the
original Session, Run, SQL hash and durable/recovered audit. It requires the
complete intent/acceptance SQL inventories, including attempted rollback after
the lost COMMIT, and recognizes only the exact SQL error and origin-linked
transaction/application/RPC propagation. Finish faults keep the completed audit
and original Run error together; v2 retains its actual durable-message ACK.
Two Model requests and one Bash Tool retain complete Runtime information and
tool proofs, including the independent v1 completion refresh. Missing parents,
missing SQL, hidden SQL descendants, management calls inside a Run and unrelated
internal errors remain failures. Validation views never alter raw evidence.
Confirmed external SDK problems remain non-blocking, with no SDK investigation
or workaround added by this inspector.

The client now collects all 48 private request Traces through their original
connection and request receipts, with three stable complete source samples.
Initialization, Session creation/replay, ordinary prompts and the six injected
faults use their owning inspectors. The complete inventory also binds all 16
Provider requests, 12 distinct durable Runs, eight executions and eight Tools.
Create and delete retain their separate Lifecycle and shared Resolve admission.
All 50 business Traces must be distinct; neither policy can borrow the other's
error claims.

Every Lifecycle query retains its original response bytes, including incomplete
or malformed bodies. Cancellation joins body cleanup; read, cancel, release and
archive failures are retained together. Partial reports remain private when a
later check fails, and cancellation after the final child collection cannot
publish an accepted parent result. Controlled source fixtures cover this complete
collection path; they do not replace the deployed recovery scenario.

Issue [#167](https://github.com/tf4fun/antnest-platform/issues/167) requires
this persistence scenario to become ACP component tests and its platform Make
target to be removed. The component migration uses real PostgreSQL and production
ACP recovery with fake Runtime/model boundaries. Existing private evidence is
retained; a new whole-platform Docker deployment is no longer planned. The legacy
entrypoints below remain only until their replacement passes.

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

Internal missing spans, incomplete evidence and unowned errors remain failures
with exit code 1. Exact injected-fault claims and confirmed external SDK
diagnostics remain visible in the original `strict_trace` result. An accepted
collection whose raw diagnostics failed returns exit code 2; wholly clean
evidence returns 0. The pending deployment harness must preserve that distinction.
No generic error-type whitelist admits an unrelated internal error, and confirmed
SDK issues require no further investigation or workaround. Raw
audits, fault receipts, process observations and Traces are private artifacts
under `artifacts/verification/acp-persistence/<project>/`.

## Cleanup

Root cleanup removes only the test project's Compose and Runtime resources.
