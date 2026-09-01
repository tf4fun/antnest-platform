package server

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/codes"
	sdktrace "go.opentelemetry.io/otel/sdk/trace"
	"go.opentelemetry.io/otel/sdk/trace/tracetest"
	"go.opentelemetry.io/otel/trace"

	"soft/antnest-platform/services/agent-controller/internal/application"
	"soft/antnest-platform/services/agent-controller/internal/domain"
	"soft/antnest-platform/services/agent-controller/internal/ports"
)

func TestCatalogHandlerCreatesModelProfileWithoutEchoingSecret(t *testing.T) {
	t.Parallel()

	service := &catalogServiceStub{modelView: sampleModelProfileView()}
	handler, err := NewHandler(service, &lifecycleServiceStub{}, &runServiceStub{}, &agentQueryServiceStub{}, &agentEventServiceStub{}, func(context.Context) error { return nil })
	if err != nil {
		t.Fatalf("new handler: %v", err)
	}
	body := `{
        "request_id":"request-1",
        "organization_id":"org-1",
        "profile_key":"deepseek",
        "display_name":"DeepSeek",
        "model":{
          "base_url":"https://api.example.com/v1",
          "model":"deepseek-chat",
          "context_window":128000,
          "max_output_tokens":8192,
          "supports_images":false
        },
        "credential":{"secret_type":"bearer","secret":"top-secret"}
      }`
	response := httptest.NewRecorder()
	request := httptest.NewRequest(http.MethodPost, "/internal/model-profiles", strings.NewReader(body))
	handler.ServeHTTP(response, request)

	if response.Code != http.StatusCreated {
		t.Fatalf("status = %d body=%s", response.Code, response.Body.String())
	}
	if service.createModelInput.CredentialSecret != "top-secret" {
		t.Fatal("credential was not delivered to Catalog service")
	}
	if bytes.Contains(response.Body.Bytes(), []byte("top-secret")) || bytes.Contains(response.Body.Bytes(), []byte("ciphertext")) {
		t.Fatalf("response leaked credential material: %s", response.Body.String())
	}
	var payload map[string]any
	if err := json.Unmarshal(response.Body.Bytes(), &payload); err != nil {
		t.Fatalf("decode response: %v", err)
	}
	if payload["model_profile_id"] != "model-1" || payload["revision_id"] != "model-revision-1" {
		t.Fatalf("response does not match control contract: %v", payload)
	}
}

func TestCatalogHandlerRejectsUnknownFieldsAndTrailingJSON(t *testing.T) {
	t.Parallel()

	service := &catalogServiceStub{}
	handler, err := NewHandler(service, &lifecycleServiceStub{}, &runServiceStub{}, &agentQueryServiceStub{}, &agentEventServiceStub{}, func(context.Context) error { return nil })
	if err != nil {
		t.Fatalf("new handler: %v", err)
	}
	requests := []string{
		`{"request_id":"request-1","unknown":true}`,
		`{"request_id":"request-1"}{"request_id":"request-2"}`,
	}
	for _, body := range requests {
		response := httptest.NewRecorder()
		request := httptest.NewRequest(http.MethodPost, "/internal/model-profiles", strings.NewReader(body))
		handler.ServeHTTP(response, request)
		if response.Code != http.StatusBadRequest {
			t.Errorf("body %q status = %d response=%s", body, response.Code, response.Body.String())
		}
	}
	if service.createModelCalls != 0 {
		t.Fatalf("invalid requests reached Catalog service %d times", service.createModelCalls)
	}
}

