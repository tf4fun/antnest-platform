package identity

import (
	"context"
	"errors"
	"io"
	"net/http"
	"strings"
	"testing"

	"github.com/tf4fun/antnest-platform/services/edge-gateway/internal/telemetry"
	"go.opentelemetry.io/otel"
	sdktrace "go.opentelemetry.io/otel/sdk/trace"
	"go.opentelemetry.io/otel/sdk/trace/tracetest"
	"go.opentelemetry.io/otel/trace"
)

func TestIdentityErrorsDoNotCopyUntrustedDetailsIntoTrace(t *testing.T) {
	recorder := tracetest.NewSpanRecorder()
	provider := sdktrace.NewTracerProvider(sdktrace.WithSpanProcessor(recorder))
	previous := otel.GetTracerProvider()
	otel.SetTracerProvider(provider)
	t.Cleanup(func() { _ = provider.Shutdown(context.Background()); otel.SetTracerProvider(previous) })
	const canary = "private-identity-canary"
	for _, transportFailure := range []bool{false, true} {
		client, err := NewClient("http://identity.internal", &http.Client{Transport: telemetry.NewHTTPTransport(roundTripFunc(func(r *http.Request) (*http.Response, error) {
			if transportFailure {
				return nil, errors.New(canary)
			}
			return &http.Response{StatusCode: 503, Body: io.NopCloser(strings.NewReader(`{"code":"` + canary + `","message":"private"}`)), Header: make(http.Header), Request: r}, nil
		}))})
		if err != nil {
			t.Fatal(err)
		}
		if _, err := client.Resolve(context.Background(), "token"); err == nil {
			t.Fatal("dependency error lost")
		}
	}
	if len(recorder.Ended()) != 4 {
		t.Fatalf("spans=%d", len(recorder.Ended()))
	}
	clients, decisions := 0, 0
	for _, span := range recorder.Ended() {
		if span.SpanKind() == trace.SpanKindClient {
			clients++
		} else if span.Name() == "gateway.identity.resolve" && span.SpanKind() == trace.SpanKindInternal {
			decisions++
			if cacheTraceAttribute(span, "outcome") != "unavailable" || cacheTraceAttribute(span, "source") != "rpc" {
				t.Fatal("failed Resolve decision lost its stable classification")
			}
		}
		if strings.Contains(span.Status().Description, canary) {
			t.Fatal("upstream code leaked in span status")
		}
		for _, event := range span.Events() {
			for _, attr := range event.Attributes {
				if strings.Contains(attr.Value.String(), canary) {
					t.Fatal("raw transport error leaked in span event")
				}
			}
		}
		for _, attr := range span.Attributes() {
			if strings.Contains(attr.Value.String(), canary) {
				t.Fatal("private authority or remote error leaked in span attributes")
			}
		}
	}
	if clients != 2 || decisions != 2 {
		t.Fatal("expected two actual CLIENT spans and two independent decisions")
	}
}
