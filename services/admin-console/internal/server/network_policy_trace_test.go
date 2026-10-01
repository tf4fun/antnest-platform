package server

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
	sdktrace "go.opentelemetry.io/otel/sdk/trace"
	"go.opentelemetry.io/otel/sdk/trace/tracetest"
	"go.opentelemetry.io/otel/trace"

	"github.com/tf4fun/antnest-platform/services/admin-console/internal/telemetry"
	"github.com/tf4fun/antnest-platform/services/admin-console/internal/upstream"
)

func TestNetworkPolicyHTTPTraceAndSingleDispatch(t *testing.T) {
	recorder := tracetest.NewSpanRecorder()
	provider := sdktrace.NewTracerProvider(sdktrace.WithSpanProcessor(recorder))
	previousProvider, previousPropagator := otel.GetTracerProvider(), otel.GetTextMapPropagator()
	otel.SetTracerProvider(provider)
	otel.SetTextMapPropagator(propagation.TraceContext{})
	t.Cleanup(func() {
		_ = provider.Shutdown(context.Background())
		otel.SetTracerProvider(previousProvider)
		otel.SetTextMapPropagator(previousPropagator)
	})
	for _, method := range []string{http.MethodGet, http.MethodPut} {
		t.Run(method, func(t *testing.T) {
			verifyNetworkHTTPTrace(t, provider, recorder, method)
		})
	}
}

func verifyNetworkHTTPTrace(t *testing.T, provider *sdktrace.TracerProvider, recorder *tracetest.SpanRecorder, method string) {
	t.Helper()
	upstreamParents := make(chan trace.SpanContext, 2)
	controller := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		ctx := propagation.TraceContext{}.Extract(r.Context(), propagation.HeaderCarrier(r.Header))
		upstreamParents <- trace.SpanContextFromContext(ctx)
		if r.Method != method || r.URL.Path != "/internal/agents/agent-1/network-policy" {
			t.Errorf("unexpected request=%s %s", r.Method, r.URL)
		}
		body := networkAssignment
		if method == http.MethodGet {
			body = networkViewFixture()
			if r.URL.Query().Get("organization_id") != "org-1" {
				t.Errorf("missing trusted scope: %s", r.URL)
			}
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = io.WriteString(w, body)
	}))
	defer controller.Close()
	client, err := upstream.NewClient(upstream.Config{IdentityURL: controller.URL, AgentControllerURL: controller.URL, AgentACPURL: controller.URL, HTTPClient: controller.Client()})
	if err != nil {
		t.Fatal(err)
	}
	bff := httptest.NewServer(telemetry.HTTPHandler(newTestHandler(t, client), slog.New(slog.NewTextHandler(io.Discard, nil))))
	defer bff.Close()
	ctx, root := provider.Tracer("network-policy-test").Start(context.Background(), "synthetic-edge-request")
	request := networkRequest(method, bff.URL+networkPath, networkBody, "org-1")
	request.RequestURI = ""
	propagation.TraceContext{}.Inject(ctx, propagation.HeaderCarrier(request.Header))
	response, err := bff.Client().Do(request)
	if err != nil {
		root.End()
		t.Fatal(err)
	}
	body, readErr := io.ReadAll(response.Body)
	_ = response.Body.Close()
	root.End()
	if readErr != nil || response.StatusCode != http.StatusOK || strings.Contains(string(body), "private") {
		t.Fatalf("status=%d body=%s read=%v", response.StatusCode, body, readErr)
	}
	if len(upstreamParents) != 1 {
		t.Fatalf("dispatches=%d", len(upstreamParents))
	}
	parent := <-upstreamParents
	var serverSpan, clientSpan sdktrace.ReadOnlySpan
	for _, span := range recorder.Ended() {
		if span.SpanContext().TraceID() != root.SpanContext().TraceID() {
			continue
		}
		switch span.SpanKind() {
		case trace.SpanKindServer:
			serverSpan = span
		case trace.SpanKindClient:
			clientSpan = span
		}
		for _, attr := range span.Attributes() {
			if strings.Contains(attr.Value.AsString(), "private") {
				t.Fatalf("private trace attribute=%v", attr)
			}
		}
	}
	if serverSpan == nil || clientSpan == nil || serverSpan.Parent().SpanID() != root.SpanContext().SpanID() ||
		clientSpan.Parent().SpanID() != serverSpan.SpanContext().SpanID() || !parent.Equal(clientSpan.SpanContext().WithRemote(true)) {
		t.Fatalf("broken chain: server=%v client=%v propagated=%v", serverSpan, clientSpan, parent)
	}
}
