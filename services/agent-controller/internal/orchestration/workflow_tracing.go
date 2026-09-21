package orchestration

import (
	"context"
	"strings"
	"sync"

	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/trace"
)

// workflowSpans owns only the lifetime of real SDK Workflow spans. The SDK can
// discard an unfinished workflow on worker shutdown without returning through
// its deferred Finish. Close those spans before the provider shuts down.
type workflowSpans struct {
	mu     sync.Mutex
	active map[*workflowSpan]struct{}
	closed bool
}

type workflowSpan struct {
	trace.Span
	owner *workflowSpans
	once  sync.Once
}

func newWorkflowSpans() *workflowSpans {
	return &workflowSpans{active: make(map[*workflowSpan]struct{})}
}

func (spans *workflowSpans) start(ctx context.Context, tracer trace.Tracer, name string, options ...trace.SpanStartOption) trace.Span {
	_, span := tracer.Start(ctx, name, options...)
	if !strings.HasPrefix(name, "RunWorkflow:") || !span.IsRecording() {
		return span
	}
	tracked := &workflowSpan{Span: span, owner: spans}
	spans.mu.Lock()
	closed := spans.closed
	if !closed {
		spans.active[tracked] = struct{}{}
	}
	spans.mu.Unlock()
	if closed {
		tracked.finish("worker_shutdown")
	}
	return tracked
}

func (span *workflowSpan) End(options ...trace.SpanEndOption) {
	span.finish("workflow_return", options...)
}

func (span *workflowSpan) finish(reason string, options ...trace.SpanEndOption) {
	span.once.Do(func() {
		span.SetAttributes(attribute.String("antnest.temporal.workflow.span_end", reason))
		span.Span.End(options...)
		// Keep in-flight End discoverable so shutdown waits for its processor
		// before the provider is allowed to shut down.
		span.owner.mu.Lock()
		delete(span.owner.active, span)
		span.owner.mu.Unlock()
	})
}

// Call only after the worker has stopped. Ending a span records local shutdown;
// it neither completes a Temporal workflow nor replaces its propagated context.
func (spans *workflowSpans) shutdown() {
	spans.mu.Lock()
	spans.closed = true
	active := make([]*workflowSpan, 0, len(spans.active))
	for span := range spans.active {
		active = append(active, span)
	}
	spans.mu.Unlock()
	for _, span := range active {
		span.finish("worker_shutdown")
	}
}
