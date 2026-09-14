package application

import (
	"context"
	"testing"
	"time"

	"github.com/stretchr/testify/require"
	"go.opentelemetry.io/otel"
	sdktrace "go.opentelemetry.io/otel/sdk/trace"
	"go.opentelemetry.io/otel/sdk/trace/tracetest"

	"soft/antnest-platform/services/agent-controller/internal/ports"
)

func TestIdentityRevocationWorkerUsesItsComposedTracer(t *testing.T) {
	previous := otel.GetTracerProvider()
	t.Cleanup(func() { otel.SetTracerProvider(previous) })
	const parent = "00-11111111111111111111111111111111-2222222222222222-01"
	for range 2 {
		recorder := tracetest.NewSpanRecorder()
		provider := sdktrace.NewTracerProvider(sdktrace.WithSpanProcessor(recorder))
		otel.SetTracerProvider(provider)
		t.Cleanup(func() { require.NoError(t, provider.Shutdown(context.Background())) })
		source := &revocationSourceStub{page: ports.PrincipalRevocationPage{
			Events: []ports.PrincipalRevocation{{Sequence: 1, TraceParent: parent}}, NextSequence: 1,
		}}
		store := &revocationStoreStub{pending: []ports.PendingOwnerRevocation{{AgentID: "agent-1", Sequence: 1, AggregateSequence: 1, TraceParent: parent}}}
		worker, err := NewIdentityRevocationWorker(source, store, &revocationSchedulerStub{}, time.Second, nil)
		require.NoError(t, err)
		require.NoError(t, worker.RunOnce(t.Context()))
		spans := recorder.Ended()
		require.Len(t, spans, 2, "a newly composed worker must not reuse a previous telemetry runtime")
		for _, span := range spans {
			require.Equal(t, "11111111111111111111111111111111", span.SpanContext().TraceID().String())
			require.Equal(t, "2222222222222222", span.Parent().SpanID().String())
		}
	}
}
