package server

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/tf4fun/antnest-platform/services/agent-controller/internal/application"
	"github.com/tf4fun/antnest-platform/services/agent-controller/internal/domain"
)

type reliabilityLifecycleStub struct {
	*lifecycleServiceStub
	cancelInput  application.CancelLifecycleOperationInput
	cancelResult application.OperationView
	cancelErr    error
	cancelCalls  int
	clearInput   application.ClearLifecycleQuarantineInput
	clearResult  application.AgentView
	clearErr     error
	clearCalls   int
}

func (stub *reliabilityLifecycleStub) CancelLifecycleOperation(
	_ context.Context, input application.CancelLifecycleOperationInput,
) (application.OperationView, error) {
	stub.cancelCalls++
	stub.cancelInput = input
	return stub.cancelResult, stub.cancelErr
}

func (stub *reliabilityLifecycleStub) ClearLifecycleQuarantine(
	_ context.Context, input application.ClearLifecycleQuarantineInput,
) (application.AgentView, error) {
	stub.clearCalls++
	stub.clearInput = input
	return stub.clearResult, stub.clearErr
}

func TestCancelLifecycleOperationRoute(t *testing.T) {
	stub := &reliabilityLifecycleStub{
		lifecycleServiceStub: &lifecycleServiceStub{},
		cancelResult: application.OperationView{
			RequestID: "request-1", AgentID: "agent-1", Kind: domain.OperationCreate,
			Phase: domain.PhaseNetworkEnsure, State: domain.OperationRunning,
		},
	}
	handler, err := newBusinessHandler(t, &catalogServiceStub{}, stub, &agentConfigurationServiceStub{},
		&agentQueryServiceStub{}, &agentEventServiceStub{}, &networkPolicyServiceStub{},
		func(context.Context) error { return nil })
	if err != nil {
		t.Fatal(err)
	}
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, httptest.NewRequest(http.MethodPost,
		"/internal/agents/agent-1/lifecycle-operation/cancel",
		strings.NewReader(`{"organization_id":"org-1","actor_principal_id":"admin-1","operation_request_id":"request-1"}`)))
	if response.Code != http.StatusAccepted {
		t.Fatalf("status=%d body=%s", response.Code, response.Body.String())
	}
	if stub.cancelCalls != 1 || stub.cancelInput.AgentID != "agent-1" ||
		stub.cancelInput.OrganizationID != "org-1" || stub.cancelInput.ActorPrincipalID != "admin-1" ||
		stub.cancelInput.OperationRequestID != "request-1" {
		t.Fatalf("cancel input: %+v calls=%d", stub.cancelInput, stub.cancelCalls)
	}
	for _, scenario := range []struct {
		name  string
		body  string
		cause error
		code  int
	}{
		{"unknown field", `{"organization_id":"org-1","actor_principal_id":"admin-1","operation_request_id":"request-1","forged":true}`, nil, http.StatusBadRequest},
		{"missing request id", `{"organization_id":"org-1","actor_principal_id":"admin-1"}`, nil, http.StatusBadRequest},
		{"conflict", `{"organization_id":"org-1","actor_principal_id":"admin-1","operation_request_id":"request-1"}`, application.ErrLifecycleConflict, http.StatusConflict},
		{"foreign scope", `{"organization_id":"org-2","actor_principal_id":"admin-1","operation_request_id":"request-1"}`, application.ErrAgentNotFound, http.StatusNotFound},
		{"dependency", `{"organization_id":"org-1","actor_principal_id":"admin-1","operation_request_id":"request-1"}`, application.ErrDependencyUnavailable, http.StatusServiceUnavailable},
	} {
		t.Run(scenario.name, func(t *testing.T) {
			stub.cancelErr = scenario.cause
			response := httptest.NewRecorder()
			handler.ServeHTTP(response, httptest.NewRequest(http.MethodPost,
				"/internal/agents/agent-1/lifecycle-operation/cancel", strings.NewReader(scenario.body)))
			if response.Code != scenario.code {
				t.Fatalf("%s status=%d body=%s", scenario.name, response.Code, response.Body.String())
			}
		})
	}
	legacy, err := newBusinessHandler(t, &catalogServiceStub{}, &lifecycleServiceStub{},
		&agentConfigurationServiceStub{}, &agentQueryServiceStub{}, &agentEventServiceStub{},
		&networkPolicyServiceStub{}, func(context.Context) error { return nil })
	if err != nil {
		t.Fatal(err)
	}
	response = httptest.NewRecorder()
	legacy.ServeHTTP(response, httptest.NewRequest(http.MethodPost,
		"/internal/agents/agent-1/lifecycle-operation/cancel",
		strings.NewReader(`{"organization_id":"org-1","actor_principal_id":"admin-1","operation_request_id":"request-1"}`)))
	if response.Code != http.StatusServiceUnavailable {
		t.Fatalf("optional service missing: %d %s", response.Code, response.Body.String())
	}
}

