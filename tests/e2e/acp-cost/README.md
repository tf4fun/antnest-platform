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

The runner derives eleven candidate images from the current release inputs under
unique `cost-<run ID>` tags. It checks the actual fourteen-service Compose stack,
preparer image, model/client images and four Runtime containers against that
manifest. Compose uses `--no-build --pull never`; only recorded, owned candidate
tags are removed. CI may supply the release inputs from the same run's image
artifacts. The client receives only the read-only `gateway-identity` and
`agent-ui-acp` grants and runs as the evidence owner, without a Docker socket.
Its Trace validators also receive read-only mounts of the Identity, Controller
and Runtime Controller JSON contracts that define receiving RPC registrations.
The private execution-state validator receives its ACP JSON Schema the same way.
The actual Gateway Resolve TTL is checked against the value forwarded to the
client, including a disabled cache or a non-default TTL.

The child has a 30-minute total budget: 151 ACP requests and 19 pricing commands
each require three stable full-source Trace samples, whose minimum waits alone
total 22 minutes 40 seconds. The actual restart and health/ACK sequence has its
own 90-second bound. CI invokes the Stage 3a recipe directly so exit 2 survives.

## Contract

- Provider Connections own the endpoint and credential. Models expose their
  current prices under a stable ID, and edits use `expected_version`. Templates
  reference that stable ID, and Agents use the returned Template revision.
- ACP selects current rates for each Run, including `agent_default`. A selected
  Model also uses prices published after selection. An in-flight Provider
  request keeps its execution-time rates when the Model is edited; the next Run
  uses the updated rates. The test waits for ACP's private execution-state configuration
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
  health is followed by private execution readiness and confirmation of the
  pre-restart configuration fingerprint; only the exact
  `execution_state_unavailable` startup HTTP 503 is retried. Each read uses the
  original login Principal, a fresh workspace Resolve and the Agent UI grant.
- Foreign users receive the exact ACP `access_denied` error, and cross-Agent
  Session requests receive `session_access_denied`, with no updates or
  execution. A separate authorized observer keeps its USD 0.77 history. Catalog
  publication may refresh that observer's own config options and unchanged v1
  mode; any other notification, foreign Session or changed choice fails
  isolation.
- All three SDK transports use the private ACP connection. Every request uses
  its actual SDK JSON-RPC ID and original request/result receipt. WebSocket
  Traces link to their real connection; HTTP requests retain their actual
  private transport response and client span identity. Each
  model attempt belongs to an ACP-owned Run with current Runtime preparation,
  the actual Provider HTTP identity, committed reply persistence and durable Run
  closure. No Tool execution or Controller admission or finalization is
  expected. Pricing commands separately require Gateway, Admin Console and
  Controller ancestry and a committed Model SQL write.

The inventory contains fourteen connections (ten WebSocket and four HTTP),
137 business RPCs and fourteen separately archived initialize requests. It
checks 52 Runs/Provider attempts and zero Tools; the remaining business calls
cover configuration, list, creation, replay, fork and twelve refusals. Nineteen
pricing commands retain their complete Resolve main/source/refresh responses.
Raw decoded SDK frames are captured before schema sanitization, and every
connection is joined before restart or successful cleanup. Completed transport
outcomes are recorded only after replay, subsequent execution and connection
closure, and supply the final CI scenario count.

Strict Jaeger timing and ordering failures keep a nonzero exit even when the
business, privacy and ancestry checks pass. Strict-only findings retain raw
exit 2. CI can accept that result only after complete business evidence and
classification under its existing reviewed-warning rules. Unknown warnings,
invalid pricing evidence and Go pricing diagnostics remain failures.

