# Tool permission deployment acceptance

Run `make e2e-tool-permissions` with current local service images and the
`antnest/antnest-runtime:managed-integration` image. The latter adds the official
SDK managed MCP fixture to the production Runtime for unannotated Smart Approve
calls. All builtin Tools still use the ordinary Runtime implementation.

The root driver creates an isolated Compose project with temporary ports,
nonoverlapping networks, synthetic credentials and RPC content capture disabled.
The permission wrapper refuses direct invocation without that disposable owner.
No retained development stack or external model provider is used. Provider
connections publish two Models; Templates use the stable default Model identity
and Agents use the returned Template revision and current readiness contract.

The test preserves 26 v1/v2 scenarios: allow/reject once/always, cached decisions,
Chat/Approve/Smart modes, per-Session model selection, builtin read-only hints,
exact-call Smart judgments, cancellation and pending-approval recovery after
reconnection. It checks both wire formats for Tool updates before approval,
requires unchanged approval parameters after reconnect, and checks terminal
v2 state/stop reason. Judge text must stay out of chat.

The deterministic model must receive exactly 52 requests, including four hidden
Smart judgments, on the expected model for every phase. Twenty-six independent
prompt traces correlate the actual model HTTP CLIENT spans to ACP-owned Runs,
committed persistence, fresh Runtime preparation and permission outcomes.
Sixteen approval waits must precede their permitted dispatches; rejected,
cancelled and Chat Runs must have no Tool effect. Actual Runtime SERVER/Tool
ancestry and Run IDs are required for all 16 effects. Two reconnect request
traces prove load/resume do not execute a second Run; two foreign-user denials
require the specific ACP access error and no private updates/execution.

Topology and secret-boundary evidence are reported separately from strict
Jaeger timing. Any timing warnings retain a failing process exit. This fixture
does not synchronize clocks, rewrite timestamps or waive unrelated diagnostics.

`ANTNEST_E2E_BROWSER=true make e2e-tool-permissions` optionally pauses with a
synthetic owner and Agent before teardown. Release via the fixture's
`POST /release-ui`; bounded short requests observe the release. Inspect the
client's `browser_ready` record for the account and Agent. Browser interactions
are outside the frozen 26-scenario model/trace snapshot and are not implied by
the automated protocol result.

The ordinary client deletes its Agents through Gateway/Controller before Trace
collection so Runtime shutdown flushes OTLP. Independent wrapper cleanup still
discovers only this invocation's UUID-qualified Agents, closes their Sessions
through ACP and deletes them through Gateway/Controller after client loss.
It attempts all owned Agents and reports partial failure. The root owner then
stops resource creators, removes Compose and Runtime resources under both scope
labels, and checks for leftovers, including volumes and identity/catalog data.
A control-plane cleanup failure remains visible even when Docker cleanup succeeds.

`ANTNEST_E2E_PERMISSION_CRASH=true make e2e-tool-permissions` deliberately kills
the client at its first pending approval. Expect client exit 137 (Make exit 2)
and a successful independent Agent cleanup record. This is a separate cleanup
negative control, not a passing protocol run. A forcibly killed root owner cannot
promise automatic cleanup; inspect both project and Runtime scope labels.

Current migration evidence is recorded in
[the permission revalidation report](../../docs/tool-permission-revalidation.md).
