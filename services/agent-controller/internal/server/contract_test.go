package server

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"runtime"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/santhosh-tekuri/jsonschema/v6"

	"github.com/tf4fun/antnest-platform/services/agent-controller/internal/application"
	"github.com/tf4fun/antnest-platform/services/agent-controller/internal/domain"
	"github.com/tf4fun/antnest-platform/services/agent-controller/internal/ports"
)

type machineControlContract struct {
	Contract       string `json:"contract"`
	Revision       int    `json:"revision"`
	Transport      string `json:"transport"`
	Trust          string `json:"trust"`
	Authentication string `json:"authentication"`
	MediaTypes     struct {
		Request  string `json:"request"`
		Response string `json:"response"`
	} `json:"media_types"`
	Schemas struct {
		Messages string `json:"messages"`
	} `json:"schemas"`
	Status    controlContractRoute                       `json:"status"`
	Resources map[string]map[string]controlContractRoute `json:"resources"`
	Enums     map[string][]string                        `json:"enums"`
	Errors    struct {
		Shape           []string        `json:"shape"`
		Response        string          `json:"response"`
		StatusByCode    map[string]int  `json:"status_by_code"`
		RetryableByCode map[string]bool `json:"retryable_by_code"`
	} `json:"errors"`
	Compatibility struct {
		UnknownRequestFields       string `json:"unknown_request_fields"`
		UnknownResponseFields      string `json:"unknown_response_fields"`
		SecretsInLogsTracesEvents  bool   `json:"secrets_in_logs_traces_events"`
		CrossServiceDatabaseAccess bool   `json:"cross_service_database_access"`
	} `json:"compatibility"`
}

type controlContractRoute struct {
	Method        string   `json:"method"`
	Path          string   `json:"path"`
	Request       string   `json:"request"`
	Response      string   `json:"response"`
	Query         []string `json:"query"`
	Headers       []string `json:"headers"`
	SuccessStatus int      `json:"success_status"`
	ContentType   string   `json:"content_type"`
	Event         string   `json:"event"`
	EventID       string   `json:"event_id"`
	Data          string   `json:"data"`
}

type machineControlSchema struct {
	Defs map[string]struct {
		Required   []string                   `json:"required"`
		Properties map[string]json.RawMessage `json:"properties"`
	} `json:"$defs"`
}

func TestMachineControlContractMatchesRegisteredBoundary(t *testing.T) {
	t.Parallel()

	root := repositoryRoot(t)
	var contract machineControlContract
	readStrictContractJSON(t, filepath.Join(root, "contracts/agent-controller/control-contract.json"), &contract)
	var schema machineControlSchema
	readContractJSON(t, filepath.Join(root, "contracts/agent-controller/control-api.schema.json"), &schema)
	if contract.Revision != 37 || contract.Trust != "verified-workload-and-caller-context" || contract.Authentication != "service-authentication.md" {
		t.Fatalf("control contract revision = %d", contract.Revision)
	}
	if contract.MediaTypes.Request != "application/json" ||
		contract.MediaTypes.Response != "application/json" {
		t.Fatalf("control contract media types = %+v", contract.MediaTypes)
	}

	endpoint, err := newBusinessHandler(t,
		&catalogServiceStub{}, &lifecycleServiceStub{}, &agentConfigurationServiceStub{},
		&agentQueryServiceStub{}, &agentEventServiceStub{}, &networkPolicyServiceStub{},
		func(context.Context) error { return nil },
	)
	if err != nil {
		t.Fatalf("new handler: %v", err)
	}
	boundary, ok := endpoint.(*businessFixture).raw.(*authenticatedMux)
	if !ok {
		t.Fatalf("handler type = %T, want authenticated native mux", endpoint)
	}
	mux := boundary.mux

	expected := make(map[string]struct{})
	for _, route := range (&handler{}).routes() {
		if strings.Contains(route.pattern, " /internal/") || strings.HasPrefix(route.pattern, "POST /rpc/agent-controller/") {
			expected[route.pattern] = struct{}{}
		}
	}
	seen := make(map[string]struct{}, len(expected))
	for resource, operations := range contract.Resources {
		for operation, route := range operations {
			key := route.Method + " " + route.Path
			if _, exists := expected[key]; !exists {
				t.Fatalf("unexpected %s.%s route %s", resource, operation, key)
			}
			if _, duplicate := seen[key]; duplicate {
				t.Fatalf("duplicate control route %s", key)
			}
			seen[key] = struct{}{}
			if route.SuccessStatus < 200 || route.SuccessStatus >= 300 {
				t.Fatalf("route %s success status = %d", key, route.SuccessStatus)
			}
			for _, reference := range []string{route.Request, route.Response, route.Data} {
				if reference != "" {
					assertKnownControlSchemaReference(t, schema, reference)
				}
			}
			request := httptest.NewRequest(route.Method, concreteControlPath(route.Path), nil)
			_, pattern := mux.Handler(request)
			if pattern != key {
				t.Fatalf("route %s is registered as %q", key, pattern)
			}
			assertControlSSEMetadata(t, route)
		}
	}
	if len(seen) != len(expected) {
		missing := make([]string, 0, len(expected)-len(seen))
		for key := range expected {
			if _, exists := seen[key]; !exists {
				missing = append(missing, key)
			}
		}
		slices.Sort(missing)
		t.Fatalf("control contract is missing routes: %v", missing)
	}
	if contract.Status.Method != http.MethodGet || contract.Status.Path != "/status" ||
		contract.Status.SuccessStatus != http.StatusOK {
		t.Fatalf("status contract = %+v", contract.Status)
	}
	statusKey := contract.Status.Method + " " + contract.Status.Path
	statusRequest := httptest.NewRequest(contract.Status.Method, contract.Status.Path, nil)
	_, statusPattern := mux.Handler(statusRequest)
	if statusPattern != statusKey {
		t.Fatalf("status route %s is registered as %q", statusKey, statusPattern)
	}
	assertKnownControlSchemaReference(t, schema, contract.Errors.Response)
	if len(contract.Errors.StatusByCode) == 0 ||
		len(contract.Errors.StatusByCode) != len(contract.Errors.RetryableByCode) {
		t.Fatalf("error mappings are incomplete: %+v", contract.Errors)
	}
	for code := range contract.Errors.StatusByCode {
		if _, exists := contract.Errors.RetryableByCode[code]; !exists {
			t.Fatalf("error %q has no retryability contract", code)
		}
	}
	for code := range contract.Errors.RetryableByCode {
		if _, exists := contract.Errors.StatusByCode[code]; !exists {
			t.Fatalf("error %q has no status contract", code)
		}
	}
	assertControlErrorContract(t, contract)
}

