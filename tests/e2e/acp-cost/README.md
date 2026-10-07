# ACP Session cost E2E

This scenario verifies Model pricing, Session usage and cost reporting through
the deployed ACP service on a disposable full stack.

## Running

```sh
npm --prefix services/agent-acp-service ci
make docker-build-stage3
make test-cost-fixtures
make e2e-session-cost
```

`make test-cost-fixtures` runs the fixture validators without Docker.
`make e2e-session-cost` uses an independent disposable Docker project and a
deterministic model, so it spends no external Provider credit. Temporal has no
host port, dynamic addresses avoid the fixed Egress and Jaeger addresses, RPC
content capture is disabled, and the project does not read the developer
`.env`.

## Contract

- Provider Connections own the endpoint and credential. Models expose their
  current prices under a stable ID, and edits use `expected_version`. Templates
  reference that stable ID, and Agents use the returned Template revision.
- ACP selects current rates for each Run, including `agent_default`. A selected
  Model also uses prices published after selection. An in-flight Provider
  request keeps its execution-time rates when the Model is edited; the next Run
  uses the updated rates. The test waits for ACP's public configuration
  fingerprint to change before the next execution.
- Official SDK v1 WebSocket, v2 WebSocket and v1 Streamable HTTP clients check
  raw decoded frames before SDK field sanitization. Provider-reported cost takes
  precedence, explicit zero stays zero, unknown differs from free, cache
  estimates use subset token counts, and missing cache rates fall back to the
  input rate. Private measurements, receipts and rates never enter ACP.
- Replay replaces cumulative usage; it must not call the model or add cost. New
  Sessions start without inherited usage. Forks inherit their baseline and then
  evolve independently. Parent and fork model choices and totals survive a real
  restart of the disposable ACP container, including repeated loads. Container
  health is followed by public execution readiness and confirmation of the
  pre-restart configuration fingerprint; only startup HTTP 503 is retried.
- Foreign users receive the exact ACP `access_denied` error, and cross-Agent
  Session requests receive `session_access_denied`, with no updates or
  execution. A separate authorized observer keeps its USD 0.77 history. Catalog
  publication may refresh that observer's own config options and unchanged v1
  mode; any other notification, foreign Session or changed choice fails
  isolation.
- Every Session request uses its actual SDK JSON-RPC ID. WebSocket Traces must
  link to the connection; HTTP Traces use the Gateway response Trace ID. Each
  model attempt belongs to an ACP-owned Run with current Runtime preparation,
  the actual Provider HTTP identity, committed reply persistence and durable Run
  closure. No Tool execution or Controller admission or finalization is
  expected. Pricing commands separately require Gateway, Admin Console and
  Controller ancestry and a committed Model SQL write.

Strict Jaeger timing and ordering failures keep a nonzero exit even when the
business, privacy and ancestry checks pass. Only the reviewed clock-skew warning
(`clock skew adjustment disabled; not applying calculated delta of ...`) is
reported without failing the exit.

## Cleanup

The wrapper bounds requests, container inspection, restart health and cleanup.
The observer connection closes before Agent deletion. The shared
`withAgentCleanup` helper attempts to delete every created Agent and preserves
an earlier business failure if cleanup also fails. The disposable project is
removed afterwards.
