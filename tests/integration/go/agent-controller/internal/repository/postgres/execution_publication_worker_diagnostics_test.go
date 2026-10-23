package postgres

import (
	"testing"

	"github.com/stretchr/testify/require"
	sdktrace "go.opentelemetry.io/otel/sdk/trace"
	"go.opentelemetry.io/otel/sdk/trace/tracetest"
	"go.opentelemetry.io/otel/trace"
)

func TestWorkerPublicationDiagnosticsAllowMissingCollection(t *testing.T) {
	require.Nil(t, assertWorkerPublicationTrace(t, nil, trace.SpanContext{}, true))
}

func TestWorkerPublicationDiagnosticsAllowMissingBoundary(t *testing.T) {
	propagated := trace.NewSpanContext(trace.SpanContextConfig{
		TraceID: trace.TraceID{1}, SpanID: trace.SpanID{2},
	})
	http := tracetest.SpanStub{
		Name: "HTTP POST agent-acp-service", SpanContext: propagated,
		SpanKind: trace.SpanKindClient,
	}.Snapshot()
	require.Nil(t, assertWorkerPublicationTrace(t, []sdktrace.ReadOnlySpan{http}, propagated, true))
}