func TestMachineControlSchemaMatchesGoWireTypes(t *testing.T) {
	t.Parallel()

	root := repositoryRoot(t)
	compiler := compileControlSchema(
		t, filepath.Join(root, "contracts/agent-controller/control-api.schema.json"),
	)
	now := time.Date(2026, 9, 1, 0, 0, 0, 0, time.UTC)
	model := domain.ModelSpec{
		Pricing: sampleModelPricing(),
		BaseURL: "https://api.example.test/v1", Model: "example-model",
		ContextWindow: 128000, MaxOutputTokens: 8192, SupportsImages: true,
		SupportsAudio: true, SupportsPDF: true,
	}
	runtimeInput := domain.RuntimeSpecInput{
		ImageRef:   "antnest/runtime@sha256:" + strings.Repeat("a", 64),
		MCPServers: []domain.MCPServer{{ID: "documents", Command: "node", Args: []string{"server.js"}, Env: map[string]string{"TOKEN": "synthetic-token"}}},
		Resources: domain.RuntimeResources{
			MemoryBytes: 536870912, PIDsLimit: 256, TmpfsBytes: 67108864,
		},
	}
	agent := application.AgentView{
		AgentID: "agent-1", OrganizationID: "org-1", OwnerUserID: "user-1", Name: "Agent",
		DesiredState: domain.DesiredEnabled, LifecycleState: domain.AgentCreated, ActivationState: domain.ActivationEnabled, RuntimeState: domain.RuntimeAvailable,
		AccessRevision: "access-1", AgentSpecRevisionID: "spec-1",
		ExecutionRevisionID: "execution-1", LastSuccessfulExecutionRevisionID: "execution-1",
		RuntimeRevision:    "rtv_11111111111111111111111111111111",
		RuntimeExecutionID: "runtime-execution-1", RuntimeMCPEndpoint: "http://runtime:8091/mcp",
		ActiveOperationRequestID: "request-1", FailureStage: "publish", FailureCode: "example",
		Configuration: &application.AgentConfigurationView{
			TemplateID: "template-1", TemplateRevision: 1, TemplateName: "Personal",
			ModelProfileID: "model-1", ModelProfileRevisionID: "model-revision-1",
			ModelProfileRevision: 1, ModelProfileName: "Example", Model: model,
			MaxModelRequests: 12, ContextPolicyVersion: domain.ContextPolicyV1,
			Runtime: runtimeInput,
		},
		AggregateSequence: 2, CreatedAt: now, UpdatedAt: now,
	}
	operation := application.OperationView{
		RequestID: "request-1", AgentID: agent.AgentID, Kind: domain.OperationCreate,
		Phase: domain.PhaseCompleted, State: domain.OperationCompleted,
		ErrorCode: "example", ErrorDetail: "bounded", CreatedAt: now, UpdatedAt: now,
	}
	event := application.AgentEventView{
		EventID: "event-1", GlobalSequence: 1, AggregateSequence: 2, SchemaVersion: 1,
		AgentID: agent.AgentID, EventType: ports.EventAgentReady,
		OperationRequestID: operation.RequestID, TraceID: strings.Repeat("a", 32), OccurredAt: now, Data: map[string]any{"kind": "ready"},
	}

	values := map[string]any{
		"model_parameters":                   model.Parameters(),
		"provider_credential_input":          application.ProviderCredentialInput{Method: "api_key", APIKey: "synthetic"},
		"provider_model_input":               application.ProviderModelInput{ProfileKey: "model", DisplayName: "Model", Model: model.Parameters()},
		"set_agent_authorization_request":    application.SetAgentAuthorizationInput{RequestID: "defaults", AgentID: "agent", PrincipalID: "owner", ExpectedAccessRevision: "access", ExpectedAuthorizationRevision: 1, Authorization: domain.Authorization{Mode: domain.AuthorizationAuto, ToolRules: []domain.ToolRule{}}},
		"set_agent_authorization_response":   map[string]int64{"authorization_revision": 2},
		"list_workspace_agents_request":      listWorkspaceAgentsRequest{RequestID: "list", OrganizationID: "org", PrincipalID: "owner"},
		"list_workspace_agents_response":     workspaceAgentListResponse{Agents: []workspaceAgentResponse{{AgentID: "agent", Name: "Research", LifecycleState: domain.AgentCreated, ActivationState: domain.ActivationEnabled, RuntimeState: domain.RuntimeAvailable}}, NextCursor: nil},
		"create_provider_connection_request": sampleCreateProviderRequest(),
		"rotate_provider_credential_request": sampleRotateProviderRequest(),
		"provider_connection":                sampleProviderConnection(),
		"provider_connection_list":           application.ProviderConnectionPage{Items: []application.ProviderConnectionView{sampleProviderConnection()}},
		"model_input":                        model,
		"runtime_input":                      runtimeInput,
		"create_model_profile_request": createModelProfileRequest{ProviderConnectionID: "provider-1",
			RequestID: "request-1", OrganizationID: "org-1", ProfileKey: "example",
			DisplayName: "Example", Model: model.Parameters(),
		},
		"revise_model_profile_request": reviseModelProfileRequest{
			ExpectedVersion: 1,
			RequestID:       "request-1", OrganizationID: "org-1", DisplayName: "Example", Model: model.Parameters(),
		},
		"create_template_request": createTemplateRequest{
			RequestID: "request-1", OrganizationID: "org-1", TemplateKey: "personal",
			Name: "Personal", ModelProfileID: "model-1",
			SystemPrompt: "Be useful.", MaxModelRequests: 12,
			ContextPolicyVersion: domain.ContextPolicyV1, Runtime: runtimeInput,
		},
		"revise_template_request": reviseTemplateRequest{
			RequestID: "request-1", OrganizationID: "org-1",
			Name: "Personal", ModelProfileID: "model-1",
			SystemPrompt: "Be useful.", MaxModelRequests: 12,
			ContextPolicyVersion: domain.ContextPolicyV1, Runtime: runtimeInput,
		},
		"create_agent_request": createAgentRequest{
			RequestID: "request-1", OrganizationID: "org-1", ActorPrincipalID: "admin-1",
			OwnerUserID: "user-1",
			Name:        "Agent", TemplateID: "template-1", TemplateRevision: 1,
		},
		"rebuild_agent_request": rebuildAgentRequest{
			RequestID: "request-1", OrganizationID: "org-1", ActorPrincipalID: "admin-1",
			TemplateID: "template-1", TemplateRevision: 2,
		},
		"lifecycle_request": lifecycleRequest{
			RequestID: "request-1", OrganizationID: "org-1", ActorPrincipalID: "admin-1",
		},
		"model_profile": modelProfilePayload(sampleModelProfileView()),
		"model_profile_list": modelProfileListResponse{
			Items: []modelProfileResponse{modelProfilePayload(sampleModelProfileView())},
		},
		"agent_template": templatePayload(sampleTemplateView()),
		"agent_template_list": templateListResponse{
			Items: []templateResponse{templatePayload(sampleTemplateView())},
		},
		"runtime_binding": runtimeBindingResponse{
			RuntimeRevision: agent.RuntimeRevision, RuntimeExecutionID: agent.RuntimeExecutionID,
			MCPEndpoint: agent.RuntimeMCPEndpoint,
		},
		"agent":      agentPayload(agent),
		"agent_list": agentListResponse{Items: []agentResponse{agentPayload(agent)}},
		"operation":  operationPayload(operation),
		"agent_skill_preparation_status": application.SkillPreparationStatus{RequestID: "request-1", AgentID: agent.AgentID,
			Kind: domain.OperationCreate, State: "retry_wait", Progress: ports.SkillPreparationProgress{VerifiedPackages: 1, TotalPackages: 2, VerifiedBytes: 100, TotalBytes: 300}, UpdatedAt: now},
		"create_agent_response": createAgentPayload(application.CreateAgentResult{
			Agent: agent, Operation: operation,
		}),
		"agent_event": agentEventPayload(event),
		"event_list": agentEventListPayload(application.AgentEventPage{
			Events: []application.AgentEventView{event}, NextSequence: 1,
		}),
		"error": errorResponse{Code: "invalid_request", Message: "invalid", Retryable: false},
	}
	for name, value := range values {
		assertControlWireType(t, compiler, name, value)
	}
}