func TestCatalogHandlerListsCurrentTemplatesWithNullableCursor(t *testing.T) {
	t.Parallel()

	service := &catalogServiceStub{templatePage: application.TemplatePage{
		Items: []application.TemplateView{sampleTemplateView()}, NextAfterID: "template-1",
	}}
	handler, err := NewHandler(service, &lifecycleServiceStub{}, &runServiceStub{}, &agentQueryServiceStub{}, &agentEventServiceStub{}, func(context.Context) error { return nil })
	if err != nil {
		t.Fatalf("new handler: %v", err)
	}
	response := httptest.NewRecorder()
	request := httptest.NewRequest(http.MethodGet, "/internal/agent-templates?organization_id=org-1&after_id=template-0&limit=20", nil)
	handler.ServeHTTP(response, request)

	if response.Code != http.StatusOK {
		t.Fatalf("status = %d body=%s", response.Code, response.Body.String())
	}
	if service.listInput != (application.ListCatalogInput{OrganizationID: "org-1", AfterID: "template-0", Limit: 20}) {
		t.Fatalf("list input = %+v", service.listInput)
	}
	var payload struct {
		Items       []map[string]any `json:"items"`
		NextAfterID *string          `json:"next_after_id"`
	}
	if err := json.Unmarshal(response.Body.Bytes(), &payload); err != nil {
		t.Fatalf("decode response: %v", err)
	}
	if len(payload.Items) != 1 || payload.NextAfterID == nil || *payload.NextAfterID != "template-1" {
		t.Fatalf("unexpected Template page: %+v", payload)
	}
	skillRefs, ok := payload.Items[0]["skill_refs"].([]any)
	if !ok || len(skillRefs) != 0 {
		t.Fatalf("Stage 2 Template skill refs = %#v", payload.Items[0]["skill_refs"])
	}
}

func TestCatalogHandlerMapsStableErrors(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name   string
		err    error
		status int
		code   string
	}{
		{name: "invalid", err: application.ErrInvalidInput, status: http.StatusBadRequest, code: "invalid_request"},
		{name: "not found", err: ports.ErrNotFound, status: http.StatusNotFound, code: "reference_not_found"},
		{name: "disabled", err: ports.ErrDisabledReference, status: http.StatusConflict, code: "reference_disabled"},
		{name: "request conflict", err: ports.ErrRequestConflict, status: http.StatusConflict, code: "request_id_conflict"},
		{name: "concurrent", err: ports.ErrConcurrentChange, status: http.StatusConflict, code: "lifecycle_conflict"},
		{name: "Agent missing", err: application.ErrAgentNotFound, status: http.StatusNotFound, code: "agent_not_found"},
		{name: "Agent not ready", err: application.ErrAgentNotReady, status: http.StatusConflict, code: "agent_not_ready"},
		{name: "Agent busy", err: application.ErrLifecycleConflict, status: http.StatusConflict, code: "lifecycle_conflict"},
		{name: "internal", err: errors.New("database detail"), status: http.StatusInternalServerError, code: "internal_error"},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			service := &catalogServiceStub{getModelErr: test.err}
			handler, err := NewHandler(service, &lifecycleServiceStub{}, &runServiceStub{}, &agentQueryServiceStub{}, &agentEventServiceStub{}, func(context.Context) error { return nil })
			if err != nil {
				t.Fatalf("new handler: %v", err)
			}
			response := httptest.NewRecorder()
			request := httptest.NewRequest(http.MethodGet, "/internal/model-profiles/model-1", nil)
			handler.ServeHTTP(response, request)
			if response.Code != test.status {
				t.Fatalf("status = %d body=%s", response.Code, response.Body.String())
			}
			var payload errorResponse
			if err := json.Unmarshal(response.Body.Bytes(), &payload); err != nil {
				t.Fatalf("decode error: %v", err)
			}
			if payload.Code != test.code || strings.Contains(payload.Message, "database detail") {
				t.Fatalf("error response = %+v", payload)
			}
		})
	}
}

