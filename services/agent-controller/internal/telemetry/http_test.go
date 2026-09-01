package telemetry

import (
	"bytes"
	"context"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/codes"
	"go.opentelemetry.io/otel/propagation"
	sdktrace "go.opentelemetry.io/otel/sdk/trace"
	"go.opentelemetry.io/otel/sdk/trace/tracetest"
)

func TestHTTPHandlerPropagatesTraceWithoutLoggingResourceIdentity(t *testing.T) {
	previousProvider := otel.GetTracerProvider()
	previousPropagator := otel.GetTextMapPropagator()
	recorder := tracetest.NewSpanRecorder()
	provider := sdktrace.NewTracerProvider(sdktrace.WithSpanProcessor(recorder))
	otel.SetTracerProvider(provider)
	otel.SetTextMapPropagator(propagation.TraceContext{})
	t.Cleanup(func() {
		_ = provider.Shutdown(context.Background())
		otel.SetTracerProvider(previousProvider)
		otel.SetTextMapPropagator(previousPropagator)
	})

	var logs bytes.Buffer
	mux := http.NewServeMux()
	mux.HandleFunc("GET /internal/model-profiles/{id}", func(response http.ResponseWriter, _ *http.Request) {
		response.WriteHeader(http.StatusNoContent)
	})
	request := httptest.NewRequest(http.MethodGet, "http://controller.test/internal/model-profiles/secret-id", nil)
	request.Header.Set("traceparent", "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01")
	HTTPHandler(mux, slog.New(slog.NewJSONHandler(&logs, nil))).ServeHTTP(httptest.NewRecorder(), request)

	ended := recorder.Ended()
	if len(ended) != 1 || ended[0].Name() != "HTTP GET /internal/model-profiles/{id}" {
		t.Fatalf("HTTP spans = %#v", ended)
	}
	if ended[0].SpanContext().TraceID().String() != "4bf92f3577b34da6a3ce929d0e0e4736" {
		t.Fatalf("trace ID = %s", ended[0].SpanContext().TraceID())
	}
	if strings.Contains(logs.String(), "secret-id") || !strings.Contains(logs.String(), `"route":"/internal/model-profiles/{id}"`) {
		t.Fatalf("access log contains an unbounded resource identity: %s", logs.String())
	}
}

func TestSetupRunsWithTelemetryDisabled(t *testing.T) {
	previousPropagator := otel.GetTextMapPropagator()
	t.Cleanup(func() { otel.SetTextMapPropagator(previousPropagator) })
	t.Setenv("OTEL_SDK_DISABLED", "true")
	runtime, err := Setup(t.Context(), slog.NewTextHandler(&bytes.Buffer{}, nil), Config{ServiceVersion: "test"})
	if err != nil {
		t.Fatalf("setup disabled telemetry: %v", err)
	}
	if runtime.Logger() == nil {
		t.Fatal("disabled telemetry did not provide a logger")
	}
	for _, field := range otel.GetTextMapPropagator().Fields() {
		if field == "baggage" {
			t.Fatal("agent-controller propagates untrusted baggage to internal dependencies")
		}
	}
	if err := runtime.Shutdown(t.Context()); err != nil {
		t.Fatalf("shutdown disabled telemetry: %v", err)
	}
}

func TestSetupAcceptsOTLPHTTPConfiguration(t *testing.T) {
	t.Setenv("OTEL_SDK_DISABLED", "false")
	t.Setenv("OTEL_TRACES_EXPORTER", "otlp")
	t.Setenv("OTEL_METRICS_EXPORTER", "none")
	t.Setenv("OTEL_LOGS_EXPORTER", "none")
	t.Setenv("OTEL_EXPORTER_OTLP_ENDPOINT", "http://127.0.0.1:4318")
	t.Setenv("OTEL_EXPORTER_OTLP_PROTOCOL", "http/protobuf")
	runtime, err := Setup(t.Context(), slog.NewTextHandler(&bytes.Buffer{}, nil), Config{ServiceVersion: "test"})
	if err != nil {
		t.Fatalf("setup OTLP HTTP telemetry: %v", err)
	}
	if err := runtime.Shutdown(t.Context()); err != nil {
		t.Fatalf("shutdown OTLP HTTP telemetry: %v", err)
	}
}

