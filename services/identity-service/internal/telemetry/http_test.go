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

func TestHTTPHandlerUsesRouteTemplateAndPropagatesTrace(t *testing.T) {
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
	logger := slog.New(slog.NewJSONHandler(&logs, nil))
	mux := http.NewServeMux()
	mux.HandleFunc("GET /users/{id}", func(response http.ResponseWriter, _ *http.Request) {
		response.WriteHeader(http.StatusNoContent)
	})
	request := httptest.NewRequest(http.MethodGet, "http://identity.test/users/user-secret", nil)
	request.Header.Set("traceparent", "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01")
	response := httptest.NewRecorder()
	HTTPHandler(mux, logger).ServeHTTP(response, request)

	ended := recorder.Ended()
	if len(ended) != 1 {
		t.Fatalf("ended spans = %d, want 1", len(ended))
	}
	span := ended[0]
	if span.Name() != "HTTP GET /users/{id}" {
		t.Fatalf("span name = %q", span.Name())
	}
	if span.SpanContext().TraceID().String() != "4bf92f3577b34da6a3ce929d0e0e4736" {
		t.Fatalf("trace ID = %s", span.SpanContext().TraceID())
	}
	if strings.Contains(logs.String(), "user-secret") || !strings.Contains(logs.String(), `"route":"/users/{id}"`) {
		t.Fatalf("request log did not preserve bounded route labels: %s", logs.String())
	}
}

func TestSetupCanRunWithTelemetryDisabled(t *testing.T) {
	t.Setenv("OTEL_SDK_DISABLED", "true")
	runtime, err := Setup(t.Context(), slog.NewTextHandler(&bytes.Buffer{}, nil), Config{ServiceVersion: "test"})
	if err != nil {
		t.Fatalf("setup disabled telemetry: %v", err)
	}
	if runtime.Logger() == nil {
		t.Fatal("disabled telemetry did not provide a logger")
	}
	if err := runtime.Shutdown(t.Context()); err != nil {
		t.Fatalf("shutdown disabled telemetry: %v", err)
	}
}

func TestHTTPHandlerSuppressesSuccessfulStatusProbeLogs(t *testing.T) {
	var logs bytes.Buffer
	mux := http.NewServeMux()
	mux.HandleFunc("GET /status", func(response http.ResponseWriter, _ *http.Request) {
		response.WriteHeader(http.StatusOK)
	})
	request := httptest.NewRequest(http.MethodGet, "http://identity.test/status", nil)
	HTTPHandler(mux, slog.New(slog.NewJSONHandler(&logs, nil))).ServeHTTP(httptest.NewRecorder(), request)
	if logs.Len() != 0 {
		t.Fatalf("successful probe produced access logs: %s", logs.String())
	}
}

func TestHTTPHandlerClosesTelemetryBeforePropagatingPanic(t *testing.T) {
	previousProvider := otel.GetTracerProvider()
	recorder := tracetest.NewSpanRecorder()
	provider := sdktrace.NewTracerProvider(sdktrace.WithSpanProcessor(recorder))
	otel.SetTracerProvider(provider)
	t.Cleanup(func() {
		_ = provider.Shutdown(context.Background())
		otel.SetTracerProvider(previousProvider)
	})

	var recovered any
	func() {
		defer func() { recovered = recover() }()
		HTTPHandler(http.HandlerFunc(func(http.ResponseWriter, *http.Request) {
			panic("handler failed")
		}), slog.New(slog.NewJSONHandler(&bytes.Buffer{}, nil))).ServeHTTP(
			httptest.NewRecorder(),
			httptest.NewRequest(http.MethodGet, "http://identity.test/panic", nil),
		)
	}()
	if recovered == nil {
		t.Fatal("middleware swallowed handler panic")
	}
	ended := recorder.Ended()
	if len(ended) != 1 || ended[0].Status().Code != codes.Error {
		t.Fatalf("panic spans = %#v", ended)
	}
}