func TestMachineControlContractValidatesSuccessfulHTTPBoundary(t *testing.T) {
	t.Parallel()

	root := repositoryRoot(t)
	var contract machineControlContract
	readStrictContractJSON(t, filepath.Join(root, "contracts/agent-controller/control-contract.json"), &contract)
	compiler := compileControlSchema(
		t, filepath.Join(root, "contracts/agent-controller/control-api.schema.json"),
	)
	now := time.Date(2026, 9, 1, 0, 0, 0, 0, time.UTC)
	agent := sampleControlAgent(now)
	operation := sampleControlOperation(now, agent.AgentID)
	event := sampleControlEvent(now, agent.AgentID, operation.RequestID)
	catalog := &catalogServiceStub{
		modelView: sampleModelProfileView(),
		templatePage: application.TemplatePage{
			Items: []application.TemplateView{sampleTemplateView()},
		},
	}
	lifecycle := &lifecycleServiceStub{
		result: application.CreateAgentResult{
			Agent: agent, Operation: operation,
		},
		rebuildResult: application.RebuildAgentResult{Agent: agent, Operation: operation},
		disableResult: application.DisableAgentResult{Agent: agent, Operation: operation},
		enableResult:  application.EnableAgentResult{Agent: agent, Operation: operation},
		deleteResult:  application.DeleteAgentResult{Agent: agent, Operation: operation},
		operation:     operation,
		skillStatus: application.SkillPreparationStatus{RequestID: "request-1", AgentID: agent.AgentID,
			Kind: domain.OperationCreate, State: "preparing", Progress: ports.SkillPreparationProgress{TotalPackages: 1, TotalBytes: 200}, UpdatedAt: now},
	}
	queries := &agentQueryServiceStub{
		agent: agent, page: application.AgentPage{Items: []application.AgentView{agent}},
		workspacePage: application.WorkspaceAgentPage{Items: []application.WorkspaceAgentView{{AgentID: agent.AgentID, Name: agent.Name, LifecycleState: domain.AgentCreated, ActivationState: domain.ActivationEnabled, RuntimeState: domain.RuntimeAvailable}}},
	}
	events := &agentEventServiceStub{
		page: application.AgentEventPage{Events: []application.AgentEventView{event}, NextSequence: 1},
	}
	boundary, err := newBusinessHandler(t,
		catalog, lifecycle, &agentConfigurationServiceStub{}, queries, events, &networkPolicyServiceStub{},
		func(context.Context) error { return nil },
	)
	if err != nil {
		t.Fatalf("new control boundary: %v", err)
	}
	runtimeInput := sampleTemplateView().Runtime
	requestBodies := map[string]any{
		"POST /rpc/agent-controller/set-agent-authorization":              application.SetAgentAuthorizationInput{RequestID: "set-defaults", AgentID: "agent-1", PrincipalID: "user-1", ExpectedAccessRevision: "access-1", ExpectedAuthorizationRevision: 1, Authorization: domain.Authorization{Mode: domain.AuthorizationApprove, ToolRules: []domain.ToolRule{}}},
		"POST /rpc/agent-controller/list-workspace-agents":                listWorkspaceAgentsRequest{RequestID: "list-workspace", OrganizationID: "org-1", PrincipalID: "user-1"},
		"PUT /internal/provider-connections/{connection_id}/availability": map[string]any{"request_id": "provider-disable", "organization_id": "org-1", "expected_enabled": true, "enabled": false},
		"PUT /internal/model-profiles/{model_profile_id}/availability":    map[string]any{"request_id": "model-disable", "organization_id": "org-1", "expected_enabled": true, "enabled": false},
		"PUT /internal/agent-templates/{template_id}/availability":        map[string]any{"request_id": "template-disable", "organization_id": "org-1", "expected_enabled": true, "enabled": false},
		"POST /internal/provider-connections":                             sampleCreateProviderRequest(),
		"POST /internal/provider-connections/{connection_id}/credentials": sampleRotateProviderRequest(),
		"PUT /internal/agents/{agent_id}/network-policy": application.SetAgentNetworkPolicyInput{
			RequestID: "request-network", OrganizationID: "org-1", ActorPrincipalID: "admin-1",
			SetNetworkPolicy: ports.SetNetworkPolicy{NetworkPolicyReference: ports.NetworkPolicyReference{PolicyID: "builtin/allow-all", Revision: 1}, ExpectedResourceVersion: 7},
		},
		"POST /internal/model-profiles": createModelProfileRequest{ProviderConnectionID: "provider-1",
			RequestID: "request-model", OrganizationID: "org-1", ProfileKey: "deepseek",
			DisplayName: "DeepSeek", Model: sampleModelProfileView().Model.Parameters(),
		},
		"POST /internal/model-profiles/{model_profile_id}/revisions": reviseModelProfileRequest{
			ExpectedVersion: 1,
			RequestID:       "request-model-revision", OrganizationID: "org-1", DisplayName: "DeepSeek",
			Model: sampleModelProfileView().Model.Parameters(),
		},
		"POST /internal/agent-templates": createTemplateRequest{
			RequestID: "request-template", OrganizationID: "org-1", TemplateKey: "personal",
			Name: "Personal", ModelProfileID: "model-1",
			SystemPrompt: "Be useful.", MaxModelRequests: 12,
			ContextPolicyVersion: domain.ContextPolicyV1, Runtime: runtimeInput,
		},
		"POST /internal/agent-templates/{template_id}/revisions": reviseTemplateRequest{
			RequestID: "request-template-revision", OrganizationID: "org-1", Name: "Personal",
			ModelProfileID: "model-1", SystemPrompt: "Be useful.",
			MaxModelRequests: 12, ContextPolicyVersion: domain.ContextPolicyV1, Runtime: runtimeInput,
		},
		"POST /internal/agents": createAgentRequest{
			RequestID: "request-agent", OrganizationID: "org-1", ActorPrincipalID: "admin-1",
			OwnerUserID: "user-1",
			Name:        "Agent", TemplateID: "template-1", TemplateRevision: 1,
		},
		"POST /internal/agents/{agent_id}/rebuild": rebuildAgentRequest{
			RequestID: "request-rebuild", OrganizationID: "org-1", ActorPrincipalID: "admin-1",
			TemplateID: "template-1", TemplateRevision: 1,
		},
		"POST /internal/agents/{agent_id}/disable": lifecycleRequest{
			RequestID: "request-disable", OrganizationID: "org-1", ActorPrincipalID: "admin-1",
		},
		"POST /internal/agents/{agent_id}/enable": lifecycleRequest{
			RequestID: "request-enable", OrganizationID: "org-1", ActorPrincipalID: "admin-1",
		},
		"POST /internal/agents/{agent_id}/delete": lifecycleRequest{
			RequestID: "request-delete", OrganizationID: "org-1", ActorPrincipalID: "admin-1",
		},
	}

	for resource, operations := range contract.Resources {
		for operationName, route := range operations {
			if route.ContentType == "text/event-stream" {
				continue
			}
			key := route.Method + " " + route.Path
			var body io.Reader = http.NoBody
			if value, exists := requestBodies[key]; exists {
				payload, err := json.Marshal(value)
				if err != nil {
					t.Fatalf("marshal %s request: %v", key, err)
				}
				assertControlResponseSchema(t, compiler, route.Request, payload)
				body = bytes.NewReader(payload)
			} else if route.Request != "" {
				t.Fatalf("%s.%s has no executable request fixture", resource, operationName)
			}
			path := concreteControlPath(route.Path)
			if slices.Contains(route.Query, "organization_id") {
				path += "?organization_id=org-1"
			}
			if slices.Contains(route.Query, "principal_id") {
				path += "&principal_id=user-1"
			}
			request := httptest.NewRequest(route.Method, path, body)
			if slices.Contains(route.Headers, "Idempotency-Key") {
				request.Header.Set("Idempotency-Key", "control-contract-test")
			}
			if route.Request != "" {
				request.Header.Set("Content-Type", contract.MediaTypes.Request)
			}
			request.Header.Set("Accept", contract.MediaTypes.Response)
			response := httptest.NewRecorder()
			boundary.ServeHTTP(response, request)
			if response.Code != route.SuccessStatus {
				t.Fatalf("%s.%s status=%d want=%d body=%s", resource, operationName, response.Code, route.SuccessStatus, response.Body.String())
			}
			if mediaType := strings.Split(response.Header().Get("Content-Type"), ";")[0]; mediaType != contract.MediaTypes.Response {
				t.Fatalf("%s.%s content type=%q want=%q", resource, operationName, mediaType, contract.MediaTypes.Response)
			}
			assertControlResponseSchema(t, compiler, route.Response, response.Body.Bytes())
		}
	}

	status := httptest.NewRecorder()
	boundary.ServeHTTP(status, httptest.NewRequest(contract.Status.Method, contract.Status.Path, nil))
	if status.Code != contract.Status.SuccessStatus ||
		strings.Split(status.Header().Get("Content-Type"), ";")[0] != contract.MediaTypes.Response {
		t.Fatalf("status boundary code=%d content_type=%q body=%s", status.Code, status.Header().Get("Content-Type"), status.Body.String())
	}
}

