package orchestration

import (
	"context"
	"sync"
	"testing"
	"time"

	"github.com/stretchr/testify/require"
	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/codes"
	sdktrace "go.opentelemetry.io/otel/sdk/trace"
	"go.opentelemetry.io/otel/sdk/trace/tracetest"
	"go.opentelemetry.io/otel/trace"
	"go.opentelemetry.io/otel/trace/noop"
	temporalotel "go.temporal.io/sdk/contrib/opentelemetry"
	"go.temporal.io/sdk/interceptor"
)

func traceFixture(t *testing.T) (*workflowSpans, trace.Tracer, *tracetest.SpanRecorder) {
	t.Helper()
	recorder := tracetest.NewSpanRecorder()
	provider := sdktrace.NewTracerProvider(sdktrace.WithSpanProcessor(recorder))
	t.Cleanup(func() { require.NoError(t, provider.Shutdown(context.Background())) })
	return newWorkflowSpans(), provider.Tracer("temporal-sdk-go"), recorder
}

func spanEndReason(s sdktrace.ReadOnlySpan) string {
	for _, a := range s.Attributes() {
		if a.Key == "antnest.temporal.workflow.span_end" {
			return a.Value.AsString()
		}
	}
	return ""
}

func TestWorkflowShutdownEndsOriginalParentWithoutChangingSDKIdentity(t *testing.T) {
	spans, tracer, recorder := traceFixture(t)
	ctx, caller := tracer.Start(t.Context(), "caller")
	start := time.Now().Add(-time.Minute)
	parent := spans.start(ctx, tracer, "RunWorkflow:LifecycleWorkflow", trace.WithTimestamp(start), trace.WithAttributes(attribute.String("temporalWorkflowID", "workflow")))
	_, child := tracer.Start(trace.ContextWithSpan(ctx, parent), "StartActivity:lifecycle.drain")
	child.End()
	id := parent.SpanContext()
	spans.shutdown()
	spans.shutdown()
	parent.End()
	caller.End()
	require.Len(t, recorder.Ended(), 3)
	ended := recorder.Ended()[1]
	require.Equal(t, id, ended.SpanContext())
	require.Equal(t, caller.SpanContext().SpanID(), ended.Parent().SpanID())
	require.Equal(t, id.SpanID(), recorder.Ended()[0].Parent().SpanID())
	require.Equal(t, start, ended.StartTime())
	require.Equal(t, "worker_shutdown", spanEndReason(ended))
	require.Equal(t, codes.Unset, ended.Status().Code)
	require.Empty(t, spans.active)
}

func TestWorkflowNormalEndPreservesErrorAndDoesNotEndActivities(t *testing.T) {
	spans, tracer, recorder := traceFixture(t)
	workflow := spans.start(t.Context(), tracer, "RunWorkflow:CreateAgentWorkflow")
	activity := spans.start(t.Context(), tracer, "RunActivity:publish")
	workflow.SetStatus(codes.Error, "actual workflow failure")
	finish := time.Now()
	workflow.End(trace.WithTimestamp(finish))
	require.Empty(t, spans.active)
	spans.shutdown()
	require.True(t, activity.IsRecording())
	require.Len(t, recorder.Ended(), 1)
	require.Equal(t, finish, recorder.Ended()[0].EndTime())
	require.Equal(t, "workflow_return", spanEndReason(recorder.Ended()[0]))
	require.Equal(t, codes.Error, recorder.Ended()[0].Status().Code)
	activity.End()
	require.Empty(t, spanEndReason(recorder.Ended()[1]))
}

func TestWorkflowTrackerDoesNotRetainDisabledOrLateSpans(t *testing.T) {
	spans, tracer, recorder := traceFixture(t)
	spans.start(t.Context(), noop.NewTracerProvider().Tracer("disabled"), "RunWorkflow:LifecycleWorkflow")
	require.Empty(t, spans.active)
	spans.shutdown()
	late := spans.start(t.Context(), tracer, "RunWorkflow:LifecycleWorkflow")
	require.False(t, late.IsRecording())
	require.Empty(t, spans.active)
	require.Equal(t, "worker_shutdown", spanEndReason(recorder.Ended()[0]))
}