func TestClearLifecycleQuarantineRoute(t *testing.T) {
	stub := &reliabilityLifecycleStub{
		lifecycleServiceStub: &lifecycleServiceStub{},
		clearResult:          application.AgentView{AgentID: "agent-1", OrganizationID: "org-1"},
	}
	handler, err := newBusinessHandler(t, &catalogServiceStub{}, stub, &agentConfigurationServiceStub{},
		&agentQueryServiceStub{}, &agentEventServiceStub{}, &networkPolicyServiceStub{},
		func(context.Context) error { return nil })
	if err != nil {
		t.Fatal(err)
	}
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, httptest.NewRequest(http.MethodPost,
		"/internal/agents/agent-1/lifecycle-quarantine/clear",
		strings.NewReader(`{"organization_id":"org-1","actor_principal_id":"admin-1","expected_aggregate_sequence":7}`)))
	if response.Code != http.StatusOK {
		t.Fatalf("status=%d body=%s", response.Code, response.Body.String())
	}
	if stub.clearCalls != 1 || stub.clearInput.AgentID != "agent-1" ||
		stub.clearInput.OrganizationID != "org-1" || stub.clearInput.ActorPrincipalID != "admin-1" ||
		stub.clearInput.ExpectedAggregateSequence != 7 {
		t.Fatalf("clear input: %+v calls=%d", stub.clearInput, stub.clearCalls)
	}
	for _, scenario := range []struct {
		name  string
		body  string
		cause error
		code  int
	}{
		{"unknown field", `{"organization_id":"org-1","actor_principal_id":"admin-1","expected_aggregate_sequence":7,"forged":1}`, nil, http.StatusBadRequest},
		{"missing sequence", `{"organization_id":"org-1","actor_principal_id":"admin-1"}`, application.ErrInvalidInput, http.StatusBadRequest},
		{"zero sequence", `{"organization_id":"org-1","actor_principal_id":"admin-1","expected_aggregate_sequence":0}`, application.ErrInvalidInput, http.StatusBadRequest},
		{"fractional sequence", `{"organization_id":"org-1","actor_principal_id":"admin-1","expected_aggregate_sequence":1.5}`, nil, http.StatusBadRequest},
		{"string sequence", `{"organization_id":"org-1","actor_principal_id":"admin-1","expected_aggregate_sequence":"7"}`, nil, http.StatusBadRequest},
		{"stale sequence", `{"organization_id":"org-1","actor_principal_id":"admin-1","expected_aggregate_sequence":6}`, application.ErrLifecycleConflict, http.StatusConflict},
		{"dependency", `{"organization_id":"org-1","actor_principal_id":"admin-1","expected_aggregate_sequence":7}`, application.ErrDependencyUnavailable, http.StatusServiceUnavailable},
	} {
		t.Run(scenario.name, func(t *testing.T) {
			stub.clearErr = scenario.cause
			response := httptest.NewRecorder()
			handler.ServeHTTP(response, httptest.NewRequest(http.MethodPost,
				"/internal/agents/agent-1/lifecycle-quarantine/clear", strings.NewReader(scenario.body)))
			if response.Code != scenario.code {
				t.Fatalf("%s status=%d body=%s", scenario.name, response.Code, response.Body.String())
			}
		})
	}
	legacy, err := newBusinessHandler(t, &catalogServiceStub{}, &lifecycleServiceStub{},
		&agentConfigurationServiceStub{}, &agentQueryServiceStub{}, &agentEventServiceStub{},
		&networkPolicyServiceStub{}, func(context.Context) error { return nil })
	if err != nil {
		t.Fatal(err)
	}
	response = httptest.NewRecorder()
	legacy.ServeHTTP(response, httptest.NewRequest(http.MethodPost,
		"/internal/agents/agent-1/lifecycle-quarantine/clear",
		strings.NewReader(`{"organization_id":"org-1","actor_principal_id":"admin-1","expected_aggregate_sequence":7}`)))
	if response.Code != http.StatusServiceUnavailable {
		t.Fatalf("optional service missing: %d %s", response.Code, response.Body.String())
	}
}
