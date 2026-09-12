package telemetry

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/codes"
	"go.opentelemetry.io/otel/propagation"
	sdktrace "go.opentelemetry.io/otel/sdk/trace"
	"go.opentelemetry.io/otel/sdk/trace/tracetest"
	"go.opentelemetry.io/otel/trace"
)

func contractRecorder(t *testing.T) (*tracetest.SpanRecorder, *sdktrace.TracerProvider) {
	t.Helper()
	recorder := tracetest.NewSpanRecorder()
	provider := sdktrace.NewTracerProvider(sdktrace.WithSpanProcessor(recorder))
	previous := httpTracer
	httpTracer = provider.Tracer("http-contract")
	t.Cleanup(func() {
		httpTracer = previous
		if err := provider.Shutdown(context.Background()); err != nil {
			t.Error(err)
		}
	})
	return recorder, provider
}

func TestTransportInjectsClientParentAndWaitsForBody(t *testing.T) {
	recorder, provider := contractRecorder(t)
	ctx, parent := provider.Tracer("caller").Start(context.Background(), "caller")
	var received trace.SpanContext
	server := httptest.NewServer(HTTPHandler(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		received = trace.SpanContextFromContext(r.Context())
		r.Pattern = "GET /status"
		w.WriteHeader(http.StatusOK)
		_, _ = io.WriteString(w, "ready")
	})))
	defer server.Close()
	client := &http.Client{Transport: NewTransport(http.DefaultTransport, "antnest-runtime")}
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, server.URL+"/status?token=QUERY_CANARY", nil)
	if err != nil {
		t.Fatal(err)
	}
	request.Header.Set("Baggage", "secret=BAGGAGE_CANARY")
	response, err := client.Do(request)
	if err != nil {
		t.Fatal(err)
	}
	for _, span := range recorder.Ended() {
		if span.SpanKind() == trace.SpanKindClient {
			t.Fatal("CLIENT ended before body EOF/close")
		}
	}
	if _, err := io.Copy(io.Discard, response.Body); err != nil {
		t.Fatal(err)
	}
	if err := response.Body.Close(); err != nil {
		t.Fatal(err)
	}
	parent.End()
	var clientSpan, serverSpan sdktrace.ReadOnlySpan
	for _, span := range recorder.Ended() {
		if strings.Contains(fmt.Sprint(span.Attributes(), span.Events()), "CANARY") {
			t.Fatal("query or baggage leaked")
		}
		switch span.SpanKind() {
		case trace.SpanKindClient:
			clientSpan = span
		case trace.SpanKindServer:
			serverSpan = span
		}
	}
	if clientSpan == nil || serverSpan == nil || len(recorder.Ended()) != 3 {
		t.Fatal("missing or duplicate HTTP spans")
	}
	if clientSpan.Parent().SpanID() != parent.SpanContext().SpanID() ||
		serverSpan.Parent().SpanID() != clientSpan.SpanContext().SpanID() ||
		serverSpan.SpanContext().SpanID() != received.SpanID() ||
		serverSpan.SpanContext().TraceID() != parent.SpanContext().TraceID() {
		t.Fatal("HTTP parent IDs do not describe the actual send")
	}
	if serverSpan.Name() != "HTTP GET /status" {
		t.Fatalf("route name = %q", serverSpan.Name())
	}
}

func TestTransportErrorDoesNotInventResponseStatus(t *testing.T) {
	recorder, _ := contractRecorder(t)
	want := fmt.Errorf("token=ERROR_CANARY: %w", context.DeadlineExceeded)
	transport := NewTransport(contractRoundTrip(func(*http.Request) (*http.Response, error) { return nil, want }), "docker")
	response, err := transport.RoundTrip(httptest.NewRequest(http.MethodGet, "http://docker/_ping?token=QUERY_CANARY", nil))
	if response != nil || err != want {
		t.Fatal("transport error identity changed")
	}
	spans := recorder.Ended()
	if len(spans) != 1 {
		t.Fatal("transport failure missing")
	}
	if _, present := spanAttrs(spans[0])["http.response.status_code"]; present {
		t.Fatal("invented response status")
	}
	if strings.Contains(fmt.Sprint(spans[0].Events(), spans[0].Attributes()), "CANARY") {
		t.Fatal("raw error leaked")
	}
}

