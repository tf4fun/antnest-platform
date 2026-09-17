# ACP persistence recovery

The [contract](contract.md) maps current ACP-owned Run persistence and recovery.
P1 exercises committed PostgreSQL response loss at intent, acceptance and
completion for both installed official SDK versions. P2 is a separate process
interruption migration; P1 does not replace unknown-effect recovery coverage.

`make test-acp-persistence-fixtures` runs serial unit/contract/HTTP checks.
Set `TEST_POSTGRES_URL` to a **disposable test database** to include the real
PostgreSQL proxy component tests; they recreate their fixture tables. An omitted
URL produces explicit skips, which do not count as database component evidence.

`make e2e-acp-persistence` creates an independent Stage 3 project, private database
wire proxy and deterministic Model. It uses the public Provider/Model/Template
and execution-audit APIs. The client has neither database credentials nor a
Docker socket. Only the host observes ACP's natural exit 1 and starts that same
owned container. This profile cannot target a retained stack.

The proxy confirms PostgreSQL's successful command tag and idle ReadyForQuery
before holding the result; it never issues or retries SQL. Public audits prove
the write is already durable while ACP is blocked. After loss and restart,
two independent reconnects must preserve ordered message/Tool/usage history.
Subsequent real Bash work verifies recovery and physical effects exactly once.
The 60-second database timeout is fixture-only and allows inspection before the
explicit drop; a proxy hold expiration is a different, failing fault outcome.

Set `ANTNEST_E2E_CONTROLLER_IMAGE` to an immutable candidate image when validating
the separate Controller publication Trace change. Normal service image tags are
otherwise unchanged. Raw audits, fault receipts, process observations and traces
are private artifacts under `.cache/acp-persistence/<project>/`.

Strict Trace warnings, observed error spans and missing evidence remain failed
and return nonzero even when business checks pass. Abrupt shutdown may lose
unexported spans; the fixture reports those gaps. Root cleanup removes only the
test project's Compose and Runtime resources. Historical shared helpers remain
until their final consumers have current evidence.
