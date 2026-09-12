package telemetry

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/codes"
	"go.opentelemetry.io/otel/propagation"
	sdktrace "go.opentelemetry.io/otel/sdk/trace"
	"go.opentelemetry.io/otel/sdk/trace/tracetest"
	"go.opentelemetry.io/otel/trace"
)

func boundaryRecorder(t *testing.T) *tracetest.SpanRecorder {
	t.Helper()
	recorder := tracetest.NewSpanRecorder()
	provider := sdktrace.NewTracerProvider(sdktrace.WithSpanProcessor(recorder))
	previous, propagator := otel.GetTracerProvider(), otel.GetTextMapPropagator()
	otel.SetTracerProvider(provider)
	otel.SetTextMapPropagator(propagation.TraceContext{})
	t.Cleanup(func() {
		_ = provider.Shutdown(context.Background())
		otel.SetTracerProvider(previous)
		otel.SetTextMapPropagator(propagator)
	})
	return recorder
}

func TestHTTPStatusRetainsExactRemoteParentAndNormalizedRoute(t *testing.T) {
	recorder := boundaryRecorder(t)
	ctx, root := otel.Tracer("test").Start(context.Background(), "edge")
	request := httptest.NewRequest(http.MethodGet, "/status?code=query-canary", nil)
	propagation.TraceContext{}.Inject(ctx, propagation.HeaderCarrier(request.Header))
	request.Header.Set("Baggage", "secret=baggage-canary")
	request.Header.Set("Cookie", "session=cookie-canary")
	mux := http.NewServeMux()
	mux.HandleFunc("GET /status", func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(http.StatusOK) })
	HTTPHandler(mux, slog.New(slog.NewTextHandler(io.Discard, nil))).ServeHTTP(httptest.NewRecorder(), request)
	spans := recorder.Ended()
	if len(spans) != 1 || spans[0].Name() != "HTTP GET /status" || spans[0].Parent().SpanID() != root.SpanContext().SpanID() || spans[0].SpanKind() != trace.SpanKindServer {
		t.Fatalf("unexpected status chain: %v", spans)
	}
	assertNoTraceCanary(t, spans, "query-canary", "cookie-canary", "baggage-canary")
	root.End()
}

func TestReturnedHandlerFailureIsAutomaticallyObservedWithoutRawCause(t *testing.T) {
	recorder := boundaryRecorder(t)
	cause := fmt.Errorf("provider-secret-canary: %w", io.ErrUnexpectedEOF)
	var returned error
	h := Handler(func(w http.ResponseWriter, _ *http.Request) error {
		w.WriteHeader(http.StatusBadGateway)
		returned = fmt.Errorf("adapter: %w", cause)
		return returned
	})
	HTTPHandler(h, slog.New(slog.NewTextHandler(io.Discard, nil))).ServeHTTP(httptest.NewRecorder(), httptest.NewRequest(http.MethodGet, "/", nil))
	if !errors.Is(returned, io.ErrUnexpectedEOF) {
		t.Fatal("original cause lost")
	}
	spans := recorder.Ended()
	if len(spans) != 1 || spans[0].Status().Code != codes.Error || spanAttribute(spans[0], "error.type") != "unexpected_eof" {
		t.Fatalf("failure not automatically observed: %v", spans)
	}
	if !strings.Contains(fmt.Sprint(spans[0].Events()), "Response ended before completion") {
		t.Fatal("safe actual cause missing")
	}
	assertNoTraceCanary(t, spans, "provider-secret-canary")
}

func TestHTTPTransportEndsAtReadOrCloseAndPreservesFailures(t *testing.T) {
	for _, scenario := range []string{"eof", "close", "read_failure", "cancelled", "timeout"} {
		t.Run(scenario, func(t *testing.T) {
			recorder := boundaryRecorder(t)
			body := &boundaryBody{reader: strings.NewReader(`{"status":"ready"}`)}
			if scenario == "read_failure" {
				body.err = io.ErrUnexpectedEOF
			}
			transport := NewHTTPTransport(boundaryRoundTrip(func(r *http.Request) (*http.Response, error) {
				if scenario == "cancelled" {
					return nil, context.Canceled
				}
				if scenario == "timeout" {
					return nil, context.DeadlineExceeded
				}
				if r.Header.Get("traceparent") == "" {
					t.Error("missing CLIENT context")
				}
				return &http.Response{StatusCode: 200, Header: http.Header{"Content-Type": {"application/json"}}, Body: body}, nil
			}))
			r := httptest.NewRequest(http.MethodGet, "http://controller.internal/status?token=query-canary", nil)
			response, err := transport.RoundTrip(r)
			if scenario == "cancelled" || scenario == "timeout" {
				if err == nil || len(recorder.Ended()) != 1 {
					t.Fatalf("failure=%v spans=%d", err, len(recorder.Ended()))
				}
				if spanAttribute(recorder.Ended()[0], "http.response.status_code") != "" {
					t.Fatal("invented HTTP response")
				}
				return
			}
			if err != nil {
				t.Fatal(err)
			}
			if body.reads != 0 || len(recorder.Ended()) != 0 {
				t.Fatal("body consumed or span ended at headers")
			}
			if scenario != "close" {
				_, readErr := io.ReadAll(response.Body)
				if scenario == "read_failure" && !errors.Is(readErr, io.ErrUnexpectedEOF) {
					t.Fatalf("read error lost: %v", readErr)
				}
			}
			if err := response.Body.Close(); err != nil {
				t.Fatal(err)
			}
			if !body.closed || len(recorder.Ended()) != 1 {
				t.Fatalf("close=%v spans=%d", body.closed, len(recorder.Ended()))
			}
			if scenario == "read_failure" && recorder.Ended()[0].Status().Code != codes.Error {
				t.Fatal("read failure hidden by HTTP200")
			}
			assertNoTraceCanary(t, recorder.Ended(), "query-canary")
		})
	}
}