func TestLifecycleHandlerCreatesAgentWithStableContract(t *testing.T) {
	t.Parallel()

	now := time.Unix(10, 0).UTC()
	lifecycle := &lifecycleServiceStub{result: application.CreateAgentResult{
		Agent: application.AgentView{
			AgentID: "agent-1", OrganizationID: "org-1", OwnerUserID: "user-1",
			Name: "Research Agent", DesiredState: domain.DesiredEnabled,
			LifecycleState: domain.AgentAvailable, AccessRevision: "access-revision-1",
			AgentSpecRevisionID: "agentspec-1", ExecutionRevisionID: "execution-1",
			LastSuccessfulExecutionRevisionID: "execution-1",
			RuntimeRevision:                   "runtime-1", RuntimeExecutionID: "runtime-execution-1",
			RuntimeMCPEndpoint: "http://runtime:8091/mcp", CreatedAt: now, UpdatedAt: now,
		},
		AgentAccessSubject: "access-1",
		Operation: application.OperationView{
			RequestID: "request-agent-1", AgentID: "agent-1", Kind: domain.OperationCreate,
			Phase: domain.PhaseCompleted, State: domain.OperationCompleted,
			CreatedAt: now, UpdatedAt: now,
		},
	}}
	handler, err := NewHandler(&catalogServiceStub{}, lifecycle, &runServiceStub{}, &agentQueryServiceStub{}, &agentEventServiceStub{}, func(context.Context) error { return nil })
	if err != nil {
		t.Fatalf("new handler: %v", err)
	}
	response := httptest.NewRecorder()
	request := httptest.NewRequest(http.MethodPost, "/internal/agents", strings.NewReader(`{
		"request_id":"request-agent-1",
		"organization_id":"org-1",
		"owner_user_id":"user-1",
		"name":"Research Agent",
		"template_id":"template-1",
		"template_revision":1
	}`))
	request = requestWithServerSpan(t, request)
	handler.ServeHTTP(response, request)

	if response.Code != http.StatusAccepted {
		t.Fatalf("status = %d body=%s", response.Code, response.Body.String())
	}
	if lifecycle.input.InitialTraceParent != testServerTraceParent ||
		lifecycle.input.OwnerUserID != "user-1" || lifecycle.input.TemplateRevision != 1 {
		t.Fatalf("CreateAgent input = %+v", lifecycle.input)
	}
	var payload struct {
		Agent struct {
			AgentID           string `json:"agent_id"`
			AgentSpecRevision string `json:"agent_spec_revision"`
			Runtime           struct {
				MCPEndpoint string `json:"mcp_endpoint"`
			} `json:"runtime"`
		} `json:"agent"`
		AgentAccessSubject string `json:"agent_access_subject"`
		Operation          struct {
			State string `json:"state"`
		} `json:"operation"`
	}
	if err := json.Unmarshal(response.Body.Bytes(), &payload); err != nil {
		t.Fatalf("decode response: %v", err)
	}
	if payload.Agent.AgentID != "agent-1" || payload.Agent.AgentSpecRevision != "agentspec-1" ||
		payload.Agent.Runtime.MCPEndpoint != "http://runtime:8091/mcp" ||
		payload.AgentAccessSubject != "access-1" || payload.Operation.State != "completed" {
		t.Fatalf("response = %+v", payload)
	}
}

func TestLifecycleHandlerGetsDurableOperation(t *testing.T) {
	t.Parallel()

	now := time.Unix(20, 0).UTC()
	lifecycle := &lifecycleServiceStub{operation: application.OperationView{
		RequestID: "request-agent-1", AgentID: "agent-1", Kind: domain.OperationCreate,
		Phase: domain.PhaseRuntimeInitialize, State: domain.OperationRunning,
		CreatedAt: now, UpdatedAt: now,
	}}
	handler, err := NewHandler(&catalogServiceStub{}, lifecycle, &runServiceStub{}, &agentQueryServiceStub{}, &agentEventServiceStub{}, func(context.Context) error { return nil })
	if err != nil {
		t.Fatalf("new handler: %v", err)
	}
	response := httptest.NewRecorder()
	request := httptest.NewRequest(http.MethodGet, "/internal/agent-operations/request-agent-1", nil)
	handler.ServeHTTP(response, request)

	if response.Code != http.StatusOK {
		t.Fatalf("status = %d body=%s", response.Code, response.Body.String())
	}
	if lifecycle.operationRequestID != "request-agent-1" {
		t.Fatalf("operation request ID = %q", lifecycle.operationRequestID)
	}
	var payload operationResponse
	if err := json.Unmarshal(response.Body.Bytes(), &payload); err != nil {
		t.Fatalf("decode response: %v", err)
	}
	if payload.RequestID != "request-agent-1" || payload.Phase != domain.PhaseRuntimeInitialize {
		t.Fatalf("operation response = %+v", payload)
	}
}