func TestMachineControlContractValidatesActualHTTPErrorBoundary(t *testing.T) {
	t.Parallel()

	root := repositoryRoot(t)
	var contract machineControlContract
	readStrictContractJSON(t, filepath.Join(root, "contracts/agent-controller/control-contract.json"), &contract)
	compiler := compileControlSchema(
		t, filepath.Join(root, "contracts/agent-controller/control-api.schema.json"),
	)
	tests := []struct {
		code   string
		err    error
		method string
		path   string
		body   string
	}{
		{code: "invalid_request", method: http.MethodPost, path: "/internal/agents", body: "{"},
		{code: "resource_version_conflict", err: &ports.DependencyError{Service: "runtime-egress", Code: "resource_version_conflict"}, method: http.MethodPut, path: "/internal/agents/agent-1/network-policy", body: networkMutationJSON},
		{code: "policy_revision_not_found", err: &ports.DependencyError{Service: "runtime-egress", Code: "policy_revision_not_found"}, method: http.MethodPut, path: "/internal/agents/agent-1/network-policy", body: networkMutationJSON},
		{code: "agent_network_not_found", err: &ports.DependencyError{Service: "runtime-egress", Code: "agent_network_not_found"}, method: http.MethodPut, path: "/internal/agents/agent-1/network-policy", body: networkMutationJSON},
		{code: "agent_network_unavailable", err: &ports.DependencyError{Service: "runtime-egress", Code: "agent_network_unavailable"}, method: http.MethodPut, path: "/internal/agents/agent-1/network-policy", body: networkMutationJSON},
		{code: "cleanup_failed", err: &ports.DependencyError{Service: "runtime-egress", Code: "cleanup_failed"}, method: http.MethodPut, path: "/internal/agents/agent-1/network-policy", body: networkMutationJSON},
		{code: "dependency_invalid_response", err: &ports.DependencyError{Service: "runtime-egress", Code: "invalid_response"}, method: http.MethodPut, path: "/internal/agents/agent-1/network-policy", body: networkMutationJSON},
		{code: "request_id_conflict", err: ports.ErrRequestConflict},
		{code: "reference_not_found", err: application.ErrInvalidReference},
		{code: "reference_disabled", err: ports.ErrDisabledReference},
		{code: "resource_in_use", err: &ports.CatalogReferenceConflict{References: []ports.CatalogReference{{Kind: "template", ResourceID: "template-1"}}}},
		{code: "execution_configuration_capacity_exceeded", err: ports.ErrExecutionCapacityExceeded},
		{code: "agent_not_found", err: application.ErrAgentNotFound},
		{code: "access_denied", err: application.ErrAccessDenied},
		{code: "configuration_conflict", err: ports.ErrConcurrentChange, method: http.MethodPost, path: "/rpc/agent-controller/set-agent-authorization", body: `{"request_id":"cas","agent_id":"agent","principal_id":"owner","expected_access_revision":"access","expected_authorization_revision":1,"authorization":{"mode":"auto","tool_rules":[]}}`},
		{code: "agent_not_ready", err: application.ErrAgentNotReady},
		{code: "lifecycle_conflict", err: application.ErrLifecycleConflict},
		{
			code: "operation_not_found", err: ports.ErrNotFound,
			method: http.MethodGet,
			path:   "/internal/agent-operations/missing-operation?organization_id=org-1",
		},
		{code: "dependency_unavailable", err: application.ErrDependencyUnavailable},
		{code: "runtime_image_invalid", err: domain.ErrInvalidImageReference},
		{code: "lifecycle_timeout", err: context.DeadlineExceeded},
		{code: "internal_error", err: errors.New("unexpected failure")},
	}
	seen := make(map[string]struct{}, len(tests))
	for _, test := range tests {
		t.Run(test.code, func(t *testing.T) {
			lifecycle := &lifecycleServiceStub{err: test.err}
			boundary, err := newBusinessHandler(t,
				&catalogServiceStub{}, lifecycle, &agentConfigurationServiceStub{err: test.err}, &agentQueryServiceStub{},
				&agentEventServiceStub{}, &networkPolicyServiceStub{err: test.err},

				func(context.Context) error { return nil })

			if err != nil {
				t.Fatalf("new control boundary: %v", err)
			}
			method, path, body := test.method, test.path, test.body
			if method == "" {
				method = http.MethodPost
				path = "/internal/agents"
				body = `{"request_id":"request-error","organization_id":"org-1","actor_principal_id":"admin-1","owner_user_id":"user-1","name":"Agent","template_id":"template-1","template_revision":1}`
			}
			request := httptest.NewRequest(method, path, strings.NewReader(body))
			if body != "" {
				request.Header.Set("Content-Type", contract.MediaTypes.Request)
			}
			request.Header.Set("Accept", contract.MediaTypes.Response)
			response := httptest.NewRecorder()
			boundary.ServeHTTP(response, request)

			wantStatus, statusExists := contract.Errors.StatusByCode[test.code]
			wantRetryable, retryExists := contract.Errors.RetryableByCode[test.code]
			if !statusExists || !retryExists {
				t.Fatalf("error %q is missing contract metadata", test.code)
			}
			var payload errorResponse
			if err := json.Unmarshal(response.Body.Bytes(), &payload); err != nil {
				t.Fatalf("decode error response: %v body=%s", err, response.Body.String())
			}
			if response.Code != wantStatus || payload.Code != test.code ||
				payload.Retryable != wantRetryable {
				t.Fatalf("error boundary status=%d payload=%+v want_status=%d retryable=%v", response.Code, payload, wantStatus, wantRetryable)
			}
			if mediaType := strings.Split(response.Header().Get("Content-Type"), ";")[0]; mediaType != contract.MediaTypes.Response {
				t.Fatalf("error content type=%q", mediaType)
			}
			assertControlResponseSchema(t, compiler, contract.Errors.Response, response.Body.Bytes())
			seen[test.code] = struct{}{}
		})
	}
	for code, response := range authenticationErrorEvidence(t) {
		if contract.Errors.StatusByCode[code] != response.status || contract.Errors.RetryableByCode[code] != response.retryable {
			t.Fatalf("authentication HTTP error %s differs from contract", code)
		}
		assertControlResponseSchema(t, compiler, contract.Errors.Response, response.body)
		seen[code] = struct{}{}
	}
	if len(seen) != len(contract.Errors.StatusByCode) {
		t.Fatalf("error boundary coverage=%v contract=%v", seen, contract.Errors.StatusByCode)
	}
}

