package telemetry

import (
	"context"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"testing"

	"go.opentelemetry.io/otel"
	sdktrace "go.opentelemetry.io/otel/sdk/trace"
	"go.opentelemetry.io/otel/sdk/trace/tracetest"
)

func TestHTTPHandlerCreatesServerSpanAndReturnsTraceID(t *testing.T) {
	recorder := tracetest.NewSpanRecorder()
	provider := sdktrace.NewTracerProvider(sdktrace.WithSpanProcessor(recorder))
	previous := otel.GetTracerProvider()
	otel.SetTracerProvider(provider)
	t.Cleanup(func() {
		_ = provider.Shutdown(context.Background())
		otel.SetTracerProvider(previous)
	})

	handler := HTTPHandler(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		request.SetPathValue("resource", "agents")
		response.WriteHeader(http.StatusAccepted)
	}), slog.New(slog.NewTextHandler(io.Discard, nil)))
	request := httptest.NewRequest(http.MethodPost, "/api/admin/agents", nil)
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)

	if response.Header().Get("X-Antnest-Trace-ID") == "" {
		t.Fatal("trace ID response header is missing")
	}
	spans := recorder.Ended()
	if len(spans) != 1 || spans[0].SpanKind() != 2 || spans[0].Status().Code != 0 {
		t.Fatalf("spans=%#v", spans)
	}
}
