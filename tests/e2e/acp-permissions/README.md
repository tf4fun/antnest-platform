# ACP Tool permission E2E

This scenario verifies Tool permission modes, approval decisions and pending
approval recovery through the deployed ACP service on a disposable full stack.

## Running

```sh
make test-permission-fixtures
make e2e-tool-permissions
```

`make e2e-tool-permissions` needs the current local service images
(`make docker-build-stage3`) and the `antnest/antnest-runtime:managed-integration`
image. That image adds the official SDK managed MCP fixture to the production
Runtime for unannotated Smart Approve calls; all builtin Tools still use the
ordinary Runtime implementation. See [managed MCP](../managed-mcp/README.md) for
how the image is built.

The root driver creates an isolated Compose project with temporary ports,
non-overlapping networks, synthetic credentials and RPC content capture
disabled. The permission wrapper refuses direct invocation without that
disposable owner. No existing development stack or external model Provider is
used. Provider connections publish two Models; Templates use the stable default
Model identity, and Agents use the returned Template revision and the current
readiness contract.

## Scenarios

The test covers 26 v1 and v2 scenarios: allow and reject, once and always,
cached decisions, Chat, Approve and Smart modes, per-Session model selection,
builtin read-only hints, exact-call Smart judgments, cancellation, and pending
approval recovery after reconnection. It checks both wire formats for Tool
updates before approval, requires unchanged approval parameters after
reconnect, and checks the terminal v2 state and stop reason. Smart judge text
must stay out of the chat.

The deterministic model must receive exactly 52 requests, including four hidden
Smart judgments, on the expected Model for every phase. Each prompt Trace
correlates the model HTTP CLIENT spans to ACP-owned Runs, committed persistence,
fresh Runtime preparation and the permission outcome. Every approval wait must
precede its permitted dispatch; rejected, cancelled and Chat Runs must have no
Tool effect. Runtime SERVER and Tool ancestry and Run IDs are required for every
effect. Two reconnect request Traces prove that load and resume do not execute a
second Run, and two foreign-user denials require the specific ACP access error
with no private updates or execution. The v1 reconnect prompt closes its socket
before the answer, so only that ACP prompt span may record the failed response
dispatch.

Topology and secret-boundary results are reported separately from strict Jaeger
timing. Timing warnings alone exit 2; any other failure exits 1. The fixture
does not synchronize clocks, rewrite timestamps or waive unrelated diagnostics.

## Optional modes

- `ANTNEST_E2E_BROWSER=true make e2e-tool-permissions` pauses with a synthetic
  owner and Agent before teardown so the UI can be inspected manually. The
  client's `browser_ready` record contains the account and Agent. Release the
  pause with the fixture's `POST /release-ui`. Browser interactions are not part
  of the automated protocol result.
- `ANTNEST_E2E_PERMISSION_CRASH=true make e2e-tool-permissions` deliberately
  kills the client at its first pending approval. Expect client exit 137 (Make
  exit 2) and a successful independent Agent cleanup record. This is a cleanup
  negative control, not a passing protocol run.

## Cleanup

The client deletes its Agents through the Gateway and Controller before Trace
collection, so Runtime shutdown flushes OTLP. Independent wrapper cleanup then
discovers only this invocation's UUID-qualified Agents, closes their Sessions
through ACP and deletes them through the Gateway and Controller, even after the
client is lost. It attempts every owned Agent and reports partial failure. The
root owner then stops resource creators, removes Compose and Runtime resources
under both scope labels, and checks for leftovers, including volumes and
identity and catalog data. A control-plane cleanup failure stays visible even
when Docker cleanup succeeds. If the root owner itself is killed, automatic
cleanup cannot be guaranteed; inspect both the project and Runtime scope labels.