func TestMachineEventContractDeclaresReplayAndResumeInputs(t *testing.T) {
	t.Parallel()

	root := repositoryRoot(t)
	var contract struct {
		Resources struct {
			Events map[string]struct {
				Method  string   `json:"method"`
				Path    string   `json:"path"`
				Query   []string `json:"query"`
				Headers []string `json:"headers"`
			} `json:"events"`
		} `json:"resources"`
	}
	readContractJSON(t, filepath.Join(root, "contracts/agent-controller/control-contract.json"), &contract)
	if len(contract.Resources.Events) != 4 {
		t.Fatalf("event contract routes = %+v", contract.Resources.Events)
	}
	for name, route := range contract.Resources.Events {
		if route.Method != "GET" || route.Path == "" || !slices.Contains(route.Query, "after_sequence") {
			t.Fatalf("event route %s is incomplete: %+v", name, route)
		}
		if name == "watch" || name == "watch_global" {
			if !slices.Contains(route.Headers, "Last-Event-ID") {
				t.Fatalf("watch route %s omits Last-Event-ID: %+v", name, route)
			}
		}
	}
}

func TestMachineControlContractValidatesActualSSEBoundary(t *testing.T) {
	t.Parallel()

	root := repositoryRoot(t)
	var contract machineControlContract
	readStrictContractJSON(t, filepath.Join(root, "contracts/agent-controller/control-contract.json"), &contract)
	compiler := compileControlSchema(
		t, filepath.Join(root, "contracts/agent-controller/control-api.schema.json"),
	)
	now := time.Date(2026, 9, 1, 0, 0, 0, 0, time.UTC)
	event := sampleControlEvent(now, "contract-fixture", "request-1")
	event.GlobalSequence = 1

	for _, operationName := range []string{"watch_global", "watch"} {
		route := contract.Resources["events"][operationName]
		events := &agentEventServiceStub{page: application.AgentEventPage{
			Events: []application.AgentEventView{event}, NextSequence: 1,
		}}
		boundary, err := newBusinessHandler(t,
			&catalogServiceStub{}, &lifecycleServiceStub{}, &agentConfigurationServiceStub{},
			&agentQueryServiceStub{}, events, &networkPolicyServiceStub{},
			func(context.Context) error { return nil },
		)
		if err != nil {
			t.Fatalf("new SSE boundary: %v", err)
		}
		response := httptest.NewRecorder()
		path := concreteControlPath(route.Path) + "?organization_id=org-1"
		boundary.ServeHTTP(
			response, httptest.NewRequest(route.Method, path, nil),
		)
		if response.Code != route.SuccessStatus ||
			strings.Split(response.Header().Get("Content-Type"), ";")[0] != route.ContentType {
			t.Fatalf("%s status=%d content_type=%q body=%s", operationName, response.Code, response.Header().Get("Content-Type"), response.Body.String())
		}
		frame := strings.SplitN(response.Body.String(), "\n\n", 2)[0]
		fields := make(map[string]string)
		for _, line := range strings.Split(frame, "\n") {
			key, value, ok := strings.Cut(line, ":")
			if ok {
				fields[key] = strings.TrimSpace(value)
			}
		}
		if fields["event"] != route.Event || fields["id"] != "1" {
			t.Fatalf("%s SSE frame fields=%v", operationName, fields)
		}
		payload := []byte(fields["data"])
		assertControlResponseSchema(t, compiler, route.Data, payload)
		var decoded map[string]any
		if err := json.Unmarshal(payload, &decoded); err != nil || decoded[route.EventID] != float64(1) {
			t.Fatalf("%s SSE event ID payload=%v err=%v", operationName, decoded, err)
		}
	}
}

