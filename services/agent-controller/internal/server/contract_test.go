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

	"soft/antnest-platform/services/agent-controller/internal/application"
	"soft/antnest-platform/services/agent-controller/internal/domain"
	"soft/antnest-platform/services/agent-controller/internal/ports"
)

type machineControlContract struct {
	Contract  string `json:"contract"`
	Revision  int    `json:"revision"`
	Transport string `json:"transport"`
	Trust     string `json:"trust"`
	Schemas   struct {
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

	expected := make(map[string]struct{})
	for _, route := range (&handler{}).routes() {
		if strings.Contains(route.pattern, " /internal/") {
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
			Agent: agent, AgentAccessSubject: "access-subject-1", Operation: operation,
		},
		rebuildResult: application.RebuildAgentResult{Agent: agent, Operation: operation},
		disableResult: application.DisableAgentResult{Agent: agent, Operation: operation},
		enableResult:  application.EnableAgentResult{Agent: agent, Operation: operation},
		deleteResult:  application.DeleteAgentResult{Agent: agent, Operation: operation},
		operation:     operation,
	}
	queries := &agentQueryServiceStub{
		agent: agent, page: application.AgentPage{Items: []application.AgentView{agent}},
	}
	events := &agentEventServiceStub{
		page: application.AgentEventPage{Events: []application.AgentEventView{event}, NextSequence: 1},
	}
	boundary, err := NewHandler(
		catalog, lifecycle, &runServiceStub{}, queries, events,
		func(context.Context) error { return nil },
	)
	if err != nil {
		t.Fatalf("new control boundary: %v", err)
	}
	runtimeInput := sampleTemplateView().Runtime
	requestBodies := map[string]any{
		"POST /internal/model-profiles": createModelProfileRequest{
			RequestID: "request-model", OrganizationID: "org-1", ProfileKey: "deepseek",
			DisplayName: "DeepSeek", Model: sampleModelProfileView().Model,
			Credential: credentialInput{SecretType: "bearer", Secret: "secret"},
		},
		"POST /internal/model-profiles/{model_profile_id}/revisions": reviseModelProfileRequest{
			RequestID: "request-model-revision", DisplayName: "DeepSeek",
			Model:      sampleModelProfileView().Model,
			Credential: credentialInput{SecretType: "bearer", Secret: "secret"},
		},
		"POST /internal/agent-templates": createTemplateRequest{
			RequestID: "request-template", OrganizationID: "org-1", TemplateKey: "personal",
			Name: "Personal", ModelProfileRevisionID: "model-revision-1",
			SystemPrompt: "Be useful.", MaxModelRequests: 12,
			ContextPolicyVersion: domain.ContextPolicyV1, Runtime: runtimeInput,
		},
		"POST /internal/agent-templates/{template_id}/revisions": reviseTemplateRequest{
			RequestID: "request-template-revision", Name: "Personal",
			ModelProfileRevisionID: "model-revision-1", SystemPrompt: "Be useful.",
			MaxModelRequests: 12, ContextPolicyVersion: domain.ContextPolicyV1, Runtime: runtimeInput,
		},
		"POST /internal/agents": createAgentRequest{
			RequestID: "request-agent", OrganizationID: "org-1", OwnerUserID: "user-1",
			Name: "Agent", TemplateID: "template-1", TemplateRevision: 1,
		},
		"POST /internal/agents/{agent_id}/rebuild": rebuildAgentRequest{
			RequestID: "request-rebuild", TemplateID: "template-1", TemplateRevision: 1,
		},
		"POST /internal/agents/{agent_id}/disable": lifecycleRequest{RequestID: "request-disable"},
		"POST /internal/agents/{agent_id}/enable":  lifecycleRequest{RequestID: "request-enable"},
		"POST /internal/agents/{agent_id}/delete":  lifecycleRequest{RequestID: "request-delete"},
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
				body = bytes.NewReader(payload)
			} else if route.Request != "" {
				t.Fatalf("%s.%s has no executable request fixture", resource, operationName)
			}
			path := concreteControlPath(route.Path)
			switch key {
			case "GET /internal/model-profiles", "GET /internal/agent-templates", "GET /internal/agents":
				path += "?organization_id=org-1"
			}
			request := httptest.NewRequest(route.Method, path, body)
			response := httptest.NewRecorder()
			boundary.ServeHTTP(response, request)
			if response.Code != route.SuccessStatus {
				t.Fatalf("%s.%s status=%d want=%d body=%s", resource, operationName, response.Code, route.SuccessStatus, response.Body.String())
			}
			if mediaType := strings.Split(response.Header().Get("Content-Type"), ";")[0]; mediaType != "application/json" {
				t.Fatalf("%s.%s content type=%q", resource, operationName, mediaType)
			}
			assertControlResponseSchema(t, compiler, route.Response, response.Body.Bytes())
		}
	}

	status := httptest.NewRecorder()
	boundary.ServeHTTP(status, httptest.NewRequest(contract.Status.Method, contract.Status.Path, nil))
	if status.Code != contract.Status.SuccessStatus ||
		strings.Split(status.Header().Get("Content-Type"), ";")[0] != "application/json" {
		t.Fatalf("status boundary code=%d content_type=%q body=%s", status.Code, status.Header().Get("Content-Type"), status.Body.String())
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
			segments[index] = "contract-fixture"
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

func compileControlSchema(t *testing.T, path string) *jsonschema.Compiler {
	t.Helper()
	payload, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	document, err := jsonschema.UnmarshalJSON(bytes.NewReader(payload))
	if err != nil {
		t.Fatalf("decode control schema: %v", err)
	}
	compiler := jsonschema.NewCompiler()
	compiler.AssertFormat()
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
		DesiredState: domain.DesiredEnabled, LifecycleState: domain.AgentAvailable,
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
		OperationRequestID: operationRequestID, AdmissionID: "admission-1",
		TraceID: strings.Repeat("a", 32), OccurredAt: now, Data: map[string]any{"kind": "ready"},
	}
}

func assertControlErrorContract(t *testing.T, contract machineControlContract) {
	t.Helper()
	behaviors := []error{
		application.ErrInvalidInput,
		ports.ErrRequestConflict,
		application.ErrInvalidReference,
		ports.ErrDisabledReference,
		application.ErrAgentNotFound,
		application.ErrAgentNotReady,
		application.ErrLifecycleConflict,
		application.ErrDependencyUnavailable,
		context.DeadlineExceeded,
		errors.New("unexpected failure"),
	}
	seen := map[string]struct{}{"operation_not_found": {}}
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
