package telemetry

import (
	"context"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/propagation"
	"go.opentelemetry.io/otel/trace"
)

func TestOrdinaryHTTPDoesNotCaptureContent(t *testing.T) {
	t.Setenv("ANTNEST_TELEMETRY_CAPTURE_RPC_CONTENT", "true")
	recorder := recordSpans(t)
	response := httptest.NewRecorder()
	HTTPHandler(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		RequestValue(w, marshalProbe{calls: new(int)})
		ResponseValue(w, map[string]any{"secret": "BODY-CANARY"})
		w.Header().Set("Set-Cookie", "HEADER-CANARY")
		if _, err := io.Copy(w, r.Body); err != nil {
			t.Fatal(err)
		}
	}), slog.New(slog.NewTextHandler(io.Discard, nil))).ServeHTTP(response, httptest.NewRequest(http.MethodPost, "/", strings.NewReader("BODY-CANARY")))
	if response.Body.String() != "BODY-CANARY" || len(recorder.Ended()[0].Events()) != 0 {
		t.Fatal("HTTP body changed or captured")
	}
	for _, attr := range recorder.Ended()[0].Attributes() {
		if strings.HasPrefix(string(attr.Key), "http.response.header.") || strings.Contains(attr.Value.String(), "CANARY") {
			t.Fatal("HTTP header value was captured")
		}
	}
}

func TestUnknownBodyAndStreamingFlushAreNotBuffered(t *testing.T) {
	t.Setenv("ANTNEST_TELEMETRY_CAPTURE_RPC_CONTENT", "true")
	recorder := recordSpans(t)
	response := httptest.NewRecorder()
	HTTPHandler(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		for i := 0; i < 100; i++ {
			if _, err := io.WriteString(w, "data: STREAM-CANARY\n\n"); err != nil {
				t.Fatal(err)
			}
			if err := http.NewResponseController(w).Flush(); err != nil {
				t.Fatal(err)
			}
			if !response.Flushed || response.Body.Len() == 0 {
				t.Fatal("stream was buffered")
			}
		}
	}), slog.New(slog.NewTextHandler(io.Discard, nil))).ServeHTTP(response, httptest.NewRequest(http.MethodGet, "/stream?token=QUERY-CANARY", nil))
	span := recorder.Ended()[0]
	if len(span.Events()) != 0 {
		t.Fatal("opaque stream was captured")
	}
}

func TestDisabledExporterPreservesClientContextAndWire(t *testing.T) {
	t.Setenv("OTEL_SDK_DISABLED", "true")
	t.Setenv("ANTNEST_TELEMETRY_CAPTURE_RPC_CONTENT", "false")
	previous := otel.GetTracerProvider()
	propagator := otel.GetTextMapPropagator()
	runtime, err := Setup(t.Context(), slog.NewTextHandler(io.Discard, nil), Config{})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		_ = runtime.Shutdown(context.Background())
		otel.SetTracerProvider(previous)
		otel.SetTextMapPropagator(propagator)
	})
	var outbound trace.SpanContext
	transport := NewHTTPTransport(roundTripFunc(func(r *http.Request) (*http.Response, error) {
		outbound = trace.SpanContextFromContext(r.Context())
		injected := trace.SpanContextFromContext(propagation.TraceContext{}.Extract(context.Background(), propagation.HeaderCarrier(r.Header)))
		if !outbound.IsValid() || injected.SpanID() != outbound.SpanID() {
			t.Fatal("disabled exporter lost CLIENT propagation")
		}
		return &http.Response{StatusCode: 204, Header: make(http.Header), Body: http.NoBody}, nil
	}))
	ctx, parent := otel.Tracer("test").Start(t.Context(), "local")
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, "https://provider.test", nil)
	if err != nil {
		t.Fatal(err)
	}
	response, err := transport.RoundTrip(request)
	parent.End()
	if err != nil || response.StatusCode != 204 || outbound.SpanID() == parent.SpanContext().SpanID() || outbound.TraceID() != parent.SpanContext().TraceID() {
		t.Fatal("disabled tracing changed response or identity")
	}
}