func TestHTTPTransportNeverCapturesBodies(t *testing.T) {
	for _, scenario := range []struct{ name, body, media string }{
		{"large_json", `{"secret":"` + strings.Repeat("x", 20000) + `"}`, "application/json"},
		{"invalid_json", `{"secret":"canary"`, "application/json"},
		{"stream", "data: canary\n\n", "text/event-stream"},
		{"binary", "canary", "application/octet-stream"},
	} {
		t.Run(scenario.name, func(t *testing.T) {
			recorder := boundaryRecorder(t)
			transport := NewHTTPTransport(boundaryRoundTrip(func(*http.Request) (*http.Response, error) {
				return &http.Response{StatusCode: 200, Header: http.Header{"Content-Type": {scenario.media}, "Set-Cookie": {"header-canary"}}, Body: io.NopCloser(strings.NewReader(scenario.body))}, nil
			}))
			response, err := transport.RoundTrip(httptest.NewRequest(http.MethodGet, "http://controller.internal/data", nil))
			if err != nil {
				t.Fatal(err)
			}
			body, err := io.ReadAll(response.Body)
			if err != nil {
				t.Fatal(err)
			}
			if err := response.Body.Close(); err != nil {
				t.Fatal(err)
			}
			if string(body) != scenario.body || len(recorder.Ended()[0].Events()) != 0 {
				t.Fatal("body changed or captured")
			}
			assertNoTraceCanary(t, recorder.Ended(), "canary", strings.Repeat("x", 512))
		})
	}
}

func TestNoPayloadEventsAndExporterDisabledKeepsPropagation(t *testing.T) {
	recorder := boundaryRecorder(t)
	transport := NewHTTPTransport(boundaryRoundTrip(func(r *http.Request) (*http.Response, error) {
		if r.Header.Get("traceparent") == "" {
			t.Error("propagation disabled")
		}
		return &http.Response{StatusCode: 200, Header: http.Header{"Content-Type": {"application/json"}}, Body: io.NopCloser(strings.NewReader(`{"status":"ready"}`))}, nil
	}))
	response, err := transport.RoundTrip(httptest.NewRequest(http.MethodGet, "http://controller.internal/status", nil))
	if err != nil {
		t.Fatal(err)
	}
	_, _ = io.Copy(io.Discard, response.Body)
	_ = response.Body.Close()
	if len(recorder.Ended()[0].Events()) != 0 {
		t.Fatal("unexpected payload event")
	}
	for _, event := range recorder.Ended()[0].Events() {
		for _, attr := range event.Attributes {
			if attr.Key == "antnest.payload.json" {
				t.Fatal("metadata leaked body")
			}
		}
	}
	t.Setenv("OTEL_SDK_DISABLED", "true")
	runtime, err := Setup(context.Background(), slog.NewTextHandler(io.Discard, nil), Config{})
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = runtime.Shutdown(context.Background()) }()
	ctx, root := otel.Tracer("test").Start(context.Background(), "disabled-root")
	request := httptest.NewRequest(http.MethodGet, "http://controller.internal/status", nil).WithContext(ctx)
	response, err = transport.RoundTrip(request)
	if err != nil {
		t.Fatal(err)
	}
	_ = response.Body.Close()
	root.End()
}

type boundaryRoundTrip func(*http.Request) (*http.Response, error)

func (f boundaryRoundTrip) RoundTrip(r *http.Request) (*http.Response, error) { return f(r) }

type boundaryBody struct {
	reader *strings.Reader
	err    error
	reads  int
	closed bool
}

func (b *boundaryBody) Read(p []byte) (int, error) {
	b.reads++
	if b.err != nil {
		return 0, b.err
	}
	return b.reader.Read(p)
}
func (b *boundaryBody) Close() error { b.closed = true; return nil }

func spanAttribute(span sdktrace.ReadOnlySpan, key string) string {
	for _, attr := range span.Attributes() {
		if attr.Key == attribute.Key(key) {
			return attr.Value.String()
		}
	}
	return ""
}

func assertNoTraceCanary(t *testing.T, spans []sdktrace.ReadOnlySpan, canaries ...string) {
	t.Helper()
	for _, span := range spans {
		text := span.Name() + fmt.Sprint(span.Attributes(), span.Events(), span.Status())
		for _, canary := range canaries {
			if strings.Contains(text, canary) {
				t.Fatalf("trace leaked %q", canary)
			}
		}
	}
}

func TestSharedErrorAttributeTypes(t *testing.T) {
	recorder := boundaryRecorder(t)
	_, span := otel.Tracer("test").Start(context.Background(), "types")
	recordFailure(span, "read_response", io.ErrUnexpectedEOF)
	span.End()
	for _, event := range recorder.Ended()[0].Events() {
		for _, attr := range event.Attributes {
			key := string(attr.Key)
			switch key {
			case "antnest.error.cause_types":
				if attr.Value.Type() != attribute.STRINGSLICE {
					t.Fatalf("expected string array: %v", attr)
				}
			case "antnest.error.causes":
				if attr.Value.Type() != attribute.STRING || !json.Valid([]byte(attr.Value.AsString())) {
					t.Fatalf("expected JSON string: %v", attr)
				}
			case "antnest.error.stage", "antnest.error.type", "antnest.error.code", "antnest.error.message", "error.type":
				if attr.Value.Type() != attribute.STRING {
					t.Fatalf("expected string: %v", attr)
				}
			}
		}
	}
}