func TestLifecycleHandlerRequestsAgentRebuildWithStableContract(t *testing.T) {
	t.Parallel()

	now := time.Unix(30, 0).UTC()
	lifecycle := &lifecycleServiceStub{rebuildResult: application.RebuildAgentResult{
		Agent: application.AgentView{
			AgentID: "agent-1", OrganizationID: "org-1", OwnerUserID: "user-1",
			Name: "Research Agent", DesiredState: domain.DesiredEnabled,
			LifecycleState: domain.AgentAvailable, AgentSpecRevisionID: "agentspec-2",
			ExecutionRevisionID: "execution-2", RuntimeRevision: "runtime-2",
			RuntimeExecutionID: "runtime-execution-2",
			RuntimeMCPEndpoint: "http://runtime-2:8091/mcp", CreatedAt: now, UpdatedAt: now,
		},
		Operation: application.OperationView{
			RequestID: "request-rebuild-1", AgentID: "agent-1",
			Kind: domain.OperationRebuild, Phase: domain.PhaseCompleted,
			State: domain.OperationCompleted, CreatedAt: now, UpdatedAt: now,
		},
	}}
	handler, err := NewHandler(&catalogServiceStub{}, lifecycle, &runServiceStub{}, &agentQueryServiceStub{}, &agentEventServiceStub{}, func(context.Context) error { return nil })
	if err != nil {
		t.Fatalf("new handler: %v", err)
	}
	response := httptest.NewRecorder()
	request := httptest.NewRequest(
		http.MethodPost, "/internal/agents/agent-1/rebuild",
		strings.NewReader(`{
			"request_id":"request-rebuild-1",
			"template_id":"template-1",
			"template_revision":2
		}`),
	)
	request = requestWithServerSpan(t, request)
	handler.ServeHTTP(response, request)

	if response.Code != http.StatusAccepted {
		t.Fatalf("status = %d body=%s", response.Code, response.Body.String())
	}
	if lifecycle.rebuildInput.AgentID != "agent-1" ||
		lifecycle.rebuildInput.TemplateRevision != 2 ||
		lifecycle.rebuildInput.InitialTraceParent != testServerTraceParent {
		t.Fatalf("RebuildAgent input = %+v", lifecycle.rebuildInput)
	}
	var payload operationResponse
	if err := json.Unmarshal(response.Body.Bytes(), &payload); err != nil {
		t.Fatalf("decode response: %v", err)
	}
	if payload.Kind != domain.OperationRebuild || payload.State != domain.OperationCompleted ||
		payload.RequestID != "request-rebuild-1" {
		t.Fatalf("response = %+v", payload)
	}
}

func TestLifecycleHandlerRequestsAgentDisableWithStableContract(t *testing.T) {
	t.Parallel()

	now := time.Unix(40, 0).UTC()
	lifecycle := &lifecycleServiceStub{disableResult: application.DisableAgentResult{
		Agent: application.AgentView{
			AgentID: "agent-1", DesiredState: domain.DesiredDisabled,
			LifecycleState: domain.AgentDisabled, RuntimeRevision: "runtime-disabled",
		},
		Operation: application.OperationView{
			RequestID: "request-disable-1", AgentID: "agent-1",
			Kind: domain.OperationDisable, Phase: domain.PhaseCompleted,
			State: domain.OperationCompleted, CreatedAt: now, UpdatedAt: now,
		},
	}}
	handler, err := NewHandler(
		&catalogServiceStub{}, lifecycle, &runServiceStub{}, &agentQueryServiceStub{},
		&agentEventServiceStub{},
		func(context.Context) error { return nil },
	)
	if err != nil {
		t.Fatalf("new handler: %v", err)
	}
	response := httptest.NewRecorder()
	request := httptest.NewRequest(
		http.MethodPost, "/internal/agents/agent-1/disable",
		strings.NewReader(`{"request_id":"request-disable-1"}`),
	)
	request = requestWithServerSpan(t, request)
	handler.ServeHTTP(response, request)

	if response.Code != http.StatusAccepted {
		t.Fatalf("status = %d body=%s", response.Code, response.Body.String())
	}
	if lifecycle.disableInput.AgentID != "agent-1" ||
		lifecycle.disableInput.RequestID != "request-disable-1" ||
		lifecycle.disableInput.InitialTraceParent != testServerTraceParent {
		t.Fatalf("DisableAgent input = %+v", lifecycle.disableInput)
	}
	var payload operationResponse
	if err := json.Unmarshal(response.Body.Bytes(), &payload); err != nil {
		t.Fatalf("decode response: %v", err)
	}
	if payload.Kind != domain.OperationDisable || payload.State != domain.OperationCompleted ||
		payload.RequestID != "request-disable-1" {
		t.Fatalf("response = %+v", payload)
	}
}

