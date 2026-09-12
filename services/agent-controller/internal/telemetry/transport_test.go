package telemetry

import (
	"context"
	"errors"
	"io"
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
	"go.opentelemetry.io/otel/trace"

	"soft/antnest-platform/services/agent-controller/internal/ports"
)

func boundaryRecorder(t *testing.T) *tracetest.SpanRecorder {
	t.Helper()
	previous, propagator := otel.GetTracerProvider(), otel.GetTextMapPropagator()
	recorder := tracetest.NewSpanRecorder()
	provider := sdktrace.NewTracerProvider(sdktrace.WithSpanProcessor(recorder))
	otel.SetTracerProvider(provider)
	otel.SetTextMapPropagator(propagation.TraceContext{})
	t.Cleanup(func() {
		otel.SetTracerProvider(previous)
		otel.SetTextMapPropagator(propagator)
		if err := provider.Shutdown(context.Background()); err != nil {
			t.Error(err)
		}
	})
	return recorder
}

func TestHTTPTransportPreciseParentsAndHealthServer(t *testing.T) {
	recorder := boundaryRecorder(t)
	mux := http.NewServeMux()
	mux.HandleFunc("GET /status", func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Baggage") != "" {
			t.Error("untrusted baggage propagated")
		}
		w.WriteHeader(http.StatusNoContent)
	})
	server := httptest.NewServer(HTTPHandler(mux, slog.New(slog.NewTextHandler(io.Discard, nil))))
	t.Cleanup(server.Close)
	ctx, parent := otel.Tracer("test").Start(t.Context(), "caller")
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, server.URL+"/status?code=secret-query", nil)
	if err != nil {
		t.Fatal(err)
	}
	request.Header.Set("Baggage", "secret=canary")
	response, err := HTTPClient(server.Client(), "receiver").Do(request)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := io.Copy(io.Discard, response.Body); err != nil {
		t.Fatal(err)
	}
	if err := response.Body.Close(); err != nil {
		t.Fatal(err)
	}
	parent.End()
	var client, receiver sdktrace.ReadOnlySpan
	for _, span := range recorder.Ended() {
		switch span.SpanKind() {
		case trace.SpanKindClient:
			if client != nil {
				t.Fatal("duplicate CLIENT")
			}
			client = span
		case trace.SpanKindServer:
			if receiver != nil {
				t.Fatal("duplicate SERVER")
			}
			receiver = span
		}
	}
	if client == nil || receiver == nil {
		t.Fatal("missing HTTP boundary")
	}
	if client.Parent().SpanID() != parent.SpanContext().SpanID() || receiver.Parent().SpanID() != client.SpanContext().SpanID() {
		t.Fatalf("parents: client=%s server=%s", client.Parent().SpanID(), receiver.Parent().SpanID())
	}
	if receiver.Name() != "HTTP GET /status" {
		t.Fatalf("name=%s", receiver.Name())
	}
}

type boundaryRoundTripper func(*http.Request) (*http.Response, error)

func (call boundaryRoundTripper) RoundTrip(r *http.Request) (*http.Response, error) { return call(r) }

type countedBody struct {
	reads, closes int
	reader        io.Reader
}

func (body *countedBody) Read(p []byte) (int, error) { body.reads++; return body.reader.Read(p) }
func (body *countedBody) Close() error               { body.closes++; return nil }

func TestHTTPTransportBodyLifetimeAndProtocolFailure(t *testing.T) {
	recorder := boundaryRecorder(t)
	body := &countedBody{reader: strings.NewReader(`{"state":"failed"}`)}
	base := boundaryRoundTripper(func(*http.Request) (*http.Response, error) {
		return &http.Response{StatusCode: 200, Header: http.Header{"Content-Type": {"application/json"}}, Body: body}, nil
	})
	ctx, call := StartHTTPCall(t.Context(), "inspect", nil)
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, "http://runtime.test/private?token=canary", nil)
	if err != nil {
		t.Fatal(err)
	}
	response, err := HTTPClient(&http.Client{Transport: base}, "runtime-controller").Do(request)
	if err != nil {
		t.Fatal(err)
	}
	if body.reads != 0 || len(recorder.Ended()) != 0 {
		t.Fatal("transport eagerly consumed or ended body")
	}
	if _, err := io.ReadAll(response.Body); err != nil {
		t.Fatal(err)
	}
	if err := response.Body.Close(); err != nil {
		t.Fatal(err)
	}
	failure := &ports.DependencyError{Service: "runtime-controller", Code: "invalid_response", Cause: errors.New("nested-secret-canary")}
	call.Finish(failure)
	ended := recorder.Ended()
	if len(ended) != 1 || ended[0].Status().Code != codes.Error || body.closes != 1 {
		t.Fatalf("ended=%d closes=%d", len(ended), body.closes)
	}
	if !errors.Is(failure, failure.Cause) {
		t.Fatal("cause lost")
	}
	for _, attr := range ended[0].Attributes() {
		if string(attr.Key) == "http.response.status_code" && attr.Value.AsInt64() != 200 {
			t.Fatal("fabricated HTTP status")
		}
		if strings.Contains(attr.Value.String(), "canary") {
			t.Fatal("secret attribute")
		}
	}
	for _, event := range ended[0].Events() {
		for _, attr := range event.Attributes {
			if strings.Contains(attr.Value.String(), "canary") {
				t.Fatal("secret event")
			}
		}
	}
}

func TestHTTPTransportFailurePreservesOriginalErrorAndNoStatus(t *testing.T) {
	recorder := boundaryRecorder(t)
	failure := errors.New("https://user:secret-canary@host/?access_token=secret-canary")
	base := boundaryRoundTripper(func(*http.Request) (*http.Response, error) { return nil, failure })
	request, err := http.NewRequestWithContext(t.Context(), http.MethodPost, "http://runtime.test/", nil)
	if err != nil {
		t.Fatal(err)
	}
	_, err = HTTPClient(&http.Client{Transport: base}, "runtime-controller").Do(request)
	if !errors.Is(err, failure) {
		t.Fatalf("cause changed: %T", err)
	}
	ended := recorder.Ended()
	if len(ended) != 1 || ended[0].Status().Code != codes.Error {
		t.Fatal("transport failure missing")
	}
	for _, attr := range ended[0].Attributes() {
		if string(attr.Key) == "http.response.status_code" {
			t.Fatal("invented status")
		}
	}
}
