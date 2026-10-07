# ACP multimodal input E2E

This scenario verifies native multimodal prompt input (images, audio, PDF,
embedded text and links) through the deployed ACP service on a disposable full
stack. It validates platform delivery and recovery, not a real model's
recognition quality.

## Running

```sh
npm --prefix services/agent-acp-service ci
make docker-build-stage3
make test-multimodal-fixtures
make e2e-multimodal
```

`make test-multimodal-fixtures` runs the model and Trace mutation tests without
Docker. The E2E driver owns a disposable Compose project, separate service
databases, the model fixture, clients and Runtime resources. The profile
ignores the local `.env`, removes the fixed Temporal host port, separates
dynamic Docker ranges from fixed addresses and disables RPC payload capture. No
existing development resources or real Provider credentials are used.

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
   HTTP requests use the Gateway response Trace ID. Run Traces require
   PostgreSQL terminal persistence, model HTTP correlation, fresh Runtime
   information and catalog reads, and no Tool execution. Replay, configuration
   and denial Traces must not execute Runs or contact model or Runtime services.

Across the three transports there are exactly nine successful Provider requests
and three locally failed Runs. The declared request Traces cover 12 executions,
18 successful setup, configuration and replay requests, and 18 rejected
requests. Native capability failures permit only the matching model, Run and
request diagnostics; unrelated errors fail. Credentials, Session cookies and
attachment sentinels must be absent from telemetry, and raw RPC payload capture
is forbidden.

## Results

The driver reports business, topology and privacy results separately from strict
Trace timing. Timing warnings or a negative model-to-closure timestamp gap keep
a nonzero exit, and the raw timing evidence is recorded. Only the reviewed
clock-skew warning (`clock skew adjustment disabled; not applying calculated
delta of ...`) is reported without failing the exit. Mutation tests reject
changed bytes, missing history, detached spans, missing terminal writes, extra
Provider calls, unrelated errors and unexpected Tools. The optional local HTTP
reference test uses only a loopback temporary port and closes all sockets when
done.

## Cleanup

Cleanup checks both the Compose and Runtime scopes. The shared
`withAgentCleanup` helper keeps its time limits, attempts every created Agent and
reports each failed Agent independently.