func TestMachineEventTypesMatchProducerContract(t *testing.T) {
	t.Parallel()

	root := repositoryRoot(t)
	var schema struct {
		Defs map[string]struct {
			Properties map[string]struct {
				Enum []string `json:"enum"`
			} `json:"properties"`
		} `json:"$defs"`
	}
	readContractJSON(t, filepath.Join(root, "contracts/agent-controller/control-api.schema.json"), &schema)
	actual := schema.Defs["agent_event"].Properties["event_type"].Enum
	expected := []string{
		ports.EventAgentCreateRequested,
		ports.EventAgentCreated,
		ports.EventAgentReady,
		ports.EventAgentBuildFailed,
		ports.EventAgentRebuildRequested,
		ports.EventAgentRebuilt,
		ports.EventAgentDisableRequested,
		ports.EventAgentDisabled,
		ports.EventAgentDisableFailed,
		ports.EventAgentEnableRequested,
		ports.EventAgentEnabled,
		ports.EventAgentEnableFailed,
		ports.EventAgentDeleteRequested,
		ports.EventAgentDeleted,
		ports.EventAgentLifecycleQuarantined,
		ports.EventAgentRuntimeRestarted,
		ports.EventAgentRuntimeMissing,
		ports.EventAgentRuntimeConditionChanged,
		ports.EventAgentOwnerRevoked,
		ports.EventAgentAuthorizationUpdated,
	}
	if !slices.Equal(actual, expected) {
		t.Fatalf("event type schema=%v producers=%v", actual, expected)
	}
	var contract machineControlContract
	readStrictContractJSON(t, filepath.Join(root, "contracts/agent-controller/control-contract.json"), &contract)
	declared := contract.Enums["event_type"]
	slices.Sort(declared)
	slices.Sort(expected)
	if !slices.Equal(declared, expected) {
		t.Fatalf("event type manifest=%v producers=%v", declared, expected)
	}
}

