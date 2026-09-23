# Normal shutdown and stream acceptance migration

This batch owns the shutdown acceptance consumer only. Preserve the preceding
uncommitted network migration and leave production services/SDKs unchanged.

Reuse current Foundation setup, stable Provider/Model IDs, returned Template
revision, immutable Runtime image, exact lifecycle replay and twelve-service
isolation checks. Hold an administrator lifecycle-event watch, an owner ACP
execution-state watch and an initialized ACP v1 connection with one persisted
empty Session. Every stream must receive valid initial data and remain live.

Execution state is ACP-owned: agent_id, availability, access_allowed,
configuration_revision, active_session_id and unavailable_reason. No aggregate
agent_revision or Controller workspace-state watch is expected. Watch clients
must use the actual Gateway response Trace ID and must not invent unexported
parent spans. Inspect the entire raw topology, capture policy and supplied secrets.

Use ordinary SIGTERM to stop eight application services while streams are still
open. Verify remote closure and ACP 1001 without client-triggered cancellation.
Then stop Temporal before PostgreSQL; all ten stopped containers must exit zero
without OOM/daemon error or replacement. Keep Jaeger alive through final export.
Restart the same PostgreSQL, Temporal and application containers in dependency
order, with no rebuild, image pull, schema reset or database edits.

The dynamically managed Runtime must retain container/process/image/mount and
execution identity, workspace bytes and configuration. Same cookies must work;
load the same Session, compare its empty metadata/history, event journal and
initial watch state. Public audits and model status must remain empty before and
after maintenance. Trace both actual ACP requests and both watch paths; state
watch must own the real ACP RPC with no Controller execution-state dependency.
Create/Delete traces keep current Temporal, SQL and publication/settlement checks.

The first current deployment proved business shutdown/recovery but showed that
the historical Gateway-only cancellation oracle omits actual downstream stream
cancellation. The current topology oracle recognizes only the exact watch path,
HTTP 200, completed spans within the observed stop window, and matching error
classification: Gateway handler_aborted/direct-client cancelled, Console's event
watch and its direct Controller client cancelled, Controller event watch canceled
with request_failed, or ACP's execution-state watch stream_interrupted. Conflicting
error-event codes, wrong routes/services/methods, unowned clients and other errors
are rejected. This recognizes observed normal-maintenance termination; it does
not change service error classification or turn strict errors into passes.
Missing parents and capture/privacy defects fail topology. Keep warnings,
errors, spans and timestamps unchanged, collect independent traces after failures,
and distinguish business/topology from strict status. No SIGKILL, clock or export
interval tuning. Normal Delete must remove the test Agent resources, cleanup must
remove only test-owned assets, and retained development must remain unchanged.

Write negative tests first; run local stream/protocol components and Docker gates
serially. Keep other historical lifecycle consumers and old shared assets for
separate migration batches.
