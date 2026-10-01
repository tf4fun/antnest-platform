package application

import (
	"context"
	"errors"
	"fmt"
	"testing"
	"time"

	"github.com/stretchr/testify/require"
	"github.com/tf4fun/antnest-platform/services/agent-controller/internal/ports"
	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/codes"
	sdktrace "go.opentelemetry.io/otel/sdk/trace"
	"go.opentelemetry.io/otel/sdk/trace/tracetest"
	"go.opentelemetry.io/otel/trace"
)

func TestPublicationWorkerRecordsBoundedAttemptsWithComposedTracer(t *testing.T) {
	previous := otel.GetTracerProvider()
	t.Cleanup(func() { otel.SetTracerProvider(previous) })
	for range 2 {
		recorder := tracetest.NewSpanRecorder()
		provider := sdktrace.NewTracerProvider(sdktrace.WithSpanProcessor(recorder))
		otel.SetTracerProvider(provider)
		t.Cleanup(func() { require.NoError(t, provider.Shutdown(context.Background())) })
		parent := trace.NewSpanContext(trace.SpanContextConfig{TraceID: trace.TraceID{1}, SpanID: trace.SpanID{2}, TraceFlags: trace.FlagsSampled})
		ambient, ambientSpan := provider.Tracer("test").Start(t.Context(), "ambient")
		ambientSpan.End()
		failure := errors.New("PRIVATE_PROVIDER_CREDENTIAL")
		var wanted error
		var contexts []trace.SpanContext
		worker := publicationWorker(t, onePublicationOrganization(), func(ctx context.Context, org string) (ports.ExecutionAcknowledgement, error) {
			require.Equal(t, "org-1", org)
			require.True(t, trace.SpanFromContext(ctx).IsRecording(), "background publication needs a recording parent")
			deadline, ok := ctx.Deadline()
			require.True(t, ok)
			require.WithinDuration(t, time.Now().Add(publicationSchedule().RequestTimeout), deadline, time.Second)
			contexts = append(contexts, trace.SpanContextFromContext(ctx))
			return ports.ExecutionAcknowledgement{OrganizationID: org, AppliedRevision: 7}, wanted
		})
		wanted = failure
		require.ErrorIs(t, worker.publishOrganization(ambient, "org-1", parent), failure)
		wanted = nil
		require.NoError(t, worker.publishOrganization(ambient, "org-1", parent))
		require.NoError(t, worker.publishOrganization(ambient, "org-1", trace.SpanContext{}))
		require.NoError(t, worker.publishOrganization(ambient, "org-1", trace.SpanContext{}))
		cancelled, cancel := context.WithCancel(ambient)
		cancel()
		require.ErrorIs(t, worker.publishOrganization(cancelled, "org-1", parent), context.Canceled)
		spans := recorder.Ended()[1:]
		require.Len(t, spans, 4)
		require.Len(t, contexts, 4)
		for i, span := range spans {
			require.Equal(t, "agent_controller.execution_publication", span.Name())
			require.Equal(t, trace.SpanKindInternal, span.SpanKind())
			require.Equal(t, contexts[i], span.SpanContext())
			require.False(t, span.EndTime().Before(span.StartTime()))
			require.NotContains(t, fmt.Sprint(span.Attributes(), span.Events(), span.Status()), "PRIVATE_PROVIDER_CREDENTIAL")
			attrs := map[string]any{}
			for _, a := range span.Attributes() {
				attrs[string(a.Key)] = a.Value.AsInterface()
			}
			require.Equal(t, "org-1", attrs["antnest.organization.id"])
			if i == 0 {
				require.Equal(t, codes.Error, span.Status().Code)
				require.Equal(t, "execution_publication_failed", span.Status().Description)
				require.NotContains(t, attrs, "antnest.configuration.applied_revision")
			} else {
				require.Equal(t, codes.Unset, span.Status().Code)
				require.EqualValues(t, 7, attrs["antnest.configuration.applied_revision"])
			}
			if i < 2 {
				require.Equal(t, parent, span.Parent())
				require.Equal(t, parent.TraceID(), span.SpanContext().TraceID())
				require.NotEqual(t, parent.SpanID(), span.SpanContext().SpanID())
			} else {
				require.False(t, span.Parent().IsValid())
				require.NotEqual(t, parent.TraceID(), span.SpanContext().TraceID())
				require.NotEqual(t, ambientSpan.SpanContext().TraceID(), span.SpanContext().TraceID())
			}
		}
		require.NotEqual(t, spans[0].SpanContext().SpanID(), spans[1].SpanContext().SpanID())
		require.NotEqual(t, spans[2].SpanContext().TraceID(), spans[3].SpanContext().TraceID())
	}
}

func TestPublicationAttemptEndsOnDeadline(t *testing.T) {
	previous := otel.GetTracerProvider()
	recorder := tracetest.NewSpanRecorder()
	provider := sdktrace.NewTracerProvider(sdktrace.WithSpanProcessor(recorder))
	otel.SetTracerProvider(provider)
	t.Cleanup(func() { otel.SetTracerProvider(previous); require.NoError(t, provider.Shutdown(context.Background())) })
	worker := publicationWorker(t, onePublicationOrganization(), func(ctx context.Context, _ string) (ports.ExecutionAcknowledgement, error) {
		<-ctx.Done()
		return ports.ExecutionAcknowledgement{}, ctx.Err()
	})
	worker.schedule.RequestTimeout = time.Millisecond
	require.ErrorIs(t, worker.publishOrganization(t.Context(), "org-1", trace.SpanContext{}), context.DeadlineExceeded)
	spans := recorder.Ended()
	require.Len(t, spans, 1)
	require.Equal(t, codes.Error, spans[0].Status().Code)
}