func repositoryRoot(t *testing.T) string {
	t.Helper()
	_, file, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("resolve contract test path")
	}
	return filepath.Clean(filepath.Join(filepath.Dir(file), "../../../.."))
}

func readContractJSON(t *testing.T, path string, target any) {
	t.Helper()
	payload, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal(payload, target); err != nil {
		t.Fatalf("parse %s: %v", path, err)
	}
}

func readStrictContractJSON(t *testing.T, path string, target any) {
	t.Helper()
	payload, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	decoder := json.NewDecoder(bytes.NewReader(payload))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(target); err != nil {
		t.Fatalf("parse strict %s: %v", path, err)
	}
	if err := decoder.Decode(&struct{}{}); !errors.Is(err, io.EOF) {
		t.Fatalf("parse strict %s trailing data: %v", path, err)
	}
}

func assertKnownControlSchemaReference(
	t *testing.T, schema machineControlSchema, reference string,
) {
	t.Helper()
	const prefix = "control-api.schema.json#/$defs/"
	if !strings.HasPrefix(reference, prefix) {
		t.Fatalf("unknown control schema reference %q", reference)
	}
	name := strings.TrimPrefix(reference, prefix)
	if _, exists := schema.Defs[name]; !exists {
		t.Fatalf("control schema reference %q does not exist", reference)
	}
}

func concreteControlPath(pattern string) string {
	segments := strings.Split(pattern, "/")
	for index, segment := range segments {
		if strings.HasPrefix(segment, "{") && strings.HasSuffix(segment, "}") {
			if segment == "{revision}" {
				segments[index] = "1"
			} else {
				segments[index] = "contract-fixture"
			}
		}
	}
	return strings.Join(segments, "/")
}

func assertControlWireType(
	t *testing.T, compiler *jsonschema.Compiler, name string, value any,
) {
	t.Helper()
	definition, err := compiler.Compile(controlSchemaID + "#/$defs/" + name)
	if err != nil {
		t.Fatalf("compile control schema definition %q: %v", name, err)
	}
	payload, err := json.Marshal(value)
	if err != nil {
		t.Fatalf("marshal %s wire type: %v", name, err)
	}
	instance, err := jsonschema.UnmarshalJSON(bytes.NewReader(payload))
	if err != nil {
		t.Fatalf("decode %s wire type: %v", name, err)
	}
	if err := definition.Validate(instance); err != nil {
		t.Fatalf("Go wire type for %s violates control schema: %v\n%s", name, err, payload)
	}
}

const controlSchemaID = "https://antnest.local/agent-controller/control-api.schema.json"
const draft202012Schema = "https://json-schema.org/draft/2020-12/schema"

func assertControlSSEMetadata(t *testing.T, route controlContractRoute) {
	t.Helper()
	if route.ContentType != "text/event-stream" {
		return
	}
	if route.Event == "" || route.Data == "" {
		t.Fatalf("incomplete SSE contract: %+v", route)
	}
	if route.EventID == "" {
		t.Fatalf("journal SSE requires an event ID: %+v", route)
	}
}

func compileControlSchema(t *testing.T, path string) *jsonschema.Compiler {
	t.Helper()
	payload, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	var metadata struct {
		Dialect string `json:"$schema"`
	}
	if err := json.Unmarshal(payload, &metadata); err != nil {
		t.Fatalf("decode control schema metadata: %v", err)
	}
	if metadata.Dialect != draft202012Schema {
		t.Fatalf("control schema dialect = %q", metadata.Dialect)
	}
	document, err := jsonschema.UnmarshalJSON(bytes.NewReader(payload))
	if err != nil {
		t.Fatalf("decode control schema: %v", err)
	}
	compiler := jsonschema.NewCompiler()
	compiler.AssertFormat()
	var runtimeContract any
	readContractJSON(t, filepath.Join(repositoryRoot(t), "contracts/runtime/runtime-spec.schema.json"), &runtimeContract)
	if err := compiler.AddResource("https://antnest.local/runtime/runtime-spec.schema.json", runtimeContract); err != nil {
		t.Fatalf("load Runtime MCP contract: %v", err)
	}
	var runtimeControllerContract any
	readContractJSON(t, filepath.Join(repositoryRoot(t), "services/runtime-controller/api/control-api.schema.json"), &runtimeControllerContract)
	if err := compiler.AddResource("https://antnest.local/runtime-controller/api/control-api.schema.json", runtimeControllerContract); err != nil {
		t.Fatalf("load Runtime Controller contract: %v", err)
	}
	if err := compiler.AddResource(controlSchemaID, document); err != nil {
		t.Fatalf("load control schema: %v", err)
	}
	if _, err := compiler.Compile(controlSchemaID); err != nil {
		t.Fatalf("compile control schema: %v", err)
	}
	return compiler
}

