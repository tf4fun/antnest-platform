# ACP multimodal input E2E

This scenario verifies native multimodal prompt input (images, audio, PDF,
embedded text and links) through the deployed ACP service on a disposable full
stack. It validates platform delivery and recovery, not a real model's
recognition quality.

## Running

```sh
npm --prefix services/agent-acp-service ci
make test-multimodal-fixtures
make e2e-multimodal
```

`make test-multimodal-fixtures` runs the model and Trace mutation tests without
Docker, including real SDK peers over temporary loopback sockets. The E2E driver owns a disposable Compose project, separate service
databases, the model fixture, clients and Runtime resources. The profile
ignores the local `.env`, removes the fixed Temporal host port, separates
dynamic Docker ranges from fixed addresses and disables RPC payload capture. No
existing development resources or real Provider credentials are used.

The wrapper builds 11 candidates tagged `multimodal-<run-id>` and starts the
14-service stack with `--no-build --pull never`. Service images, the Runtime
preparer, model and client are checked against their actual candidate image IDs.
The client uses the original browser Principal and Identity-issued delegation
for private ACP calls. It mounts only the Gateway-to-Identity and Agent-UI-to-ACP
grants read-only, runs as the evidence owner, and has no Docker socket.

## Contract

1. Create one Provider connection with a native Model and a text-only Model
   through the Gateway and Admin Console. Check the Model detail capability
   projections and the credential boundary. Templates reference stable Model
   identities; Agents use the returned Template revision and wait for
   executable Runtime readiness.
2. Official SDK clients use v1 WebSocket, v2 WebSocket and v1 Streamable HTTP.
   Negotiated capabilities are verified, and Session updates are validated
   against the SDK schemas installed in the ACP image. Mixed text, PNG, WAV,
   PDF, embedded text and link input reaches the deterministic model with exact
   bytes, order and reference semantics. The model's reference endpoint records
   even an ignored fetch, and reference fetch attempts must stay at zero.
3. A text continuation keeps native context. Reconnect, load, resume and fork
   restore the original content without new model requests. Cross-Agent
   operations and a foreign user's `session/new` fail with exact ACP
   authorization errors and no content disclosure. Successful initialization
   does not grant resource access.
4. Unsupported ZIP content and an oversized WAV fail before a Run is created.
   Selecting an authorized text-only Model on a Session with native history
   fails locally, makes no Provider HTTP request and durably ends the Run.
   Restoring the native Model permits a new successful prompt without losing
   attachment context.
5. Each JSON-RPC request has its own Trace evidence. SDK request observation
   records actual IDs; WebSocket Traces link to their original connection, and
   HTTP requests bind their exported private CLIENT to the actual workspace
   HTTP receiver and RPC. Run Traces require
   PostgreSQL terminal persistence, model HTTP correlation, fresh Runtime
   information and catalog reads, and no Tool execution. Replay, configuration
   and denial Traces must not execute Runs or contact the model. Any Runtime
   catalog refresh must retain the complete initialization/read/tools/close
   lifecycle and exact diagnostics.

Across the three transports there are exactly nine successful Provider requests
and three locally failed Runs. The declared request Traces cover 12 executions,
18 successful setup, configuration and replay requests, and 18 rejected
requests. Native capability failures permit only the matching model, Run and
request diagnostics; the v1 SDK error and v2 admitted message plus unique idle
terminal are retained from the actual response. The Run's internal request ID
is recorded separately from the wire JSON-RPC ID. Twelve actual initialization
requests are inventoried separately, as are all HTTP GET and DELETE exchanges.
Credentials, Session cookies and
attachment sentinels must be absent from telemetry, and raw RPC payload capture
is forbidden.

## Results

Collection begins after every original SDK connection has closed and joined.
Complete raw HTTP query responses are saved before parsing, with byte counts
and SHA-256, and all sources must stabilize over three rounds. Primary Run and
Provider correlation cannot drop requests with a missing or foreign phase.

The driver reports business, topology and privacy results separately from raw
strict diagnostics. It exits 0 for strict success, 2 for complete business and
topology with only reviewed findings, and 1 for other failures. CI runs the
Stage 3 recipe directly to preserve exit 2 as the existing warning category.
The final completion report counts the transports that finished in `outcomes`
as `scenarios`, so the existing CI gate can recognize the complete business
report. An incomplete report, later cleanup failure or unreviewed warning
still fails that gate.
Raw errors, warnings and failed strict status remain visible. The same-Node SDK
investigation is deferred only for original endpoint differences strictly below
1 ms, with matching process identity and SDK anchors; timestamps are never
rewritten. Cross-process differences and larger gaps do not use that deferral.
Streaming response persistence is checked separately from Provider transport:
only the owning message-append SQL and Session output reads are accepted.
Output publication is asynchronous in the owning service and may finish after
the model span; those original endpoints and warnings are retained, without
claiming a synchronous join or applying the sub-millisecond deferral.
The outer private HTTP response body close is checked against its actual wire
receipt and client diagnostics. It cannot borrow a Runtime information or Tool
cleanup claim; cancellations inside those Runtime exchanges remain separately
owned and checked.
Mutation tests reject
changed bytes, missing history, detached spans, missing terminal writes, extra
Provider calls, unrelated errors and unexpected Tools. The optional local HTTP
reference test uses only a loopback temporary port and closes all sockets when
done.

Raw queries, actual model responses, request and connection inventories and
intermediate reports are private files under
`artifacts/verification/acp-multimodal/<project>/`. Sources, recovery inputs and
durable evidence must not be stored in `.cache`.

## Cleanup

Before Agent deletion, the client waits for the host to inspect both live
Runtimes and return a receipt bound to their Agent IDs, Runtime generations,
candidate image, run ID and nonce. Failed or cancelled inspection enters the
cleanup path and cannot report business success. All connections and telemetry
are joined on every exit.
The client preserves the exact consumed ACK bytes and records its consumption,
the actual Agent deletion requests, and completed operation responses on one
process clock with ordered sequence numbers. Cleanup response files retain the
complete decoded response text, status and Trace ID, without credential headers.
Evidence write failures are reported after every Agent cleanup has been attempted.

Cleanup checks both the Compose and Runtime scopes. The shared
`withAgentCleanup` helper keeps its time limits, attempts every created Agent and
reports each failed Agent independently. The wrapper preserves private client
logs on success and failure, removes project containers before owned candidate
tags, and reports cleanup failure independently of the original business result.