func TestHTTPHandlerDoesNotTraceSuccessfulStatusProbe(t *testing.T) {
	previousProvider := otel.GetTracerProvider()
	recorder := tracetest.NewSpanRecorder()
	provider := sdktrace.NewTracerProvider(sdktrace.WithSpanProcessor(recorder))
	otel.SetTracerProvider(provider)
	t.Cleanup(func() {
		_ = provider.Shutdown(context.Background())
		otel.SetTracerProvider(previousProvider)
	})

	mux := http.NewServeMux()
	mux.HandleFunc("GET /status", func(response http.ResponseWriter, _ *http.Request) {
		response.WriteHeader(http.StatusOK)
	})
	mux.HandleFunc("GET /rpc/agent-controller/status", func(response http.ResponseWriter, _ *http.Request) {
		response.WriteHeader(http.StatusOK)
	})
	instrumented := HTTPHandler(mux, slog.New(slog.NewTextHandler(&bytes.Buffer{}, nil)))
	for _, path := range []string{"/status", "/rpc/agent-controller/status"} {
		instrumented.ServeHTTP(
			httptest.NewRecorder(), httptest.NewRequest(http.MethodGet, "http://controller.test"+path, nil),
		)
	}
	if ended := recorder.Ended(); len(ended) != 0 {
		t.Fatalf("status probe emitted traces: %#v", ended)
	}
}

func TestStatusWriterRecordsFirstCommittedStatus(t *testing.T) {
	t.Parallel()

	recorder := httptest.NewRecorder()
	writer := &statusWriter{ResponseWriter: recorder, status: http.StatusOK}
	writer.WriteHeader(http.StatusServiceUnavailable)
	writer.WriteHeader(http.StatusOK)
	if writer.status != http.StatusServiceUnavailable || recorder.Code != http.StatusServiceUnavailable {
		t.Fatalf("status writer = %d recorder=%d", writer.status, recorder.Code)
	}

	recorder = httptest.NewRecorder()
	writer = &statusWriter{ResponseWriter: recorder, status: http.StatusOK}
	if _, err := writer.Write([]byte("ready")); err != nil {
		t.Fatalf("write response: %v", err)
	}
	writer.WriteHeader(http.StatusServiceUnavailable)
	if writer.status != http.StatusOK || recorder.Code != http.StatusOK {
		t.Fatalf("implicit status writer = %d recorder=%d", writer.status, recorder.Code)
	}
}

func TestHTTPHandlerTracesFailedStatusProbe(t *testing.T) {
	previousProvider := otel.GetTracerProvider()
	recorder := tracetest.NewSpanRecorder()
	provider := sdktrace.NewTracerProvider(sdktrace.WithSpanProcessor(recorder))
	otel.SetTracerProvider(provider)
	t.Cleanup(func() {
		_ = provider.Shutdown(context.Background())
		otel.SetTracerProvider(previousProvider)
	})

	var logs bytes.Buffer
	mux := http.NewServeMux()
	mux.HandleFunc("GET /status", func(response http.ResponseWriter, _ *http.Request) {
		response.WriteHeader(http.StatusServiceUnavailable)
	})
	mux.HandleFunc("GET /rpc/agent-controller/status", func(response http.ResponseWriter, _ *http.Request) {
		response.WriteHeader(http.StatusServiceUnavailable)
	})
	instrumented := HTTPHandler(mux, slog.New(slog.NewJSONHandler(&logs, nil)))
	for _, path := range []string{"/status", "/rpc/agent-controller/status"} {
		instrumented.ServeHTTP(
			httptest.NewRecorder(), httptest.NewRequest(http.MethodGet, "http://controller.test"+path, nil),
		)
	}
	ended := recorder.Ended()
	if len(ended) != 2 {
		t.Fatalf("failed status spans = %#v", ended)
	}
	names := map[string]bool{}
	for _, span := range ended {
		names[span.Name()] = span.Status().Code == codes.Error
	}
	if !names["HTTP GET /status"] || !names["HTTP GET /rpc/agent-controller/status"] {
		t.Fatalf("failed status span names = %#v", names)
	}
	if !strings.Contains(logs.String(), `"route":"/status"`) ||
		!strings.Contains(logs.String(), `"route":"/rpc/agent-controller/status"`) ||
		!strings.Contains(logs.String(), `"result":"error"`) {
		t.Fatalf("failed status log = %s", logs.String())
	}
}
