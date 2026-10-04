package runtimeclient

import (
	"context"
	"errors"
	"io"
	"net/http"
	"strings"
	"testing"
	"time"

	"go.opentelemetry.io/otel/codes"
	sdktrace "go.opentelemetry.io/otel/sdk/trace"
	"go.opentelemetry.io/otel/sdk/trace/tracetest"
	"go.opentelemetry.io/otel/trace"

	"github.com/tf4fun/antnest-platform/services/runtime-controller/internal/deployment"
)

func TestHTTP200ProtocolFailureIsRecordedAtVerificationBoundary(t *testing.T) {
	recorder := tracetest.NewSpanRecorder()
	provider := sdktrace.NewTracerProvider(sdktrace.WithSpanProcessor(recorder))
	previous := statusTracer
	statusTracer = provider.Tracer("runtime-status-test")
	t.Cleanup(func() {
		statusTracer = previous
		if err := provider.Shutdown(context.Background()); err != nil {
			t.Error(err)
		}
	})
	client := newTestClient(t, `{"agent_id":"agent-OTHER","generation":7,"execution_id":"exec-1","status":"ready"}`)
	_, err := client.Verify(context.Background(), deployment.Inspection{AgentID: "agent-1", Generation: 7, StatusEndpoint: "http://runtime.internal/status"})
	if !errors.Is(err, deployment.ErrIdentityConflict) {
		t.Fatalf("cause lost: %v", err)
	}
	spans := recorder.Ended()
	if len(spans) != 1 || spans[0].Name() != "runtime.status.verify" || spans[0].SpanKind() != trace.SpanKindInternal || spans[0].Status().Code != codes.Error {
		t.Fatal("protocol failure was hidden or duplicate CLIENT retained")
	}
	if len(spans[0].Events()) == 0 {
		t.Fatal("typed failure summary missing")
	}
}

func TestVerifyAcceptsExactReadyRuntimeExecution(t *testing.T) {
	client := newTestClient(t, `{"agent_id":"agent-1","generation":7,"execution_id":"exec-1","status":"ready"}`)
	inspection := deployment.Inspection{
		AgentID: "agent-1", Generation: 7, Health: deployment.HealthHealthy,
		StatusEndpoint: "http://runtime.internal/status",
	}

	verified, err := client.Verify(context.Background(), inspection)
	if err != nil {
		t.Fatalf("verify Runtime: %v", err)
	}
	if verified.RuntimeExecutionID != "exec-1" {
		t.Fatalf("execution identity was not captured: %+v", verified)
	}
}

func TestVerifyAcceptsCompiledFeatureStatusFromBothRuntimeBuilds(t *testing.T) {
	tests := []struct {
		name string
		body string
	}{
		{name: "release", body: `{"agent_id":"agent-1","generation":7,"execution_id":"exec-1","status":"ready","test_features":[]}`},
		{name: "e2e", body: `{"agent_id":"agent-1","generation":7,"execution_id":"exec-1","status":"ready","test_features":["skill-maintenance-e2e-gate"]}`},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			client := newTestClient(t, test.body)
			verified, err := client.Verify(context.Background(), deployment.Inspection{
				AgentID: "agent-1", Generation: 7, Health: deployment.HealthHealthy,
				StatusEndpoint: "http://runtime.internal/status",
			})
			if err != nil {
				t.Fatalf("verify Runtime with compiled feature identity: %v", err)
			}
			if verified.RuntimeExecutionID != "exec-1" {
				t.Fatalf("execution identity lost: %+v", verified)
			}
		})
	}
}

func TestVerifyRejectsMissingOrMismatchedIdentity(t *testing.T) {
	tests := []struct {
		name string
		body string
	}{
		{name: "missing execution", body: `{"agent_id":"agent-1","generation":7,"status":"ready"}`},
		{name: "agent mismatch", body: `{"agent_id":"agent-2","generation":7,"execution_id":"exec-1","status":"ready"}`},
		{name: "generation mismatch", body: `{"agent_id":"agent-1","generation":8,"execution_id":"exec-1","status":"ready"}`},
		{name: "not ready", body: `{"agent_id":"agent-1","generation":7,"execution_id":"exec-1","status":"starting"}`},
		{name: "unknown field", body: `{"agent_id":"agent-1","generation":7,"execution_id":"exec-1","status":"ready","extra":true}`},
		{name: "feature list is a string", body: `{"agent_id":"agent-1","generation":7,"execution_id":"exec-1","status":"ready","test_features":"skill-maintenance-e2e-gate"}`},
		{name: "feature is a number", body: `{"agent_id":"agent-1","generation":7,"execution_id":"exec-1","status":"ready","test_features":[42]}`},
		{name: "feature is an object", body: `{"agent_id":"agent-1","generation":7,"execution_id":"exec-1","status":"ready","test_features":[{}]}`},
		{name: "duplicate identity", body: `{"agent_id":"other","agent_id":"agent-1","generation":7,"execution_id":"exec-1","status":"ready"}`},
		{name: "oversized document", body: `{"agent_id":"agent-1","generation":7,"execution_id":"exec-1","status":"ready"}` + strings.Repeat(" ", maxStatusBytes)},
		{name: "invalid UTF-8 execution", body: "{\"agent_id\":\"agent-1\",\"generation\":7,\"execution_id\":\"exec-\xff\",\"status\":\"ready\"}"},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			client := newTestClient(t, test.body)
			_, err := client.Verify(context.Background(), deployment.Inspection{
				AgentID: "agent-1", Generation: 7, Health: deployment.HealthHealthy,
				StatusEndpoint: "http://runtime.internal/status",
			})
			if err == nil {
				t.Fatal("invalid Runtime status accepted")
			}
		})
	}
}

func TestVerifySeparatesNotReadyFromIdentityConflict(t *testing.T) {
	inspection := deployment.Inspection{
		AgentID: "agent-1", Generation: 7, Health: deployment.HealthHealthy,
		StatusEndpoint: "http://runtime.internal/status",
	}
	starting := newTestClient(t,
		`{"agent_id":"agent-1","generation":7,"execution_id":"exec-1","status":"starting"}`)
	if _, err := starting.Verify(context.Background(), inspection); !errors.Is(err, ErrNotReady) ||
		errors.Is(err, deployment.ErrIdentityConflict) {
		t.Fatalf("starting Runtime error = %v", err)
	}

	mismatch := newTestClient(t,
		`{"agent_id":"agent-2","generation":7,"execution_id":"exec-1","status":"ready"}`)
	if _, err := mismatch.Verify(context.Background(), inspection); !errors.Is(err, deployment.ErrIdentityConflict) {
		t.Fatalf("identity mismatch error = %v", err)
	}
}

func newTestClient(t *testing.T, body string) *Client {
	t.Helper()
	httpClient := &http.Client{Transport: roundTripFunc(func(request *http.Request) (*http.Response, error) {
		if request.Method != http.MethodGet || request.URL.String() != "http://runtime.internal/status" {
			t.Fatalf("unexpected Runtime request: %s %s", request.Method, request.URL)
		}
		return &http.Response{
			StatusCode: http.StatusOK, Status: "200 OK", Header: make(http.Header),
			Body: io.NopCloser(strings.NewReader(body)),
		}, nil
	})}
	client, err := newClient(httpClient, time.Second)
	if err != nil {
		t.Fatalf("new Runtime client: %v", err)
	}
	return client
}

type roundTripFunc func(*http.Request) (*http.Response, error)

func (f roundTripFunc) RoundTrip(request *http.Request) (*http.Response, error) {
	return f(request)
}
