# ACP slash commands E2E

This scenario verifies ACP slash commands, embedded context and Session replay
on a disposable full stack. It uses a disposable Stage 3 Compose project with
one PostgreSQL instance holding separate service databases, the real Gateway,
Identity, Controller, ACP service, Runtime and Jaeger. Only the model is
deterministic. No external API key, client MCP injection or browser is needed.

## Running

```sh
npm --prefix services/agent-acp-service ci
make test-command-fixtures
make e2e-slash-commands
```

`make test-command-fixtures` runs the transcript and Trace validators without
Docker. `make e2e-slash-commands` reuses the bounded Stage 3 wrapper and must not
target an existing development project.

The wrapper builds all 11 release candidates under a unique `commands-<run-id>`
tag and starts Compose with `--no-build --pull never`. It records actual image
IDs for the services, Runtime preparer, model fixture and command client. CI may
supply explicitly selected images through the existing candidate-image adapter.

The fixture client has no Docker socket and never queries databases. Identities,
Templates and Agents are created through the Gateway. ACP Sessions use the
private ACP endpoint with an Identity-issued delegation and the Agent UI workload
grant. The client mounts only the Gateway-to-Identity and Agent-UI-to-ACP grants,
read-only, and runs as the host evidence owner.
Setup creates a Provider connection and Model, references the Model's stable
identity from a Template, uses the returned Template revision and waits for the
Agent to become executable. The command-specific Compose override ignores the
local `.env`, removes the host Temporal port and keeps dynamic IP allocation
separate from the fixed Egress and Jaeger addresses.

## Scenarios

1. Stable v1 WebSocket, stable v1 HTTP and draft v2 WebSocket clients receive an
   executable `help` catalog from the official ACP SDK. HTTP notifications may
   arrive separately from the Session setup response.
2. `/help` and `/帮助` execute through Prompt, keep a file reference, emit one
   assistant reply each and finish normally. They emit no usage or Tool calls
   and make no model fixture requests. ACP advertises `embeddedContext`, so the
   help prompt also keeps embedded UTF-8 text. Unsupported ZIP content must
   fail explicitly with `unsupported_resource_content`, without creating a Run
   or history.
3. Reconnect with load or resume replays exactly the original two user prompts
   and two replies. Resume without replay does not duplicate content. Fork
   copies the same history. Every setup returns one current catalog, never a
   saved catalog event presented as transcript.
4. Another user cannot access the Agent, and another Agent of the same user
   cannot load, fork or prompt the original Session. Rejections produce no
   catalog or content, and all three transports return exact ACP errors. An
   authenticated WebSocket upgrade or HTTP initialization does not grant Agent
   access; the foreign user's `session/new` must fail with `access_denied`.
5. After help, ordinary v1 and v2 prompts still execute a real Runtime Bash
   command and return its actual output.
6. Jaeger must contain one distinct Trace for each recorded request: six
   command Runs, two ordinary Runs and 32 setup, restore and rejection
   requests. Commands require the actual private ACP request ancestry, the current Run identity and
   committed ACP PostgreSQL writes, but no model, credential or Runtime
   operations. Runs must not call management services. Setup, restore and
   rejection Traces must contain the actual request without Run execution.
   Ordinary Traces correlate the model fixture's HTTP CLIENT IDs through
   `model.complete` to the owning Run, fresh Runtime preparation and exactly one
   real Bash invocation.

## Trace collection

WebSocket requests are observed at the official SDK stream boundary without
changing messages. Their JSON-RPC IDs and actual upgrade CLIENT connection links
distinguish repeated prompts and resumes on one connection. HTTP records each
actual fetch CLIENT span, its private ACP HTTP receiver and the dispatch ancestry.
Initialization, POST acknowledgement, SSE and DELETE retain their original
response and fully joined close receipts. Auxiliary transport requests do not
increase the 40 business-request count. Fork input and resulting Session IDs are
checked separately. Observers
keep method, request and Session IDs, never prompt payloads. The domain-level
resume operation can be `acp.session.resume`, while the request boundary must
carry the actual wire method and JSON-RPC ID.