func TestHandlerRethrowsPanicWithoutExportingItsValue(t *testing.T) {
	recorder, _ := contractRecorder(t)
	func() {
		defer func() {
			if recover() != "PANIC_CANARY" {
				t.Fatal("panic policy changed")
			}
		}()
		HTTPHandler(http.HandlerFunc(func(http.ResponseWriter, *http.Request) { panic("PANIC_CANARY") })).ServeHTTP(httptest.NewRecorder(), httptest.NewRequest(http.MethodGet, "/status", nil))
	}()
	spans := recorder.Ended()
	if len(spans) != 1 || spans[0].Status().Code != codes.Error {
		t.Fatal("panic did not end SERVER")
	}
	if strings.Contains(fmt.Sprint(spans[0].Events()), "PANIC_CANARY") {
		t.Fatal("panic value leaked")
	}
}

func TestHealthServerPreservesRemoteParent(t *testing.T) {
	recorder, _ := contractRecorder(t)
	request := httptest.NewRequest(http.MethodGet, "/status", nil)
	request.Header.Set("traceparent", "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01")
	want := propagation.TraceContext{}.Extract(context.Background(), propagation.HeaderCarrier(request.Header))
	HTTPHandler(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		r.Pattern = "GET /status"
		w.WriteHeader(http.StatusOK)
	})).ServeHTTP(httptest.NewRecorder(), request)
	spans := recorder.Ended()
	if len(spans) != 1 || spans[0].Parent().SpanID() != trace.SpanContextFromContext(want).SpanID() {
		t.Fatal("successful health request lost the upstream SERVER layer")
	}
}

func TestTransportPreservesReadCloseAndCancellationFailures(t *testing.T) {
	for _, failure := range []error{io.ErrUnexpectedEOF, context.Canceled, context.DeadlineExceeded} {
		t.Run(failure.Error(), func(t *testing.T) {
			recorder, _ := contractRecorder(t)
			body := &contractBody{err: failure}
			transport := NewTransport(contractRoundTrip(func(*http.Request) (*http.Response, error) {
				return &http.Response{StatusCode: http.StatusOK, Header: make(http.Header), Body: body}, nil
			}), "docker")
			request := httptest.NewRequest(http.MethodGet, "http://docker/events", nil)
			response, err := transport.RoundTrip(request)
			if err != nil || body.reads != 0 {
				t.Fatal("transport eagerly consumed the body")
			}
			_, err = response.Body.Read(make([]byte, 1))
			if !errors.Is(err, failure) {
				t.Fatalf("read error changed: %v", err)
			}
			if err := response.Body.Close(); err != nil {
				t.Fatal(err)
			}
			spans := recorder.Ended()
			if body.closes != 1 || len(spans) != 1 {
				t.Fatal("body/span closed incorrectly")
			}
			if failure != context.Canceled && spans[0].Status().Code != codes.Error {
				t.Fatal("read failure lost")
			}
			if spanAttrs(spans[0])["http.response.status_code"].AsInt64() != 200 {
				t.Fatal("wire status overwritten")
			}
		})
	}
}

func TestHTTPDoesNotRecordHeaderValuesOrContents(t *testing.T) {
	t.Setenv("ANTNEST_TELEMETRY_CAPTURE_RPC_CONTENT", "true")
	recorder, _ := contractRecorder(t)
	handler := HTTPHandler(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		ObserveRequest(r.Context(), map[string]string{"secret": "CANARY"})
		ObserveResponse(w, map[string]string{"secret": "CANARY"})
		w.Header().Set("Content-Type", "application/json")
		w.Header().Set("Set-Cookie", "HEADER_CANARY")
		if _, err := io.WriteString(w, `{"secret":"CANARY"}`); err != nil {
			t.Fatal(err)
		}
	}))
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, httptest.NewRequest(http.MethodGet, "/status", nil))
	span := recorder.Ended()[0]
	if response.Body.String() != `{"secret":"CANARY"}` || len(span.Events()) != 0 {
		t.Fatal("HTTP wire changed or body captured")
	}
	for _, attr := range span.Attributes() {
		if strings.Contains(attr.Value.String(), "CANARY") || strings.Contains(string(attr.Key), ".header.") {
			t.Fatal("HTTP header captured")
		}
	}
}

func spanAttrs(span sdktrace.ReadOnlySpan) map[attribute.Key]attribute.Value {
	result := make(map[attribute.Key]attribute.Value)
	for _, item := range span.Attributes() {
		result[item.Key] = item.Value
	}
	return result
}

type contractRoundTrip func(*http.Request) (*http.Response, error)

func (f contractRoundTrip) RoundTrip(r *http.Request) (*http.Response, error) { return f(r) }

type contractBody struct {
	err           error
	reads, closes int
}

func (b *contractBody) Read([]byte) (int, error) { b.reads++; return 0, b.err }
func (b *contractBody) Close() error             { b.closes++; return nil }
