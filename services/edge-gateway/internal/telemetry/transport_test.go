package telemetry

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"net/http/httputil"
	"net/url"
	"strings"
	"testing"

	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/codes"
	"go.opentelemetry.io/otel/propagation"
	sdktrace "go.opentelemetry.io/otel/sdk/trace"
	"go.opentelemetry.io/otel/sdk/trace/tracetest"
	"go.opentelemetry.io/otel/trace"
)

func TestReverseProxyHasExactlyOneClientBetweenHTTPServers(t *testing.T) {
	recorder := recordHTTPSpans(t)
	upstreamMux := http.NewServeMux()
	upstreamMux.HandleFunc("GET /", func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(http.StatusNoContent) })
	upstream := httptest.NewServer(HTTPHandler(upstreamMux, nil))
	defer upstream.Close()
	target, err := url.Parse(upstream.URL)
	if err != nil {
		t.Fatal(err)
	}
	proxy := httputil.NewSingleHostReverseProxy(target)
	proxy.Transport = NewHTTPTransport(upstream.Client().Transport)
	mux := http.NewServeMux()
	mux.Handle("GET /", proxy)
	w := httptest.NewRecorder()
	HTTPHandler(mux, nil).ServeHTTP(w, httptest.NewRequest("GET", "/", nil))
	spans := recorder.Ended()
	if w.Code != 204 || len(spans) != 3 {
		t.Fatalf("status=%d spans=%d", w.Code, len(spans))
	}
	up, client, edge := spans[0], spans[1], spans[2]
	if up.SpanKind() != trace.SpanKindServer || client.SpanKind() != trace.SpanKindClient || edge.SpanKind() != trace.SpanKindServer ||
		up.Parent().SpanID() != client.SpanContext().SpanID() || client.Parent().SpanID() != edge.SpanContext().SpanID() {
		t.Fatal("broken proxy hierarchy")
	}
}

func recordHTTPSpans(t *testing.T) *tracetest.SpanRecorder {
	t.Helper()
	recorder := tracetest.NewSpanRecorder()
	provider := sdktrace.NewTracerProvider(sdktrace.WithSpanProcessor(recorder))
	previous, propagator := otel.GetTracerProvider(), otel.GetTextMapPropagator()
	otel.SetTracerProvider(provider)
	otel.SetTextMapPropagator(propagation.TraceContext{})
	t.Cleanup(func() {
		if err := provider.Shutdown(context.Background()); err != nil {
			t.Error(err)
		}
		otel.SetTracerProvider(previous)
		otel.SetTextMapPropagator(propagator)
	})
	return recorder
}

type roundTripFunc func(*http.Request) (*http.Response, error)

func (f roundTripFunc) RoundTrip(r *http.Request) (*http.Response, error) { return f(r) }

func TestHTTPTransportOwnsClientSpanAndPropagatesItsParent(t *testing.T) {
	recorder := recordHTTPSpans(t)
	ctx, root := otel.Tracer("test").Start(context.Background(), "gateway", trace.WithSpanKind(trace.SpanKindServer))
	defer root.End()
	const secret = "private-canary"
	var received trace.SpanContext
	transport := NewHTTPTransport(roundTripFunc(func(r *http.Request) (*http.Response, error) {
		parent := otel.GetTextMapPropagator().Extract(r.Context(), propagation.HeaderCarrier(r.Header))
		received = trace.SpanContextFromContext(parent)
		_, child := otel.Tracer("upstream").Start(parent, "upstream", trace.WithSpanKind(trace.SpanKindServer))
		defer child.End()
		body, err := io.ReadAll(r.Body)
		if err != nil {
			return nil, err
		}
		if !strings.Contains(string(body), secret) || r.Header.Get("Authorization") != "Bearer "+secret {
			t.Error("diagnostics changed the actual request")
		}
		if r.Header.Get("Baggage") != "" {
			t.Error("unregistered baggage forwarded")
		}
		return &http.Response{StatusCode: 200, Header: http.Header{"Content-Type": {"application/json"}, "Set-Cookie": {secret}}, Body: io.NopCloser(strings.NewReader(`{"methods":[{"name":"company","display_name":"Company","secret":"private-canary"}]}`))}, nil
	}))
	r, err := http.NewRequestWithContext(ctx, "POST", "http://identity.internal/rpc/identity/list-login-methods?token="+secret, strings.NewReader(`{"organization_slug":"engineering","password":"private-canary","nested":{"token":"private-canary"}}`))
	if err != nil {
		t.Fatal(err)
	}
	r.Header.Set("Content-Type", "application/json")
	r.Header.Set("Authorization", "Bearer "+secret)
	r.Header.Set("Baggage", "token="+secret)
	r.Header.Set("Traceparent", "unchanged")
	response, err := transport.RoundTrip(r)
	if err != nil {
		t.Fatal(err)
	}
	if len(recorder.Ended()) != 1 {
		t.Fatal("client span ended before response body")
	}
	if _, err := io.Copy(io.Discard, response.Body); err != nil {
		t.Fatal(err)
	}
	if err := response.Body.Close(); err != nil {
		t.Fatal(err)
	}
	spans := recorder.Ended()
	if len(spans) != 2 {
		t.Fatalf("spans=%d", len(spans))
	}
	child, client := spans[0], spans[1]
	if client.SpanKind() != trace.SpanKindClient || client.Parent().SpanID() != root.SpanContext().SpanID() || child.Parent().SpanID() != client.SpanContext().SpanID() || received.SpanID() != client.SpanContext().SpanID() {
		t.Fatal("expected Gateway SERVER -> outbound CLIENT -> upstream SERVER")
	}
	if r.Header.Get("Traceparent") != "unchanged" {
		t.Fatal("mutated caller headers")
	}
	encoded, err := json.Marshal(client.Events())
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(encoded), "engineering") || strings.Contains(string(encoded), "company") {
		t.Fatal("HTTP transport captured content")
	}
	assertNoTraceValue(t, spans, secret)
}

