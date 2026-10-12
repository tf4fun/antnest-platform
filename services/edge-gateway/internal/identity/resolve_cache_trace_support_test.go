package identity

import (
	"context"
	"encoding/json"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/tf4fun/antnest-platform/services/edge-gateway/internal/telemetry"
	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/propagation"
	sdktrace "go.opentelemetry.io/otel/sdk/trace"
	"go.opentelemetry.io/otel/sdk/trace/tracetest"
	"go.opentelemetry.io/otel/trace"
)

func recordCacheTraces(t *testing.T, processors ...sdktrace.SpanProcessor) *tracetest.SpanRecorder {
	t.Helper()
	recorder := tracetest.NewSpanRecorder()
	options := []sdktrace.TracerProviderOption{sdktrace.WithSpanProcessor(recorder)}
	for _, processor := range processors {
		options = append(options, sdktrace.WithSpanProcessor(processor))
	}
	provider := sdktrace.NewTracerProvider(options...)
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

func cacheTraceClient(t *testing.T, ttl time.Duration, reply roundTripFunc) *Client {
	t.Helper()
	transport := telemetry.NewHTTPTransport(roundTripFunc(func(request *http.Request) (*http.Response, error) {
		parent := otel.GetTextMapPropagator().Extract(request.Context(), propagation.HeaderCarrier(request.Header))
		ctx, server := otel.Tracer("identity-fixture").Start(parent, "Identity Resolve", trace.WithSpanKind(trace.SpanKindServer))
		defer server.End()
		return reply(request.WithContext(ctx))
	}))
	client, err := NewCachedClient(context.Background(), "http://identity.internal", &http.Client{Transport: transport}, ResolveCacheConfig{TTL: ttl, Size: 100, RequestTimeout: 10 * time.Second})
	if err != nil {
		t.Fatal(err)
	}
	return client
}

func cacheDecisionFor(t *testing.T, recorder *tracetest.SpanRecorder, parent trace.SpanContext) sdktrace.ReadOnlySpan {
	t.Helper()
	var found sdktrace.ReadOnlySpan
	for _, span := range recorder.Ended() {
		if span.Name() == "gateway.identity.resolve" && span.Parent().SpanID() == parent.SpanID() && span.SpanContext().TraceID() == parent.TraceID() {
			if found != nil {
				t.Fatal("one Resolve invocation emitted multiple decision markers")
			}
			found = span
		}
	}
	if found == nil {
		t.Fatal("request has no ended resolution decision under its own root")
	}
	return found
}

func cacheTraceAttribute(span sdktrace.ReadOnlySpan, suffix string) any {
	for _, value := range span.Attributes() {
		if string(value.Key) == "antnest.identity.resolve."+suffix {
			return value.Value.AsInterface()
		}
	}
	return nil
}

func cacheClientSpans(recorder *tracetest.SpanRecorder) []sdktrace.ReadOnlySpan {
	var clients []sdktrace.ReadOnlySpan
	for _, span := range recorder.Ended() {
		if span.SpanKind() == trace.SpanKindClient {
			clients = append(clients, span)
		}
	}
	return clients
}

func assertCacheTraceLink(t *testing.T, marker sdktrace.ReadOnlySpan, target trace.SpanContext) {
	t.Helper()
	links := marker.Links()
	if len(links) != 1 || !links[0].SpanContext.Equal(target) {
		t.Fatalf("decision did not link the exact actual source: links=%v", links)
	}
}

func assertCacheTracePrivacy(t *testing.T, recorder *tracetest.SpanRecorder, secrets ...string) {
	t.Helper()
	for _, span := range recorder.Ended() {
		encoded, err := json.Marshal([]any{span.Name(), span.Attributes(), span.Events(), span.Status()})
		if err != nil {
			t.Fatal(err)
		}
		for _, secret := range secrets {
			if strings.Contains(string(encoded), secret) {
				t.Fatal("private cache authority leaked into diagnostics")
			}
		}
	}
}
