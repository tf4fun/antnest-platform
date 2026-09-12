package server

import (
	"context"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"go.opentelemetry.io/otel/trace"

	"soft/antnest-platform/services/agent-controller/internal/application"
	"soft/antnest-platform/services/agent-controller/internal/domain"
	"soft/antnest-platform/services/agent-controller/internal/ports"
	"soft/antnest-platform/services/agent-controller/internal/telemetry"
)

type workspaceTraceStore struct {
	ports.AgentQueryStore
	spanContext trace.SpanContext
}

func (store *workspaceTraceStore) ListWorkspaceAgents(ctx context.Context, _ ports.WorkspaceAgentQuery) ([]ports.WorkspaceAgentRecord, error) {
	store.spanContext = trace.SpanContextFromContext(ctx)
	return []ports.WorkspaceAgentRecord{{AgentID: "agent-1", DesiredState: domain.DesiredEnabled, LifecycleState: domain.AgentAvailable, AggregateSequence: 3, AccessSubject: "private-routing-credential"}}, nil
}

func TestWorkspaceStateTraceContinuesIncomingRequestToRepository(t *testing.T) {
	recorder := networkPolicyTraceRecorder(t)
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	store := &workspaceTraceStore{}
	endpoint := workspaceStateHandler(t, application.NewAgentQueryService(store))
	request := httptest.NewRequest(http.MethodGet, "/internal/workspace/agents/agent-1/state?organization_id=org-1&principal_id=user-1", nil)
	traceID := "4bf92f3577b34da6a3ce929d0e0e4736"
	request.Header.Set("traceparent", "00-"+traceID+"-00f067aa0ba902b7-01")
	response := httptest.NewRecorder()
	telemetry.HTTPHandler(endpoint, logger).ServeHTTP(response, request)
	if response.Code != http.StatusOK {
		t.Fatalf("response=%d %s", response.Code, response.Body)
	}
	spans := recorder.Ended()
	if len(spans) != 1 {
		t.Fatalf("spans=%d", len(spans))
	}
	var rootID trace.SpanID
	for _, span := range spans {
		if span.SpanKind() == trace.SpanKindServer {
			rootID = span.SpanContext().SpanID()
			if span.Name() != "HTTP GET /internal/workspace/agents/{agent_id}/state" || span.Parent().SpanID().String() != "00f067aa0ba902b7" {
				t.Fatalf("HTTP span=%s parent=%s", span.Name(), span.Parent().SpanID())
			}
		}
	}
	if !rootID.IsValid() {
		t.Fatal("missing HTTP root")
	}
	if store.spanContext.SpanID() != rootID || store.spanContext.TraceID().String() != traceID {
		t.Fatal("repository did not receive the HTTP span context")
	}
	for _, span := range spans {
		if span.SpanContext().TraceID().String() != traceID {
			t.Fatal("detached trace")
		}
		for _, attr := range span.Attributes() {
			if strings.Contains(attr.Value.String(), "private-routing-credential") {
				t.Fatal("credential in trace")
			}
		}
	}
}
