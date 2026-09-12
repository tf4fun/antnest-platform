package server

import (
	"context"
	"fmt"
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

	"soft/antnest-platform/services/admin-console/internal/telemetry"
	"soft/antnest-platform/services/admin-console/internal/upstream"
)

func TestStatusDoesNotProbeDownstream(t *testing.T) {
	backend := &noHealthBackend{}
	h := newTestHandler(t, backend)
	response := httptest.NewRecorder()
	h.ServeHTTP(response, httptest.NewRequest(http.MethodGet, "/status", nil))
	if response.Code != 200 || response.Body.String() != "{\"status\":\"ready\"}\n" || backend.calls != 0 {
		t.Fatalf("status=%d body=%s downstream calls=%d", response.Code, response.Body, backend.calls)
	}
}

type noHealthBackend struct{ calls int }

func (b *noHealthBackend) Do(context.Context, upstream.Target, string, string, string, []byte) (*http.Response, error) {
	b.calls++
	return nil, fmt.Errorf("downstream unavailable")
}
func (b *noHealthBackend) Ready(context.Context, upstream.Target) error {
	b.calls++
	return fmt.Errorf("downstream unavailable")
}

func consoleTraceRecorder(t *testing.T) *tracetest.SpanRecorder {
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

func TestBFFTemplateTransformationAndRealHTTPParentIDs(t *testing.T) {
	recorder := consoleTraceRecorder(t)
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	controllerMux := http.NewServeMux()
	controllerMux.HandleFunc("POST /internal/agent-templates", func(w http.ResponseWriter, r *http.Request) {
		body, err := io.ReadAll(r.Body)
		if err != nil {
			t.Error(err)
		}
		if !strings.Contains(string(body), `"memory_bytes":1073741824`) {
			t.Errorf("defaults missing from actual wire: %s", body)
		}
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(201)
		_, _ = io.WriteString(w, `{"template_id":"template-actual","revision":3,"model_profile_id":"model-actual","max_model_requests":32,"runtime":{"image_ref":"runtime:local","resources":{"memory_bytes":1073741824}},"system_prompt":"secret-canary"}`)
	})
	controller := httptest.NewServer(telemetry.HTTPHandler(controllerMux, logger))
	defer controller.Close()
	backend, err := upstream.NewClient(upstream.Config{IdentityURL: controller.URL, AgentControllerURL: controller.URL, HTTPClient: controller.Client()})
	if err != nil {
		t.Fatal(err)
	}
	h := telemetry.HTTPHandler(newTestHandler(t, backend), logger)
	response := requestAdmin(t, h, http.MethodPost, "/api/admin/templates", `{"name":"template-name","model_profile_id":"model-actual","system_prompt":"secret-canary"}`)
	if response.Code != 201 {
		t.Fatalf("status=%d body=%s", response.Code, response.Body)
	}
	var inbound, client, receiver sdktrace.ReadOnlySpan
	for _, span := range recorder.Ended() {
		switch {
		case span.SpanKind() == trace.SpanKindClient:
			client = span
		case span.Name() == "HTTP POST /api/admin/templates":
			inbound = span
		case span.Name() == "HTTP POST /internal/agent-templates":
			receiver = span
		}
		if strings.Contains(fmt.Sprint(span.Attributes(), span.Events()), "secret-canary") {
			t.Fatal("secret leaked in trace")
		}
	}
	if len(recorder.Ended()) != 3 || inbound == nil || client == nil || receiver == nil {
		t.Fatalf("unexpected spans: %v", recorder.Ended())
	}
	if client.Parent().SpanID() != inbound.SpanContext().SpanID() || receiver.Parent().SpanID() != client.SpanContext().SpanID() || receiver.SpanContext().TraceID() != inbound.SpanContext().TraceID() {
		t.Fatal("incorrect cross-service parent IDs")
	}
	incoming := diagnosticJSON(inbound, "antnest.request")
	outgoing := diagnosticJSON(client, "antnest.request")
	if incoming != "" || outgoing != "" {
		t.Fatalf("HTTP body unexpectedly captured: incoming=%s outgoing=%s", incoming, outgoing)
	}
	if diagnosticJSON(inbound, "antnest.response") != "" {
		t.Fatal("HTTP response body captured")
	}
}

func TestProtocolErrorHTTP200RemainsHTTP200ButObservedAsFailure(t *testing.T) {
	recorder := consoleTraceRecorder(t)
	backend := newBackendStub()
	backend.enqueue(200, `{"code":"dependency_unavailable","message":"provider-secret-canary"}`)
	h := telemetry.HTTPHandler(newTestHandler(t, backend), slog.New(slog.NewTextHandler(io.Discard, nil)))
	response := requestAdmin(t, h, http.MethodGet, "/api/admin/model-profiles/model-1", "")
	if response.Code != 200 {
		t.Fatalf("business HTTP status changed: %d", response.Code)
	}
	spans := recorder.Ended()
	if len(spans) != 1 || spans[0].Status().Code != codes.Error || !strings.Contains(fmt.Sprint(spans[0].Events()), "dependency_unavailable") {
		t.Fatalf("protocol error not observed: %v", spans)
	}
	if strings.Contains(fmt.Sprint(spans[0].Events()), "provider-secret-canary") {
		t.Fatal("unsafe error message leaked")
	}
}

func TestBFFValidationAndProjectionFailuresAreObserved(t *testing.T) {
	for _, scenario := range []struct {
		method, path, body, upstreamBody, code string
		status                                 int
	}{
		{http.MethodPost, "/api/admin/agents", `{"template_revision":0}`, `{}`, "invalid_request", 400},
		{http.MethodGet, "/api/admin/model-profiles/model-1", "", `{"model":{"context_window":"secret-canary"}}`, "invalid_upstream_response", 502},
	} {
		t.Run(scenario.code, func(t *testing.T) {
			recorder := consoleTraceRecorder(t)
			backend := newBackendStub()
			backend.enqueue(200, scenario.upstreamBody)
			h := telemetry.HTTPHandler(newTestHandler(t, backend), slog.New(slog.NewTextHandler(io.Discard, nil)))
			response := requestAdmin(t, h, scenario.method, scenario.path, scenario.body)
			if response.Code != scenario.status {
				t.Fatalf("status=%d", response.Code)
			}
			span := recorder.Ended()[0]
			if !strings.Contains(fmt.Sprint(span.Events()), scenario.code) || strings.Contains(fmt.Sprint(span.Events()), "secret-canary") {
				t.Fatalf("failure summary=%v", span.Events())
			}
			if scenario.status == 400 && span.Status().Code == codes.Error {
				t.Fatal("validation refusal became service failure")
			}
		})
	}
}

func diagnosticJSON(span sdktrace.ReadOnlySpan, name string) string {
	for _, event := range span.Events() {
		if event.Name == name {
			for _, attr := range event.Attributes {
				if attr.Key == "antnest.payload.json" {
					return attr.Value.AsString()
				}
			}
		}
	}
	return ""
}
