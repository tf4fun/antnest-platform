# Native Multimodal Deployment Revalidation

Recorded: 2026-09-17 (Asia/Shanghai), candidate `fd0867c` plus the acceptance
migration worktree. This batch changes acceptance fixtures and documentation,
not production service implementations. All **three transport profiles** and
**48 independent request Trace topology/privacy checks** passed. Strict Trace
remains failed: 19 traces have Jaeger timing warnings and one additional trace
has a negative model-to-closure timestamp gap. Driver exit 1 / Make exit 2 is
preserved. This is scoped business/topology evidence, not full strict acceptance.

## Current Fixture Contract

The [native input driver](../tests/e2e/acp-multimodal/README.md) creates current
Provider/Model resources and reads stable Model details to verify image/audio/PDF
capability projections and credential isolation. Template/Agent setup uses the
returned revision and executable readiness. Foreign users initialize with the
official SDK, then must receive exact ACP `access_denied`; cross-Agent operations
retain exact `session_access_denied` checks and zero private updates.

The existing seven-part mixed input is preserved: text, PNG, WAV, PDF, embedded
UTF-8 text, Base64-encoded UTF-8 text and an HTTP resource link. The model checks
exact normalized parts/bytes and order. Native content remains in continuation
and restored-model requests. Load/resume/fork must preserve history without
Provider requests. The link fixture records any fetch attempt, including an
ignored response; its count must remain zero.

The client reuses the bounded official SDK transport observer from command
acceptance. Each WebSocket request is correlated by its actual JSON-RPC ID,
Agent/Session/method and original connection link. HTTP uses the Gateway response
Trace ID, actual request ID and complete Gateway/ACP ancestry. The previous
HTTP helper used an unsupported cancellation option and invented one Trace
parent for a whole connection; both assumptions are removed.

Successful and failed Runs must have one ACP Run identity, quiescent terminal
state and no Tool effect. Actual pg driver evidence for the atomic Run-finish
CTE replaces Controller admission/finalization RPC assumptions. Successful
replies additionally require a committed transaction with an actual driver
write. Local model capability failures happen before Provider HTTP, so they
require one failed `model.complete` with `model_unsupported_content`, zero HTTP
attempts and a failed durable Run. v1 returns −32022; v2 returns its accepted
response followed by exactly one `_failed` terminal state. Restoring the native
Model then permits another successful Run with the same attachment history.

Fresh Runtime information and catalog reads must precede each model attempt.
No native prompt may dispatch a Tool. Replays, configuration and rejected
requests must not execute a Run or contact model/Runtime. Only the exact local
capability-failure model/Run/v1-request diagnostics are allowed; unrelated
errors fail. Privacy checks cover native bytes, embedded/PDF canaries, synthetic
passwords/API key, cookies and disabled RPC content capture.

A dedicated Compose override ignores local `.env`, removes the fixed Temporal
port and separates dynamic network addresses from fixed Egress/Jaeger IPs.
The disposable root retains bounded waits, cleanup and dual ownership-label
checks. Only the model is deterministic: Gateway, Identity, Console, Controller,
ACP, Rust Runtime, PostgreSQL, Temporal and Jaeger are real services. No real
Provider is contacted and no production implementation is modified.

## Images And Evidence

Existing verified images were reused without rebuilding:

| Image | Immutable ID |
| --- | --- |
| ACP | `sha256:e3aa69201e82455db532a47bb6417eadb344260d4119a237c5e9f35818273c9f` |
| Runtime | `sha256:2ed4ffe11b2f7ce24de4bcfb07566e7de012637400c7a82d3703fdc53ab1b909` |

The first attempt (`antnest-stage3-e2e-71646`) passed all three business
transports, then failed the newly added timestamp-order assertion on the v2
local capability-failure trace. Both executor branches await the model before
the finish CTE, but exported timestamps must be judged independently from the
actual terminal write and subsequent successful Session reuse. The first
attempt did not retain the numerical gap and is not retrospectively marked
as a complete Trace pass.

A test first reproduced the order-failure reporting gap. The validator now
records model start/duration and finish-query start, calculates the raw gap and
keeps a negative gap as an explicit **strict failure**, even if Jaeger emits no
warning. It does not alter timestamps or add tolerance. Business/topology checks
still require the terminal driver write, exact failure diagnostics and successful
post-failure reuse; unrelated errors remain fatal. The complete rerun used `antnest-stage3-e2e-72843`:

