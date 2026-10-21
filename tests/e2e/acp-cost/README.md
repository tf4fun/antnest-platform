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

The child has a 30-minute total budget for 151 ACP requests and 19 pricing
commands. Auxiliary Trace inspection has a shared 60-second active collection
budget; each successful collector retains its three stable full-source samples.
Missing or failed observations remain explicit warnings. The actual restart
and health/ACK sequence keeps its independent 90-second bound.

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

All Span and Trace findings are auxiliary under [AGENTS.md](../../../AGENTS.md).
The client preserves each original collector failure and strict result in
`trace_diagnostics` and `observability`; it exits successfully only after the
independent business assertions and actual resource cleanup pass. Missing spans,
Jaeger query failures, topology, timestamps and Trace metadata do not prevent
subsequent business checks. Provider count/phase, usage/cost, authorization,
persistence, restart, Runtime ACK and deletion remain blocking requirements.

The Cost and Progress collectors call `reviewCostWarningSources` for both live
inspection and archive revalidation. Standard Jaeger clock-skew diagnostics on
identified ACP/private-client Node OpenTelemetry spans are recorded as
`waived-external-node-otel-timing`. This known SDK timestamp family does not
require an endpoint threshold, a unique candidate edge or additional per-edge
proofs. Each original occurrence is retained and counted once in
`waived_external_sdk_warning_count`; its process and direct parent remain
recorded without claiming a unique clock-skew origin. The same standard timing
diagnostics on the Runtime's identified Rust OpenTelemetry spans are recorded as
`waived-external-otel-timing`, including normal server completion after client
cancellation. Unidentified SDKs and other warning families are not relabeled.

`inspectCostWarningSources` remains a technical diagnostic inventory. Its
historical sub-millisecond and WebSocket phase classifications do not impose
additional delivery gates on waived SDK findings. Phase checks use event names
and timestamps and preserve Jaeger's original array order. The separate Runtime
HTTP cleanup classification retains its historical parsed-tool proof. Delivery
still requires the owning success or cancellation proof; a timestamp warning
cannot authorize a failed tool, unexpected error or missing actual-stop
evidence. The raw calculated Jaeger delta and original span
timestamps are never rewritten.

The strict diagnostic collector still checks its full Trace sources and binds
three consecutive stable samples,
original query bytes and SHA-256 receipts. The public projection records the
waiver count without replacing raw warnings or `strict_trace=failed`.
Pricing uses the same fixed SDK policy on every complete Resolve sample. Its
content validator retains topology, duration, service, header and RPC-payload
checks after warning review; these remain auxiliary inspection findings. Resolve and pricing inventory use the same raw-error predicate, so an
empty `error.type` on a successful span remains neutral; nonempty error details
and failed outcomes still fail.

A successful strict ACP diagnostic requires the original returned object and unchanged report,
manifest, raw archive and private review. Clones, accessors, delayed mutations,
duplicate business Traces and inconsistent shared sources fail. Aggregation
uses the private checked snapshots and counts shared warning occurrences once.
Pricing separately binds the original returned object, three stable source
samples, raw query bytes and private warning review. Controller publication to
ACP requires zero internal errors and a committed Model price write across the
complete pricing closure. Cloned or modified reports, changed archives, duplicate
pricing Traces and inconsistent shared sources fail. Reviewed pricing warnings
also preserve `strict_trace=failed` and exit 2 when all ACP diagnostics are clean;
`pricing_reviewed_warning_occurrences` reports the distinct pricing occurrences.
Local collector tests do not establish a complete Docker or cross-service pass.

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
Cleanup failure remains exit 1 even when all business assertions have passed
and only auxiliary Trace findings remain.

Private evidence is under `artifacts/verification/acp-cost/<project>/`, with
Trace bodies in `traces/`, restart evidence in `restart/`, and Runtime request,
receipt and inspection in `deployment/`. Files use mode 0600 and directories 0700. Model HTTP bodies retain exact bytes, including partial UTF-8 on failure;
Docker inspection files preserve the wrapper's complete trimmed decoded output
with one appended newline, not raw CLI stdout/stderr bytes.