func assertNoTraceValue(t *testing.T, spans []sdktrace.ReadOnlySpan, secret string) {
	t.Helper()
	for _, span := range spans {
		value, err := json.Marshal([]any{span.Name(), span.Attributes(), span.Events(), span.Status()})
		if err != nil {
			t.Fatal(err)
		}
		if strings.Contains(string(value), secret) {
			t.Fatal("secret leaked into diagnostics")
		}
	}
}

func TestHTTPTransportPreservesFailureAndReportsSafeCause(t *testing.T) {
	recorder := recordHTTPSpans(t)
	original := errors.Join(context.DeadlineExceeded, errors.New("private-transport-canary"))
	transport := NewHTTPTransport(roundTripFunc(func(*http.Request) (*http.Response, error) { return nil, original }))
	r := httptest.NewRequest("GET", "http://service.internal/status?token=private-transport-canary", nil)
	_, err := transport.RoundTrip(r)
	if err != original {
		t.Fatal("replaced the underlying error")
	}
	spans := recorder.Ended()
	if len(spans) != 1 || spans[0].Status().Code != codes.Error {
		t.Fatal("missing failed client span")
	}
	if !strings.Contains(spans[0].Status().Description, "deadline") {
		t.Fatal("missing useful timeout classification")
	}
	assertNoTraceValue(t, spans, "private-transport-canary")
}

func TestHTTPDiagnosticsDoNotBufferOrExposeStreams(t *testing.T) {
	recorder := recordHTTPSpans(t)
	reader, writer := io.Pipe()
	transport := NewHTTPTransport(roundTripFunc(func(*http.Request) (*http.Response, error) {
		return &http.Response{StatusCode: 200, Header: http.Header{"Content-Type": {"text/event-stream"}}, Body: reader}, nil
	}))
	response, err := transport.RoundTrip(httptest.NewRequest("GET", "http://acp.internal/v1/acp", nil))
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = writer.Close() }()
	if len(recorder.Ended()) != 0 {
		t.Fatal("stream span ended at headers")
	}
	if err := response.Body.Close(); err != nil {
		t.Fatal(err)
	}
	if len(recorder.Ended()) != 1 {
		t.Fatal("stream close did not finish span")
	}
	if _, ok := response.Body.(io.Writer); ok {
		t.Fatal("added write capability to a read-only response")
	}
}

func TestHTTPServerNormalizesRoutesWithoutCollectingBody(t *testing.T) {
	recorder := recordHTTPSpans(t)
	mux := http.NewServeMux()
	mux.HandleFunc("POST /api/session/login-methods", func(w http.ResponseWriter, r *http.Request) {
		if _, err := io.Copy(io.Discard, r.Body); err != nil {
			t.Error(err)
		}
		w.Header().Set("Content-Type", "application/json")
		w.Header().Set("Set-Cookie", "private-cookie-canary")
		_, _ = io.WriteString(w, `{"methods":[{"name":"company"}]}`)
	})
	h := HTTPHandler(mux, nil)
	r := httptest.NewRequest("POST", "/api/session/login-methods?code=private-cookie-canary", strings.NewReader(`{"organization_slug":"engineering","password":"private-cookie-canary"}`))
	r.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	h.ServeHTTP(w, r)
	spans := recorder.Ended()
	if len(spans) != 1 || spans[0].Name() != "HTTP POST /api/session/login-methods" {
		t.Fatal("route contains duplicate method")
	}
	assertNoTraceValue(t, spans, "private-cookie-canary")
	data, err := json.Marshal(spans[0].Events())
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(data), "engineering") {
		t.Fatal("ordinary HTTP captured content")
	}
	if w.Header().Get("Set-Cookie") != "private-cookie-canary" {
		t.Fatal("modified live response headers")
	}
}