func TestLifecycleHandlerRequestsAgentEnableWithStableContract(t *testing.T) {
	t.Parallel()

	now := time.Unix(50, 0).UTC()
	lifecycle := &lifecycleServiceStub{enableResult: application.EnableAgentResult{
		Agent: application.AgentView{
			AgentID: "agent-1", DesiredState: domain.DesiredEnabled,
			LifecycleState: domain.AgentAvailable, RuntimeRevision: "runtime-enabled",
		},
		Operation: application.OperationView{
			RequestID: "request-enable-1", AgentID: "agent-1",
			Kind: domain.OperationEnable, Phase: domain.PhaseCompleted,
			State: domain.OperationCompleted, CreatedAt: now, UpdatedAt: now,
		},
	}}
	handler, err := NewHandler(
		&catalogServiceStub{}, lifecycle, &runServiceStub{}, &agentQueryServiceStub{},
		&agentEventServiceStub{},
		func(context.Context) error { return nil },
	)
	if err != nil {
		t.Fatalf("new handler: %v", err)
	}
	response := httptest.NewRecorder()
	request := httptest.NewRequest(
		http.MethodPost, "/internal/agents/agent-1/enable",
		strings.NewReader(`{"request_id":"request-enable-1"}`),
	)
	request = requestWithServerSpan(t, request)
	handler.ServeHTTP(response, request)

	if response.Code != http.StatusAccepted {
		t.Fatalf("status = %d body=%s", response.Code, response.Body.String())
	}
	if lifecycle.enableInput.AgentID != "agent-1" ||
		lifecycle.enableInput.RequestID != "request-enable-1" ||
		lifecycle.enableInput.InitialTraceParent != testServerTraceParent {
		t.Fatalf("EnableAgent input = %+v", lifecycle.enableInput)
	}
	var payload operationResponse
	if err := json.Unmarshal(response.Body.Bytes(), &payload); err != nil {
		t.Fatalf("decode response: %v", err)
	}
	if payload.Kind != domain.OperationEnable || payload.State != domain.OperationCompleted ||
		payload.RequestID != "request-enable-1" {
		t.Fatalf("response = %+v", payload)
	}
}

func TestLifecycleHandlerRequestsAgentDeleteWithStableContract(t *testing.T) {
	t.Parallel()

	now := time.Unix(60, 0).UTC()
	lifecycle := &lifecycleServiceStub{deleteResult: application.DeleteAgentResult{
		Agent: application.AgentView{
			AgentID: "agent-1", DesiredState: domain.DesiredDeleted,
			LifecycleState: domain.AgentDeleted,
		},
		Operation: application.OperationView{
			RequestID: "request-delete-1", AgentID: "agent-1",
			Kind: domain.OperationDelete, Phase: domain.PhaseCompleted,
			State: domain.OperationCompleted, CreatedAt: now, UpdatedAt: now,
		},
	}}
	handler, err := NewHandler(
		&catalogServiceStub{}, lifecycle, &runServiceStub{}, &agentQueryServiceStub{},
		&agentEventServiceStub{},
		func(context.Context) error { return nil },
	)
	if err != nil {
		t.Fatalf("new handler: %v", err)
	}
	response := httptest.NewRecorder()
	request := httptest.NewRequest(
		http.MethodPost, "/internal/agents/agent-1/delete",
		strings.NewReader(`{"request_id":"request-delete-1"}`),
	)
	request = requestWithServerSpan(t, request)
	handler.ServeHTTP(response, request)

	if response.Code != http.StatusAccepted {
		t.Fatalf("status = %d body=%s", response.Code, response.Body.String())
	}
	if lifecycle.deleteInput.AgentID != "agent-1" ||
		lifecycle.deleteInput.RequestID != "request-delete-1" ||
		lifecycle.deleteInput.InitialTraceParent != testServerTraceParent {
		t.Fatalf("DeleteAgent input = %+v", lifecycle.deleteInput)
	}
	var payload operationResponse
	if err := json.Unmarshal(response.Body.Bytes(), &payload); err != nil {
		t.Fatalf("decode response: %v", err)
	}
	if payload.Kind != domain.OperationDelete || payload.State != domain.OperationCompleted ||
		payload.RequestID != "request-delete-1" {
		t.Fatalf("response = %+v", payload)
	}
}

