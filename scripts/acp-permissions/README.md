# Tool permission deployment acceptance

F06 uses an already-running, current Stage 3 development stack. It shares that
stack's PostgreSQL instance, creates uniquely named synthetic users/models and
Agents through Gateway, and deletes its Agents/Runtime resources after testing.
No external provider or real credentials are required.

Build and deploy current Agent Controller, ACP Service and Agent UI first. The
Runtime managed-integration image supplies an unannotated MCP fixture for Smart
Approve. Other builtin Tools use the ordinary Runtime implementation.

```sh
COMPOSE_PROJECT_NAME=<stage3-project> make e2e-tool-permissions
```

The test checks v1/v2 allow/reject once/always, cancellation, reconnect, mode and
model changes, read-only hints, exact-call Smart judgments and hidden judge text.
Jaeger assertions require Gateway ancestry, Run ownership, approval-before-
dispatch ordering, real Runtime descendants and zero dispatch for rejected calls.
Fixture model counts and traces must agree. Model selection is checked for each
phase in each version, and every Smart scenario must include exactly one judge
request. No packet-level tracing is involved.

`ANTNEST_E2E_BROWSER=true` pauses with a synthetic owner and Agent for browser
acceptance. Release via the fixture's `POST /release-ui`; the client observes this
with bounded short requests, avoiding an idle HTTP connection timeout. Inspect the
test client logs for the synthetic account and Agent.

The wrapper owns cleanup independently of the client: even after interruption or
client loss, it discovers only this invocation's UUID-qualified Agent names,
cancels their Sessions through ACP and deletes them through Gateway/Controller.
It attempts all owned Agents, reports failures, then removes its temporary
model/client/cleanup containers. No direct database or platform deletion bypass is
used for Agent cleanup. If Gateway itself is unavailable, cleanup fails visibly;
it cannot promise recovery from a dead control plane or a killed wrapper.
`ANTNEST_E2E_PERMISSION_CRASH=true` deliberately kills the client container at
its first pending approval; expect failure exit 137 and a successful independent
cleanup result. This is a cleanup negative control, not the passing protocol suite.
Catalog and identity records stay in the development stack, without active Runs.
