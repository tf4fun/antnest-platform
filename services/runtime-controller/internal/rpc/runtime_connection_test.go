package rpc

import (
	"context"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"go.opentelemetry.io/otel/sdk/trace/tracetest"

	"github.com/tf4fun/antnest-platform/services/runtime-controller/internal/control"
	"github.com/tf4fun/antnest-platform/services/runtime-controller/internal/deployment"
	"github.com/tf4fun/antnest-platform/services/runtime-controller/internal/observation"
	"github.com/tf4fun/antnest-platform/services/runtime-controller/internal/serviceauth"
	"github.com/tf4fun/antnest-platform/services/runtime-controller/internal/telemetry"
)

type connectionServiceStub struct {
	*fakeService
	calls int
}

func (s *connectionServiceStub) ResolveRuntimeConnection(_ context.Context, agent string, revision deployment.RuntimeRevision, execution string) (control.RuntimeConnection, error) {
	s.calls++
	return control.RuntimeConnection{AgentID: agent, RuntimeRevision: revision, RuntimeExecutionID: execution, ConnectionID: "rci_00000000000000000000000000000001", MCPEndpoint: "http://runtime:8093/mcp", Credential: control.RuntimeCredential{Caller: "agent-acp-service", Token: controllerTestToken}}, nil
}

func TestPrivateConnectionHasNoCaptureAndRequiresExactAuthenticatedRequest(t *testing.T) {
	t.Setenv("ANTNEST_TELEMETRY_CAPTURE_RPC_CONTENT", "true")
	recorder := tracetest.NewSpanRecorder()
	rpcTestTracerProvider.RegisterSpanProcessor(recorder)
	t.Cleanup(func() { rpcTestTracerProvider.UnregisterSpanProcessor(recorder) })
	service := &connectionServiceStub{fakeService: &fakeService{}}
	handler, err := NewHandler(service, observation.NewHub(), time.Second, time.Second, fixtureSecurity())
	if err != nil {
		t.Fatal(err)
	}
	observed := telemetry.HTTPHandler(handler)
	for _, item := range []struct {
		body, token string
		status      int
	}{
		{`{"runtime_revision":"` + string(testRuntimeRevision) + `","expected_execution_id":"execution-1"}`, controllerTestToken, 200},
		{`{"runtime_revision":"` + string(testRuntimeRevision) + `","expected_execution_id":"execution-1"}`, "", 401},
		{`{"runtime_revision":"` + string(testRuntimeRevision) + `","expected_execution_id":"execution-1","token":"USER_TOKEN"}`, controllerTestToken, 400},
		{`{"runtime_revision":"` + string(testRuntimeRevision) + `","expected_execution_id":"execution-1","expected_execution_id":"forged"}`, controllerTestToken, 400},
	} {
		r := httptest.NewRequest(http.MethodPost, "/internal/runtimes/agent-1/connection", strings.NewReader(item.body))
		r.Header.Set("Content-Type", "application/json")
		if item.token != "" {
			r.Header.Set(serviceauth.Header, "Bearer "+item.token)
		}
		w := httptest.NewRecorder()
		observed.ServeHTTP(w, r)
		if w.Code != item.status {
			t.Fatal("private connection status differs", w.Code, w.Body.String())
		}
		if w.Header().Get("Cache-Control") != "no-store" {
			t.Fatal("private connection may be cached")
		}
	}
	if service.calls != 1 {
		t.Fatal("invalid requests reached private resolver")
	}
	for _, span := range recorder.Ended() {
		text := fmt.Sprint(span.Attributes(), span.Events())
		if strings.Contains(text, controllerTestToken) || strings.Contains(text, "USER_TOKEN") || strings.Contains(text, "antnest.payload.json") {
			t.Fatal("private connection captured in telemetry")
		}
	}
}