func TestLifecycleHandlerAppliesTotalAttemptTimeout(t *testing.T) {
	t.Parallel()

	lifecycle := &lifecycleServiceStub{waitForCreateCancellation: true}
	handler, err := NewHandler(
		&catalogServiceStub{}, lifecycle, &runServiceStub{}, &agentQueryServiceStub{},
		&agentEventServiceStub{}, func(context.Context) error { return nil },
		WithLifecycleTimeout(10*time.Millisecond),
	)
	if err != nil {
		t.Fatalf("new handler: %v", err)
	}
	response := httptest.NewRecorder()
	request := httptest.NewRequest(
		http.MethodPost, "/internal/agents",
		strings.NewReader(`{
			"request_id":"request-timeout-1",
			"organization_id":"org-1",
			"owner_user_id":"user-1",
			"name":"Timeout Agent",
			"template_id":"template-1",
			"template_revision":1
		}`),
	)
	handler.ServeHTTP(response, request)

	if response.Code != http.StatusGatewayTimeout {
		t.Fatalf("status = %d body=%s", response.Code, response.Body.String())
	}
	var payload errorResponse
	if err := json.Unmarshal(response.Body.Bytes(), &payload); err != nil {
		t.Fatalf("decode response: %v", err)
	}
	if payload.Code != "lifecycle_timeout" || !payload.Retryable || !lifecycle.createHadDeadline {
		t.Fatalf("timeout response=%+v deadline=%v", payload, lifecycle.createHadDeadline)
	}
}

func TestNewHandlerRejectsInvalidLifecycleTimeout(t *testing.T) {
	t.Parallel()

	_, err := NewHandler(
		&catalogServiceStub{}, &lifecycleServiceStub{}, &runServiceStub{},
		&agentQueryServiceStub{}, &agentEventServiceStub{},
		func(context.Context) error { return nil }, WithLifecycleTimeout(0),
	)
	if err == nil {
		t.Fatal("zero lifecycle timeout was accepted")
	}
}

const testServerTraceParent = "00-0123456789abcdef0123456789abcdef-0123456789abcdef-01"

func requestWithServerSpan(t *testing.T, request *http.Request) *http.Request {
	t.Helper()
	traceID, err := trace.TraceIDFromHex("0123456789abcdef0123456789abcdef")
	if err != nil {
		t.Fatalf("parse test trace ID: %v", err)
	}
	spanID, err := trace.SpanIDFromHex("0123456789abcdef")
	if err != nil {
		t.Fatalf("parse test span ID: %v", err)
	}
	spanContext := trace.NewSpanContext(trace.SpanContextConfig{
		TraceID: traceID, SpanID: spanID, TraceFlags: trace.FlagsSampled,
	})
	return request.WithContext(trace.ContextWithSpanContext(request.Context(), spanContext))
}

func TestObserveLifecycleResultMarksTerminalBusinessFailure(t *testing.T) {
	previousProvider := otel.GetTracerProvider()
	recorder := tracetest.NewSpanRecorder()
	provider := sdktrace.NewTracerProvider(sdktrace.WithSpanProcessor(recorder))
	otel.SetTracerProvider(provider)
	t.Cleanup(func() {
		_ = provider.Shutdown(context.Background())
		otel.SetTracerProvider(previousProvider)
	})

	ctx, span := otel.Tracer("handler-test").Start(context.Background(), "request")
	observeLifecycleResult(ctx, application.OperationView{
		RequestID: "request-rebuild-failed", AgentID: "agent-1",
		Kind: domain.OperationRebuild, Phase: domain.PhaseDrain,
		State: domain.OperationFailed, ErrorCode: "run_drain_timeout",
	})
	span.End()
	ended := recorder.Ended()
	if len(ended) != 1 || ended[0].Status().Code != codes.Error ||
		ended[0].Status().Description != "timeout" {
		t.Fatalf("failed lifecycle span = %+v", ended)
	}
}

type catalogServiceStub struct {
	createModelInput application.CreateModelProfileInput
	createModelCalls int
	modelView        application.ModelProfileView
	getModelErr      error
	templatePage     application.TemplatePage
	listInput        application.ListCatalogInput
}

type lifecycleServiceStub struct {
	input                     application.CreateAgentInput
	result                    application.CreateAgentResult
	rebuildInput              application.RebuildAgentInput
	rebuildResult             application.RebuildAgentResult
	disableInput              application.DisableAgentInput
	disableResult             application.DisableAgentResult
	enableInput               application.EnableAgentInput
	enableResult              application.EnableAgentResult
	deleteInput               application.DeleteAgentInput
	deleteResult              application.DeleteAgentResult
	operation                 application.OperationView
	operationRequestID        string
	err                       error
	waitForCreateCancellation bool
	createHadDeadline         bool
}

