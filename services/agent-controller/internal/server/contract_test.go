package server

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"runtime"
	"slices"
	"strings"
	"testing"
	"time"

	"soft/antnest-platform/services/agent-controller/internal/application"
	"soft/antnest-platform/services/agent-controller/internal/domain"
	"soft/antnest-platform/services/agent-controller/internal/ports"
)

type machineControlContract struct {
	Revision  int                                        `json:"revision"`
	Status    controlContractRoute                       `json:"status"`
	Resources map[string]map[string]controlContractRoute `json:"resources"`
	Errors    struct {
		Response        string          `json:"response"`
		StatusByCode    map[string]int  `json:"status_by_code"`
		RetryableByCode map[string]bool `json:"retryable_by_code"`
	} `json:"errors"`
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
	readContractJSON(t, filepath.Join(root, "contracts/agent-controller/control-contract.json"), &contract)
	var schema machineControlSchema
	readContractJSON(t, filepath.Join(root, "contracts/agent-controller/control-api.schema.json"), &schema)
	if contract.Revision != 3 {
		t.Fatalf("control contract revision = %d", contract.Revision)
	}

	endpoint, err := NewHandler(
		&catalogServiceStub{}, &lifecycleServiceStub{}, &runServiceStub{},
		&agentQueryServiceStub{}, &agentEventServiceStub{}, func(context.Context) error { return nil },
	)
	if err != nil {
		t.Fatalf("new handler: %v", err)
	}
	mux, ok := endpoint.(*http.ServeMux)
	if !ok {
		t.Fatalf("handler type = %T, want *http.ServeMux", endpoint)
	}

	expected := map[string]struct{}{
		"POST /internal/model-profiles":                              {},
		"GET /internal/model-profiles":                               {},
		"GET /internal/model-profiles/{model_profile_id}":            {},
		"POST /internal/model-profiles/{model_profile_id}/revisions": {},
		"POST /internal/agent-templates":                             {},
		"GET /internal/agent-templates":                              {},
		"GET /internal/agent-templates/{template_id}":                {},
		"POST /internal/agent-templates/{template_id}/revisions":     {},
		"POST /internal/agents":                                      {},
		"GET /internal/agents":                                       {},
		"GET /internal/agents/{agent_id}":                            {},
		"POST /internal/agents/{agent_id}/rebuild":                   {},
		"POST /internal/agents/{agent_id}/disable":                   {},
		"POST /internal/agents/{agent_id}/enable":                    {},
		"POST /internal/agents/{agent_id}/delete":                    {},
		"GET /internal/agent-operations/{request_id}":                {},
		"GET /internal/agent-events":                                 {},
		"GET /internal/agent-events/watch":                           {},
		"GET /internal/agents/{agent_id}/events":                     {},
		"GET /internal/agents/{agent_id}/events/watch":               {},
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
			if route.ContentType == "text/event-stream" &&
				(route.Event == "" || route.EventID == "" || route.Data == "") {
				t.Fatalf("SSE route %s is incomplete: %+v", key, route)
			}
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
	assertKnownControlSchemaReference(t, schema, contract.Errors.Response)
	if len(contract.Errors.StatusByCode) == 0 ||
		len(contract.Errors.StatusByCode) != len(contract.Errors.RetryableByCode) {
		t.Fatalf("error mappings are incomplete: %+v", contract.Errors)
	}
}

func TestMachineControlSchemaMatchesGoWireTypes(t *testing.T) {
	t.Parallel()

	root := repositoryRoot(t)
	var schema machineControlSchema
	readContractJSON(t, filepath.Join(root, "contracts/agent-controller/control-api.schema.json"), &schema)
	now := time.Date(2026, 9, 1, 0, 0, 0, 0, time.UTC)
	model := domain.ModelSpec{
		BaseURL: "https://api.example.test/v1", Model: "example-model",
		ContextWindow: 128000, MaxOutputTokens: 8192, SupportsImages: true,
	}
	runtimeInput := domain.RuntimeSpecInput{
		ImageRef: "antnest/runtime@sha256:" + strings.Repeat("a", 64),
		Resources: domain.RuntimeResources{
			MemoryBytes: 536870912, PIDsLimit: 256, TmpfsBytes: 67108864,
		},
	}
	agent := application.AgentView{
		AgentID: "agent-1", OrganizationID: "org-1", OwnerUserID: "user-1", Name: "Agent",
		DesiredState: domain.DesiredEnabled, LifecycleState: domain.AgentAvailable,
		AccessRevision: "access-1", AgentSpecRevisionID: "spec-1",
		ExecutionRevisionID: "execution-1", LastSuccessfulExecutionRevisionID: "execution-1",
		RuntimeRevision:    "rtv_11111111111111111111111111111111",
		RuntimeExecutionID: "runtime-execution-1", RuntimeMCPEndpoint: "http://runtime:8091/mcp",
		ActiveOperationRequestID: "request-1", FailureStage: "publish", FailureCode: "example",
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
		OperationRequestID: operation.RequestID, AdmissionID: "admission-1",
		TraceID: strings.Repeat("a", 32), OccurredAt: now, Data: map[string]any{"kind": "ready"},
	}

	values := map[string]any{
		"model_input":   model,
		"runtime_input": runtimeInput,
		"create_model_profile_request": createModelProfileRequest{
			RequestID: "request-1", OrganizationID: "org-1", ProfileKey: "example",
			DisplayName: "Example", Model: model,
			Credential: credentialInput{SecretType: "bearer", Secret: "secret"},
		},
		"revise_model_profile_request": reviseModelProfileRequest{
			RequestID: "request-1", DisplayName: "Example", Model: model,
			Credential: credentialInput{SecretType: "bearer", Secret: "secret"},
		},
		"create_template_request": createTemplateRequest{
			RequestID: "request-1", OrganizationID: "org-1", TemplateKey: "personal",
			Name: "Personal", ModelProfileRevisionID: "model-revision-1",
			SystemPrompt: "Be useful.", MaxModelRequests: 12,
			ContextPolicyVersion: domain.ContextPolicyV1, Runtime: runtimeInput,
		},
		"revise_template_request": reviseTemplateRequest{
			RequestID: "request-1", Name: "Personal", ModelProfileRevisionID: "model-revision-1",
			SystemPrompt: "Be useful.", MaxModelRequests: 12,
			ContextPolicyVersion: domain.ContextPolicyV1, Runtime: runtimeInput,
		},
		"create_agent_request": createAgentRequest{
			RequestID: "request-1", OrganizationID: "org-1", OwnerUserID: "user-1",
			Name: "Agent", TemplateID: "template-1", TemplateRevision: 1,
		},
		"rebuild_agent_request": rebuildAgentRequest{
			RequestID: "request-1", TemplateID: "template-1", TemplateRevision: 2,
		},
		"lifecycle_request": lifecycleRequest{RequestID: "request-1"},
		"model_profile":     modelProfilePayload(sampleModelProfileView()),
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
		"create_agent_response": createAgentPayload(application.CreateAgentResult{
			Agent: agent, AgentAccessSubject: "access-subject-1", Operation: operation,
		}),
		"agent_event": agentEventPayload(event),
		"event_list": agentEventListPayload(application.AgentEventPage{
			Events: []application.AgentEventView{event}, NextSequence: 1,
		}),
		"error": errorResponse{Code: "invalid_request", Message: "invalid", Retryable: false},
	}
	for name, value := range values {
		assertControlWireType(t, schema, name, value)
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
		ports.EventRunAdmissionReleased,
		ports.EventRunAdmissionUnresolved,
	}
	if !slices.Equal(actual, expected) {
		t.Fatalf("event type schema=%v producers=%v", actual, expected)
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
			segments[index] = "contract-fixture"
		}
	}
	return strings.Join(segments, "/")
}

func assertControlWireType(
	t *testing.T, schema machineControlSchema, name string, value any,
) {
	t.Helper()
	definition, exists := schema.Defs[name]
	if !exists {
		t.Fatalf("control schema definition %q does not exist", name)
	}
	payload, err := json.Marshal(value)
	if err != nil {
		t.Fatalf("marshal %s wire type: %v", name, err)
	}
	var object map[string]json.RawMessage
	if err := json.Unmarshal(payload, &object); err != nil {
		t.Fatalf("decode %s wire type: %v", name, err)
	}
	for _, field := range definition.Required {
		if _, exists := object[field]; !exists {
			t.Fatalf("Go wire type for %s omits required field %s: %s", name, field, payload)
		}
	}
	for field := range object {
		if _, exists := definition.Properties[field]; !exists {
			t.Fatalf("Go wire type for %s emits unknown field %s: %s", name, field, payload)
		}
	}
}