`warning-source.mjs` inventories each original warning occurrence by Trace,
Span and index, then follows only `CHILD_OF` edges to identify
its source. Asynchronous connection Links cannot substitute for a parent.
The same-Node endpoint classification requires matching process resources,
safe integer timestamps, a child starting within its parent, integer-millisecond
starts, an end overrun strictly below one millisecond and exactly one matching
observation for that edge. The user's Node sub-millisecond investigation deferral
also covers a complete private Node CLIENT to ACP Node HTTP SERVER pair: both
process identities, route, method, status and direct parent must match, starts
must be integer milliseconds, and the raw end overrun must be strictly below
one millisecond. This is recorded as `deferred-node-http-sub-ms-endpoint`.
Independent SDK clock anchors and server completion after writing the response
can both contribute; the observation does not establish either cause. In
particular, ws writes 101 before the ACP connection setup callback returns.
Overruns at or above one millisecond cannot use that deferral. A separate
`reviewed-node-ws-post-response-endpoint` classification covers successful
private Node GET/101 upgrades with all three original
[ACP lifecycle events](../../../docs/observability-contract.md#acp-websocket-upgrade-lifecycle).
The exact source identities and direct parent must match; events must have
only their fixed names, be unique and ordered inside the same original SERVER,
and response preparation must fall inside the original CLIENT interval.
The production worker gate proves that the peer can accept 101 before setup
finishes. This permits the proven post-response lifetime, without claiming
all clock error has been excluded. Missing events, failed setup, ERROR, an
entire SERVER/event shift beyond the peer receipt, and other cross-process
boundaries remain rejected. Historical sources without events cannot use it.
`reviewed_lifecycle_warning_count` is separate from `deferred_warning_count`;
`eligible_for_review` requires every occurrence to qualify for exactly one of
the two policies. `eligible_for_deferral` retains its original meaning.
Duplicate warnings, ambiguous propagation, unknown messages and missing spans
remain rejected. The calculated Jaeger delta is retained separately from the raw end
overrun; its magnitude is not a measured clock offset or this policy's bound.

The diagnostic helper alone does not grant admission. The Cost collector uses
the fixed complete-source hook for the main Trace, connection and every HTTP
auxiliary source. An unproved warning immediately fails collection; a later
clean sample cannot hide it. The private warning review binds the actual final
three consecutive stable samples, original query bytes and SHA-256 receipts,
owning reports and their timing observations. The public projection identifies
that review without replacing the raw warnings or `strict_trace=failed`.

Final ACP admission requires the original returned object and unchanged report,
manifest, raw archive and private review. Clones, accessors, delayed mutations,
duplicate business Traces and inconsistent shared sources fail. Aggregation
uses the private checked snapshots and counts shared warning occurrences once.
Pricing is checked separately: Controller publication to ACP still requires
zero warnings and errors across the complete pricing closure. Local collector
tests do not establish a complete Docker or cross-service pass.

## Cleanup

The host first waits for the mid-business model restart checkpoint, verifies
the original candidate ACP/container and harness identities, and invokes one
actual Docker restart. It requires a later `StartedAt` on that same healthy
container before acknowledging the model. An exclusive attempt directory
prevents retrying an ambiguous restart. Final Runtime inspection requires this
same run's complete restart evidence, including the model/client IDs, before
it acknowledges four distinct Agents and candidate Runtime containers.

The client consumes that final Runtime ACK before successful Agent deletion.
`withCostAgentCleanup` preserves the original ACK and HTTP response bodies,
checks each distinct delete operation through completion, and attempts all
four deletions even after business, deletion or evidence-recording failures.
The shell archives client/model logs and then removes the disposable project.
Cleanup failure remains exit 1, including after an otherwise strict-only exit 2.

Private evidence is under `artifacts/verification/acp-cost/<project>/`, with
Trace bodies in `traces/`, restart evidence in `restart/`, and Runtime request,
receipt and inspection in `deployment/`. Files use mode 0600 and directories 0700. Model HTTP bodies retain exact bytes, including partial UTF-8 on failure;
Docker inspection files preserve the wrapper's complete trimmed decoded output
with one appended newline, not raw CLI stdout/stderr bytes.