func (service *lifecycleServiceStub) CreateAgent(
	ctx context.Context, input application.CreateAgentInput,
) (application.CreateAgentResult, error) {
	service.input = input
	_, service.createHadDeadline = ctx.Deadline()
	if service.waitForCreateCancellation {
		<-ctx.Done()
		return application.CreateAgentResult{}, ctx.Err()
	}
	return service.result, service.err
}

func (service *lifecycleServiceStub) GetLifecycleOperation(
	_ context.Context, requestID string,
) (application.OperationView, error) {
	service.operationRequestID = requestID
	return service.operation, service.err
}

func (service *lifecycleServiceStub) RebuildAgent(
	_ context.Context, input application.RebuildAgentInput,
) (application.RebuildAgentResult, error) {
	service.rebuildInput = input
	return service.rebuildResult, service.err
}

func (service *lifecycleServiceStub) DisableAgent(
	_ context.Context, input application.DisableAgentInput,
) (application.DisableAgentResult, error) {
	service.disableInput = input
	return service.disableResult, service.err
}

func (service *lifecycleServiceStub) EnableAgent(
	_ context.Context, input application.EnableAgentInput,
) (application.EnableAgentResult, error) {
	service.enableInput = input
	return service.enableResult, service.err
}

func (service *lifecycleServiceStub) DeleteAgent(
	_ context.Context, input application.DeleteAgentInput,
) (application.DeleteAgentResult, error) {
	service.deleteInput = input
	return service.deleteResult, service.err
}

func (service *catalogServiceStub) CreateModelProfile(
	_ context.Context, input application.CreateModelProfileInput,
) (application.ModelProfileView, error) {
	service.createModelCalls++
	service.createModelInput = input
	return service.modelView, nil
}

func (service *catalogServiceStub) ReviseModelProfile(
	context.Context, application.ReviseModelProfileInput,
) (application.ModelProfileView, error) {
	return service.modelView, nil
}

func (service *catalogServiceStub) GetModelProfile(
	context.Context, string,
) (application.ModelProfileView, error) {
	return service.modelView, service.getModelErr
}

func (service *catalogServiceStub) ListModelProfiles(
	context.Context, application.ListCatalogInput,
) (application.ModelProfilePage, error) {
	return application.ModelProfilePage{}, nil
}

func (service *catalogServiceStub) CreateTemplate(
	context.Context, application.CreateTemplateInput,
) (application.TemplateView, error) {
	return sampleTemplateView(), nil
}

func (service *catalogServiceStub) ReviseTemplate(
	context.Context, application.ReviseTemplateInput,
) (application.TemplateView, error) {
	return sampleTemplateView(), nil
}

func (service *catalogServiceStub) GetTemplate(
	context.Context, string,
) (application.TemplateView, error) {
	return sampleTemplateView(), nil
}

func (service *catalogServiceStub) ListTemplates(
	_ context.Context, input application.ListCatalogInput,
) (application.TemplatePage, error) {
	service.listInput = input
	return service.templatePage, nil
}

func sampleModelProfileView() application.ModelProfileView {
	return application.ModelProfileView{
		ModelProfileID: "model-1", OrganizationID: "org-1", ProfileKey: "deepseek",
		DisplayName: "DeepSeek", RevisionID: "model-revision-1", Revision: 1,
		CredentialRef: "credential-1", CredentialVersion: "credential-version-1", Enabled: true,
		Model: domain.ModelSpec{
			BaseURL: "https://api.example.com/v1", Model: "deepseek-chat",
			ContextWindow: 128000, MaxOutputTokens: 8192,
		},
		CreatedAt: time.Unix(1, 0).UTC(), UpdatedAt: time.Unix(1, 0).UTC(),
	}
}

func sampleTemplateView() application.TemplateView {
	return application.TemplateView{
		TemplateID: "template-1", OrganizationID: "org-1", TemplateKey: "personal",
		Name: "Personal", Revision: 1, ModelProfileRevisionID: "model-revision-1",
		SystemPrompt: "You are helpful.", MaxModelRequests: 16,
		ContextPolicyVersion: domain.ContextPolicyV1,
		Runtime: domain.RuntimeSpecInput{
			ImageRef: "antnest/runtime@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
			Resources: domain.RuntimeResources{
				MemoryBytes: 536870912, PIDsLimit: 256, TmpfsBytes: 67108864,
			},
		},
		Enabled: true, CreatedAt: time.Unix(1, 0).UTC(), UpdatedAt: time.Unix(1, 0).UTC(),
	}
}