| Evidence | Recorded result |
| --- | --- |
| Transports | v1 WebSocket, v2 WebSocket and v1 HTTP/SSE passed |
| Native input | Exact seven-part input, native history and reference semantics verified; reference fetch count stayed zero |
| Provider requests | Exactly nine: native input, continuation and restored-model prompt once per transport |
| Local model failures | Three; one failed model attempt and durable failed Run each, zero Provider HTTP requests, followed by successful Session reuse |
| Invalid input | Six exact rejections: ZIP and oversized WAV on each transport; zero Run/model/Runtime execution and no output |
| Recovery | Nine load/resume/fork requests; four-message source and fork history retained exactly, no model replay |
| Identity isolation | Three foreign-user and nine cross-Agent operations rejected without private updates or execution |
| Trace inventory | 12 execution traces, 18 successful setup/configuration/replay traces and 18 rejected request traces; 48 distinct IDs and 12 distinct Runs |
| Execution evidence | Current pg driver closure, committed successful replies, 12 Runtime information reads and 12 catalog reads, exact model correlation, zero Tool effects |
| Errors/privacy | Only deliberate capability-failure and exact rejection diagnostics; no unrelated errors, native content, credentials or RPC payload export |

Three successful-execution, two local-failure and 15 other request traces failed
strict timing. The other 28 were strictly clean. Jaeger repeated warnings through
descendants, producing 1,667 entries across 19 traces, not that many independent
faults. Positive calculated Gateway-to-ACP deltas ranged from 17.683–809.945 µs.
The negative calculated deltas and raw ACP SERVER offsets relative to its
Gateway CLIENT were:

| Request | Calculated delta | Raw start/end offsets |
| --- | --- | --- |
| v1 WebSocket oversized audio | −23.095686 ms | +30,620 / +15,571 µs |
| v2 WebSocket oversized audio | −13.373534 ms | +17,669 / +9,078 µs |
| v1 HTTP foreign user | −849.765 µs | +1,676 / +25 µs |
| v1 HTTP new Session | −139.303 µs | +184 / +96 µs |

The additional `v1-ws:mismatch` order failure had identical exported model/finish
start timestamps at an integer-millisecond boundary, with model duration 454 µs.
Its calculated model-end-to-finish-start gap was therefore **−454 µs**; Jaeger
emitted no warning for that trace. This is an observed timestamp inconsistency,
not proof of physical clock drift or actual execution reordering. Raw start,
duration and gap are retained. The
[existing timing maintenance deferral](controller-acp-execution-boundary-plan.md#obs-acp-clock)
is unchanged; the separate order failure is explicit and neither result is
converted into a pass.

Final verification passed **98 local tests**, zero failures/skips/cancellations:
12 multimodal, 13 permission, 11 command, 16 Plan, 14 file, 16 progress, ten shared
model/Trace collector, two Docker-wrapper and four connection timeout/cancellation
tests. At that batch, the 12 multimodal tests included three unchanged legacy
cases for the pending cost consumer; the subsequent cost batch retired them. New setup/current-Trace/oversized-audio rejection
coverage and order-failure reporting first failed before repair. Formatting,
shell syntax, rendered deployment wiring/isolation, document links and Git
whitespace checks passed.

Both temporary projects passed independent cleanup scans by Compose/Runtime
labels and resource names. No containers, volumes, networks or verification
child processes remained. The 12 retained development containers kept their IDs,
images and health state (11 healthy, Jaeger without a health check). No retained
data, rollback image or private backup was part of cleanup.

## Asset Dependencies And Scope

At the end of this batch, the migrated driver used `trace.mjs`, while the old
`evidence.mjs` admission oracle and three cases remained for the cost consumer.
The subsequent [cost batch](session-cost-revalidation.md) migrated that final
consumer and retired them after current deployment and cleanup checks. A green
legacy fixture test does not establish current deployment acceptance. Shared request-boundary/transport
helpers from the migrated command suite are reused; the shared rejection
validator now also admits the specifically checked oversized-audio denial.

This batch checks the declared JSON-RPC request traces. Independent HTTP SSE
and connection-close traces are outside that count, while actual SSE delivery
is exercised by the HTTP business flow. No browser, paid Provider, real-model
recognition-quality or universal ACP conformance claim is made. The original
F09 report keeps its historical date/candidate.
Session cost was the next batch and is now recorded in the
[cost report](session-cost-revalidation.md). The current next batch is the base
Stage 3 product flow in the [asset inventory](acceptance-asset-migration.md).

Ignored local evidence is under `artifacts/verification/legacy-acceptance-20260917/`:
`multimodal-red.log`, `multimodal-order-red.log`, `multimodal-gates-final.log`,
`multimodal-docker-1.log`, `multimodal-docker-2.log`, `multimodal-result.json`,
`multimodal-summary.json`, `multimodal-compose.json` and `multimodal-cleanup.json`.
They contain compact outcomes and warning/timing details. Raw service logs that
could contain credentials were omitted; cache files are not guaranteed in a
fresh clone.
