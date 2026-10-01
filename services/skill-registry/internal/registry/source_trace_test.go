package registry

import (
	"context"
	"errors"
	"io"
	"net/http"
	"strings"
	"testing"

	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/codes"
	"go.opentelemetry.io/otel/propagation"
	sdktrace "go.opentelemetry.io/otel/sdk/trace"
	"go.opentelemetry.io/otel/sdk/trace/tracetest"
	"go.opentelemetry.io/otel/trace"
)

type sourceRoundTrip func(*http.Request) (*http.Response, error)

func (f sourceRoundTrip) RoundTrip(r *http.Request) (*http.Response, error) { return f(r) }

func sourceSpans(t *testing.T) (*tracetest.SpanRecorder, context.Context, trace.Span) {
	t.Helper()
	previous := otel.GetTracerProvider()
	recorder := tracetest.NewSpanRecorder()
	provider := sdktrace.NewTracerProvider(sdktrace.WithSpanProcessor(recorder))
	otel.SetTracerProvider(provider)
	t.Cleanup(func() {
		_ = provider.Shutdown(context.Background())
		otel.SetTracerProvider(previous)
	})
	ctx, span := provider.Tracer("fixture").Start(t.Context(), "caller")
	t.Cleanup(func() { span.End() })
	return recorder, ctx, span
}

func TestSourceHTTPPropagatesActualClientSpanWithoutCapturingContent(t *testing.T) {
	recorder, ctx, caller := sourceSpans(t)
	// Preserve the production transport wrapper and replace its network boundary.
	previous := http.DefaultTransport
	http.DefaultTransport = sourceRoundTrip(func(request *http.Request) (*http.Response, error) {
		remote := trace.SpanContextFromContext(propagation.TraceContext{}.Extract(t.Context(), propagation.HeaderCarrier(request.Header)))
		if remote.TraceID() != caller.SpanContext().TraceID() || remote.SpanID() == caller.SpanContext().SpanID() || !remote.IsValid() {
			t.Fatalf("source request did not inject an actual CLIENT child: %v", remote)
		}
		if request.Header.Get("Authorization") != "Bearer "+testToken {
			t.Fatal("instrumentation changed service authentication")
		}
		if len(recorder.Ended()) != 0 {
			t.Fatal("CLIENT ended before its body was consumed")
		}
		return &http.Response{StatusCode: 200, Header: http.Header{"Content-Type": {"application/json"}}, Body: io.NopCloser(strings.NewReader(`{"items":[]}`))}, nil
	})
	t.Cleanup(func() { http.DefaultTransport = previous })
	// Construct after the replacement, as the adapter captures its own transport.
	source, err := NewHTTPAgentSource("http://source.invalid", testToken)
	if err != nil {
		t.Fatal(err)
	}
	_, err = source.Inspect(ctx, testOrg, testActor, []SourceKey{{AgentID: testAgent, Name: "private-query"}})
	if err != nil {
		t.Fatal(err)
	}
	spans := recorder.Ended()
	if len(spans) != 1 || spans[0].SpanKind() != trace.SpanKindClient || spans[0].Name() != "HTTP POST agent-acp-service" || spans[0].Parent().SpanID() != caller.SpanContext().SpanID() {
		t.Fatalf("missing native source CLIENT span: %v", spans)
	}
	for _, attr := range spans[0].Attributes() {
		value := attr.Value.String()
		if strings.Contains(value, testToken) || strings.Contains(value, "private-query") || strings.Contains(value, "items") {
			t.Fatalf("HTTP captured source content: %v", attr.Key)
		}
	}
	if len(spans[0].Events()) != 0 {
		t.Fatal("HTTP emitted content/error-text events")
	}
}

func TestSourceHTTPTransportFailureKeepsSanitizedBusinessError(t *testing.T) {
	recorder, ctx, _ := sourceSpans(t)
	previous := http.DefaultTransport
	http.DefaultTransport = sourceRoundTrip(func(*http.Request) (*http.Response, error) {
		return nil, errors.New("private upstream password and query")
	})
	t.Cleanup(func() { http.DefaultTransport = previous })
	source, err := NewHTTPAgentSource("http://source.invalid", testToken)
	if err != nil {
		t.Fatal(err)
	}
	_, err = source.Inspect(ctx, testOrg, testActor, nil)
	if Code(err) != "source_unavailable" || strings.Contains(err.Error(), "password") {
		t.Fatalf("source error changed: %v", err)
	}
	spans := recorder.Ended()
	if len(spans) != 1 || spans[0].Status().Code != codes.Error || spans[0].Status().Description != "transport_error" {
		t.Fatalf("failed source exchange not recorded: %v", spans)
	}
	if len(spans[0].Events()) != 0 {
		t.Fatal("raw upstream error was recorded")
	}
}
