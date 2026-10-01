# Workflow span lifetime across worker shutdown

This is an Agent Controller instrumentation contract. Temporal continues to own
workflow history, replay, Activity retry and context propagation. The official
OpenTelemetry interceptor creates all SDK spans; no business operation, parent
ID, timestamp or outcome is reconstructed.

`RunWorkflow:*` spans describe execution observed by one worker process. An
unfinished workflow can survive that worker. The SDK defers finishing its span
until the workflow returns, so normal worker shutdown can otherwise leave an
unexportable parent of already exported Activity scheduling spans.

The SDK `SpanStarter` hook tracks recording Workflow spans only. Normal SDK End
removes a span from that set and adds
`antnest.temporal.workflow.span_end=workflow_return`; existing error status and
SDK finish timestamps stay unchanged. After worker Stop and client Close, the
connection closes its remaining actual spans once with
`antnest.temporal.workflow.span_end=worker_shutdown`. This tag describes local
span lifetime, not a successful or failed durable workflow outcome. Provider
shutdown then exports ended spans through the existing exporter configuration.

Original Span IDs, parent IDs, SDK names, Workflow/Run IDs, start timestamps and
errors are preserved. A replacement worker may create another Workflow span for
the same Workflow/Run identity; it does not replace or reparent earlier spans.
Activities and other SDK spans retain their SDK lifetime. Disabled/nonrecording
spans are not retained. Concurrent End/shutdown is idempotent, completed spans
are removed immediately, and a closed tracker cannot accumulate new spans.

Verification covers unit/race tests, the actual SDK propagation contract,
Temporal worker replacement and Controller PostgreSQL/component tests. A trace
consumer validating this contract should expect both real Workflow spans for a
replaced worker and the drain attempts, and should preserve cancellation errors
and strict timing failures. This contract makes no guarantee for processes
killed with SIGKILL and does not tune exporters or clocks.
