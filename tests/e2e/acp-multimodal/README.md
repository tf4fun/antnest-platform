# Deployed Native Input Acceptance

The [2026-09-22 follow-up](../../../docs/timeout-failure-followup-20260922.md)
records shared cleanup diagnostics and targeted regression. Cleanup keeps
its existing time limits and reports each failed Agent independently.

Run `make test-multimodal-fixtures`, then `make e2e-multimodal` with current local
service images. The root driver owns a disposable Compose project, separate
service databases, model fixture, clients and Runtime resources. The profile
ignores local `.env`, removes the fixed Temporal host port, separates dynamic
Docker ranges from fixed addresses and disables RPC payload capture. Cleanup
checks both Compose and Runtime scopes. Retained development resources and real
Provider credentials are not used.

## Current Contract

1. Create one Provider connection with native and text-only Models through
   Gateway/Console. Check current Model detail capability projections and the
   credential boundary. Templates reference stable Model identities; Agents use
   the returned Template revision and wait for executable Runtime readiness.
2. Official SDK clients use v1 WebSocket, v2 WebSocket and v1 Streamable HTTP.
   Verify negotiated capabilities and validate Session updates against the SDK
   schemas installed in the ACP image. Mixed text/PNG/WAV/PDF/embedded text/link
   input reaches the deterministic model with exact bytes, order and reference
   semantics. The model's reference endpoint records even an ignored fetch;
   reference fetch attempts must stay zero.
3. A text continuation retains native context. Reconnect, load/resume and fork
   restore original content without new model requests. Cross-Agent operations
   and foreign-user `session/new` fail with exact ACP authorization errors and
   no content disclosure. Successful initialization is not resource access.
4. Unsupported ZIP and oversized WAV fail before creating a Run. Selecting an
   authorized text-only Model on a Session with native history fails locally,
   makes no Provider HTTP request and durably ends the Run. Restoring the native
   Model permits a new successful prompt without losing attachment context.
5. Each JSON-RPC request has its own Trace evidence. SDK request observation
   records actual IDs; WebSocket traces link to their original connection and
   HTTP requests use the Gateway response Trace ID. Run traces require actual
   PostgreSQL terminal persistence and model HTTP correlation, fresh Runtime
   information/catalog reads and no Tool execution. Replay, configuration and
   denial traces must not execute Runs or contact model/Runtime services.

Three transports produce exactly nine successful Provider requests and three
local failed Runs. The 48 declared request traces cover 12 executions, 18
successful setup/configuration/replay requests and 18 rejected requests. Native
capability failures permit only the matching model/Run/request diagnostics;
unrelated errors fail. Credentials, session cookies and attachment sentinels
must be absent from telemetry, and raw RPC payload capture is forbidden.

The driver reports business/topology/privacy evidence separately from strict
Trace timing. Timing warnings or a negative model-to-closure timestamp gap
retain a nonzero process exit, with the raw timing evidence recorded. Model and Trace
mutation tests reject changed bytes, missing history, detached spans, missing
terminal writes, extra Provider calls, unrelated errors and unexpected Tools.
The optional local HTTP reference test uses only a loopback temporary port and
closes all sockets when done.

This validates platform delivery and recovery, not a real model's recognition
quality. Current migration results are in
[the revalidation report](../../../docs/multimodal-revalidation.md). The original
[2026-09-09 F09 record](../../../services/agent-acp-service/docs/protocol-conformance.md#multimodal-deployment-f09-2026-09-09)
remains historical evidence for its original candidate.