The shared private connection helpers accept the optional boolean
`captureRawFrames`. It is disabled by default. An owning consumer that enables
it receives `rawFrames` containing independent copies of all incoming decoded
JSON-RPC frames before SDK schema parsing, including initialize results, errors
and unknown usage fields. These are decoded frames, not original wire bytes or
a record of duplicate JSON keys. Capture follows the existing consumer's reads
without a second background stream; cancellation preserves its reason, joins
upstream cleanup and propagates cleanup failures. Typed SDK updates and outgoing
request metadata remain unchanged. The inventory stays in memory after close
and is never automatically exported to telemetry or console output. A consumer
must explicitly opt in and handle this payload-bearing inventory as private
evidence; this shared facility does not establish Cost business acceptance.

All Traces require full topology, disabled payload capture and private-content
checks. Rejection diagnostics are allowed only on the matching rejected ACP
boundary and domain operation, with the original SDK denial receipt. Collection
starts after each original connection is fully closed and its telemetry flushed.
It archives the complete raw HTTP response before parsing, follows the complete
Trace closure, and requires three stable rounds. Unrelated errors and timing
warnings fail acceptance. Reviewed normal-close/rejection diagnostics and the
existing Jaeger clock-skew warning policy are accounted for individually; raw
errors, warnings and `strict_trace=failed` remain visible even when business and
topology are accepted. The strictly sub-millisecond Node SDK investigation is
deferred separately; raw timestamps are never rewritten.

`collectPrivateACPConsumerTrace` shares this collection lifecycle with other
private ACP consumers. Each consumer supplies its primary-request inspector and
allowed diagnostic reasons; the collector snapshots those reasons before any
asynchronous work. Initialization, SSE and DELETE still use the fixed shared
inspectors, and inventories and strict counts always come from the collected raw
evidence. `collectPrivateCommandTrace` keeps the command policy fixed; transport
options cannot replace its inspector or expand its allowed reasons.

An optional `inspectCompleteSources` policy hook runs only after the owning
request, fixed transport checks and complete error inventory have passed. It
receives readonly JSON snapshots of `expected`, all `sources`, all owning
`reports`, and the original cancellation `signal`. WebSocket includes the
request and connection; HTTP includes the request, initialization, SSE and
DELETE. The hook may return only `undefined`. Refusal, input rewriting or a
damaged archive fails immediately; convergence retries cannot clear it. The
owning inspector receives isolated inputs, and subsequent output uses the
checked snapshots so retained references cannot change claims or timing later.

Successful hook-enabled collection adds a `complete_source_receipt` for the
actual last three consecutive stable samples. It binds full source snapshots
and each archived query's bytes and SHA-256; WebSocket also retains its complete
candidate snapshot. A missing sample resets convergence. The receipt describes
collection evidence and does not itself grant diagnostic admission or clear raw
`strict_trace=failed`. Consumers must bind their own policy decision to that
receipt and final result. Consumers without the hook keep their existing output.

The runner exits 0 for strict success, 2 when complete business/topology checks
pass with only reviewed strict findings, and 1 for failures. CI runs the Stage 3
recipe directly so exit 2 retains the existing warning classification; Make can
map a failed recipe to its own exit status. Cleanup failures always fail the run.

The transcript and Trace validators have positive and deliberately corrupted
fixtures. Missing Traces, missing persistence, duplicated replies, extra
execution and unrelated Runtime spans must fail. Raw queries, the independent
model-request inventory, business-request inventory and intermediate reports are
retained privately under `artifacts/verification/acp-commands/<project>/` with
restricted permissions. Console output uses ASCII JSON summaries. Evidence and
recovery inputs must not be stored in `.cache`.

## Cleanup

After the three protocol scenarios and complete connection cleanup, the client
waits for the host to inspect both live Agent Runtimes. The host saves the actual
Docker inspection, matches each Agent and Runtime generation to the candidate
image ID, and publishes a receipt bound to this run, request nonce and the raw
inspection SHA. Only then does the successful client proceed to Agent deletion.
The receipt does not give the client Docker access.

The client uses the shared `withAgentCleanup` helper, which attempts to delete
every created Agent and reports cleanup failures without hiding an earlier
business failure. The wrapper then removes the whole project, including
synthetic records, Runtime workspaces and test networks, after success or
failure. Inspection failure also enters this cleanup path. Remaining connections
and telemetry are joined on every exit. Candidate image cleanup runs after
container removal and deletes only recorded, still-owned tags; shared `:local`
images are retained.

## Not covered

This profile verifies reconnect and history restoration, not recovery after a
killed process or browser rendering. Multimodal input and Session cost have
their own scenarios in [acp-multimodal](../acp-multimodal/README.md) and
[acp-cost](../acp-cost/README.md).
