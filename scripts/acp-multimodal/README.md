# F09 Deployed Native Input

Status: deployed acceptance passed on 2026-09-09. Compact final evidence is in
[protocol conformance](../../services/agent-acp-service/docs/protocol-conformance.md#multimodal-deployment-f09-2026-09-09).

Run `make test-multimodal-fixtures`, build current service images serially, then
`make e2e-multimodal`. The latter owns a disposable Compose project, one PostgreSQL
instance with separate service databases, model fixture, clients and Runtime
resources. It removes its resources on success or failure; retained development
instances are not touched. No external Provider credential is used.

## Acceptance

1. Through Gateway and Console BFF, create an administrator-managed native model,
   a text-only model, a template and two Agents. Verify capability projections.
2. Official SDK clients use v1 WebSocket, v2 WebSocket and v1 Streamable HTTP.
   Verify negotiated capabilities and validate every update against official
   schemas. Mixed text/image/WAV/PDF/embedded text/link input reaches the model
   fixture with exact binary bytes, order and reference semantics.
3. A text continuation retains native context. Reconnect, load and fork restore
   the original content without new model requests. Foreign Agent/User access
   fails without content disclosure.
4. Unsupported and oversized input fails before admission. Switching a Session
   to an authorized text-only model fails locally on historical native content,
   never calls the Provider, and releases admission. Switching back succeeds.
5. Jaeger traces start at Gateway, include Controller admission/finalization,
   durable ACP work, Runtime context preparation and correlated model requests.
   Native-only prompts must not execute Tools. No attachment body, API key or
   login credential appears in traces or fixture logs.

Model fixture checks and trace oracles have mutation tests: changed bytes,
omitted historical content, detached spans, missing finalization and unexpected
Tool execution must fail. Only compact final metrics are retained. This proves
platform delivery and recovery, not a real model's recognition quality.