func TestWorkflowEndRacingShutdownExportsEachActualSpanOnce(t *testing.T) {
	spans, tracer, recorder := traceFixture(t)
	var tasks sync.WaitGroup
	for range 100 {
		tasks.Go(func() {
			span := spans.start(context.Background(), tracer, "RunWorkflow:LifecycleWorkflow")
			span.End()
		})
	}
	tasks.Go(spans.shutdown)
	tasks.Wait()
	require.Empty(t, spans.active)
	require.Len(t, recorder.Ended(), 100)
	ids := map[trace.SpanID]bool{}
	for _, span := range recorder.Ended() {
		require.False(t, ids[span.SpanContext().SpanID()])
		ids[span.SpanContext().SpanID()] = true
		require.Contains(t, []string{"workflow_return", "worker_shutdown"}, spanEndReason(span))
	}
}

type blockedEndProcessor struct {
	sdktrace.SpanProcessor
	entered chan struct{}
	release chan struct{}
}

func (processor *blockedEndProcessor) OnEnd(span sdktrace.ReadOnlySpan) {
	close(processor.entered)
	<-processor.release
	processor.SpanProcessor.OnEnd(span)
}

func TestWorkflowShutdownWaitsForConcurrentEndBeforeProviderShutdown(t *testing.T) {
	processor := &blockedEndProcessor{SpanProcessor: tracetest.NewSpanRecorder(), entered: make(chan struct{}), release: make(chan struct{})}
	provider := sdktrace.NewTracerProvider(sdktrace.WithSpanProcessor(processor))
	defer func() { require.NoError(t, provider.Shutdown(context.Background())) }()
	spans := newWorkflowSpans()
	span := spans.start(t.Context(), provider.Tracer("test"), "RunWorkflow:LifecycleWorkflow")
	ended, stopped := make(chan struct{}), make(chan struct{})
	go func() { span.End(); close(ended) }()
	<-processor.entered
	go func() { spans.shutdown(); close(stopped) }()
	early := false
	select {
	case <-stopped:
		early = true
	case <-time.After(30 * time.Millisecond):
	}
	close(processor.release)
	<-ended
	<-stopped
	require.False(t, early, "provider could shut down before the pending SDK End reached its processor")
}

func TestOfficialTemporalInterceptorRetainsMarshalledParentAtShutdown(t *testing.T) {
	spans, tracer, recorder := traceFixture(t)
	sdk, err := temporalotel.NewTracer(temporalotel.TracerOptions{Tracer: tracer, SpanStarter: spans.start})
	require.NoError(t, err)
	workflow, err := sdk.StartSpan(&interceptor.TracerStartSpanOptions{Operation: "RunWorkflow", Name: "LifecycleWorkflow", Tags: map[string]string{"temporalWorkflowID": "wf", "temporalRunID": "run"}})
	require.NoError(t, err)
	header, err := sdk.MarshalSpan(workflow)
	require.NoError(t, err)
	parent, err := sdk.UnmarshalSpan(header)
	require.NoError(t, err)
	activity, err := sdk.StartSpan(&interceptor.TracerStartSpanOptions{Operation: "RunActivity", Name: "lifecycle.drain", Parent: parent, FromHeader: true})
	require.NoError(t, err)
	activity.Finish(&interceptor.TracerFinishSpanOptions{})
	spans.shutdown()
	workflow.Finish(&interceptor.TracerFinishSpanOptions{})
	require.Len(t, recorder.Ended(), 2)
	require.Equal(t, recorder.Ended()[1].SpanContext().SpanID(), recorder.Ended()[0].Parent().SpanID())
	require.Equal(t, "worker_shutdown", spanEndReason(recorder.Ended()[1]))
}