func assertControlResponseSchema(
	t *testing.T, compiler *jsonschema.Compiler, reference string, payload []byte,
) {
	t.Helper()
	const prefix = "control-api.schema.json"
	if !strings.HasPrefix(reference, prefix+"#/$defs/") {
		t.Fatalf("unknown control response schema %q", reference)
	}
	definition, err := compiler.Compile(controlSchemaID + strings.TrimPrefix(reference, prefix))
	if err != nil {
		t.Fatalf("compile response schema %q: %v", reference, err)
	}
	instance, err := jsonschema.UnmarshalJSON(bytes.NewReader(payload))
	if err != nil {
		t.Fatalf("decode control response: %v\n%s", err, payload)
	}
	if err := definition.Validate(instance); err != nil {
		t.Fatalf("control response violates %q: %v\n%s", reference, err, payload)
	}
}

func sampleControlAgent(now time.Time) application.AgentView {
	return application.AgentView{
		AgentID: "agent-1", OrganizationID: "org-1", OwnerUserID: "user-1", Name: "Agent",
		DesiredState: domain.DesiredEnabled, LifecycleState: domain.AgentCreated, ActivationState: domain.ActivationEnabled, RuntimeState: domain.RuntimeAvailable,
		AccessRevision: "access-1", AgentSpecRevisionID: "spec-1",
		ExecutionRevisionID: "execution-1", LastSuccessfulExecutionRevisionID: "execution-1",
		RuntimeRevision:    "rtv_11111111111111111111111111111111",
		RuntimeExecutionID: "runtime-execution-1", RuntimeMCPEndpoint: "http://runtime:8091/mcp",
		ActiveOperationRequestID: "request-1", FailureStage: "publish", FailureCode: "example",
		AggregateSequence: 2, CreatedAt: now, UpdatedAt: now,
	}
}

func sampleControlOperation(now time.Time, agentID string) application.OperationView {
	return application.OperationView{
		RequestID: "request-1", AgentID: agentID, Kind: domain.OperationCreate,
		Phase: domain.PhaseCompleted, State: domain.OperationCompleted,
		ErrorCode: "example", ErrorDetail: "bounded", CreatedAt: now, UpdatedAt: now,
	}
}

func sampleControlEvent(
	now time.Time, agentID string, operationRequestID string,
) application.AgentEventView {
	return application.AgentEventView{
		EventID: "event-1", GlobalSequence: 1, AggregateSequence: 2, SchemaVersion: 1,
		AgentID: agentID, EventType: ports.EventAgentReady,
		OperationRequestID: operationRequestID, TraceID: strings.Repeat("a", 32), OccurredAt: now, Data: map[string]any{"kind": "ready"},
	}
}

func assertControlErrorContract(t *testing.T, contract machineControlContract) {
	t.Helper()
	behaviors := []error{
		application.ErrAccessDenied,
		application.ErrInvalidInput,
		domain.ErrInvalidImageReference,
		ports.ErrRequestConflict,
		application.ErrInvalidReference,
		ports.ErrDisabledReference,
		&ports.CatalogReferenceConflict{References: []ports.CatalogReference{{Kind: "template", ResourceID: "template-1"}}},
		ports.ErrExecutionCapacityExceeded,
		application.ErrAgentNotFound,
		application.ErrAgentNotReady,
		application.ErrLifecycleConflict,
		application.ErrDependencyUnavailable,
		context.DeadlineExceeded,
		errors.New("unexpected failure"),
	}
	seen := make(map[string]struct{})
	for _, behavior := range behaviors {
		status, response := publicError(behavior)
		if contract.Errors.StatusByCode[response.Code] != status {
			t.Fatalf("error %q status contract=%d behavior=%d", response.Code, contract.Errors.StatusByCode[response.Code], status)
		}
		if retryable, exists := contract.Errors.RetryableByCode[response.Code]; !exists || retryable != response.Retryable {
			t.Fatalf("error %q retryability contract=%v/%v behavior=%v", response.Code, retryable, exists, response.Retryable)
		}
		seen[response.Code] = struct{}{}
	}
	if contract.Errors.StatusByCode["operation_not_found"] != http.StatusNotFound ||
		contract.Errors.RetryableByCode["operation_not_found"] {
		t.Fatalf(
			"operation_not_found contract status=%d retryable=%v",
			contract.Errors.StatusByCode["operation_not_found"],
			contract.Errors.RetryableByCode["operation_not_found"],
		)
	}
	seen["operation_not_found"] = struct{}{}
	for _, code := range []string{"resource_version_conflict", "policy_revision_not_found", "agent_network_not_found", "agent_network_unavailable", "cleanup_failed", "invalid_response"} {
		status, payload := publicNetworkPolicyError(&ports.DependencyError{Service: "runtime-egress", Code: code})
		if contract.Errors.StatusByCode[payload.Code] != status || contract.Errors.RetryableByCode[payload.Code] != payload.Retryable {
			t.Fatalf("network error %s does not match contract: %d %+v", code, status, payload)
		}
		seen[payload.Code] = struct{}{}
	}
	response := httptest.NewRecorder()
	writeAgentConfigurationError(context.Background(), response, ports.ErrConcurrentChange)
	var payload errorResponse
	if err := json.Unmarshal(response.Body.Bytes(), &payload); err != nil {
		t.Fatal(err)
	}
	if response.Code != contract.Errors.StatusByCode[payload.Code] || payload.Retryable != contract.Errors.RetryableByCode[payload.Code] {
		t.Fatalf("configuration error differs from management contract: %d %+v", response.Code, payload)
	}
	seen[payload.Code] = struct{}{}
	for code, response := range authenticationErrorEvidence(t) {
		if contract.Errors.StatusByCode[code] != response.status || contract.Errors.RetryableByCode[code] != response.retryable {
			t.Fatalf("authentication error %s differs from contract: %+v", code, response)
		}
		seen[code] = struct{}{}
	}
	if len(seen) != len(contract.Errors.StatusByCode) {
		missing := make([]string, 0)
		for code := range contract.Errors.StatusByCode {
			if _, exists := seen[code]; !exists {
				missing = append(missing, code)
			}
		}
		slices.Sort(missing)
		t.Fatalf("control error contract has no executable behavior evidence: %v", missing)
	}
}
