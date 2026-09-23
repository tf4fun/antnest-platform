package postgres

import (
	"context"
	"testing"

	"go.opentelemetry.io/otel"
	sdktrace "go.opentelemetry.io/otel/sdk/trace"
	"go.opentelemetry.io/otel/sdk/trace/tracetest"
)

const integrationSpecDigest = "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"

func recordDatabaseSpans(t *testing.T) *tracetest.SpanRecorder {
	t.Helper()
	recorder := tracetest.NewSpanRecorder()
	provider := sdktrace.NewTracerProvider(sdktrace.WithSpanProcessor(recorder))
	original := otel.GetTracerProvider()
	otel.SetTracerProvider(provider)
	t.Cleanup(func() {
		otel.SetTracerProvider(original)
		if err := provider.Shutdown(context.Background()); err != nil {
			t.Error(err)
		}
	})
	return recorder
}

func TestAdvisoryLockNamespacesAreIndependent(t *testing.T) {
	if agentMutationLockNamespace == observationLeadershipNamespace {
		t.Fatal("Agent mutation and observation leadership locks share a namespace")
	}
}
