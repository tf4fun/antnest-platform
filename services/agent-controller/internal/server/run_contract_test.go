package server

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/santhosh-tekuri/jsonschema/v6"

	"soft/antnest-platform/services/agent-controller/internal/application"
	"soft/antnest-platform/services/agent-controller/internal/domain"
	"soft/antnest-platform/services/agent-controller/internal/ports"
)

type machineRunContract struct {
	Contract      string                     `json:"contract"`
	Revision      int                        `json:"revision"`
	Transport     string                     `json:"transport"`
	Trust         string                     `json:"trust"`
	SchemaDialect string                     `json:"schema_dialect"`
	BasePath      string                     `json:"base_path"`
	Status        machineRunRoute            `json:"status"`
	Error         machineRunError            `json:"error"`
	Methods       map[string]machineRunRoute `json:"methods"`
}

type machineRunRoute struct {
	Method              string          `json:"method"`
	Path                string          `json:"path"`
	SuccessStatus       int             `json:"success_status"`
	RequestContentType  string          `json:"request_content_type"`
	ResponseContentType string          `json:"response_content_type"`
	Request             json.RawMessage `json:"request"`
	Response            json.RawMessage `json:"response"`
}

type machineRunError struct {
	Type                string                     `json:"type"`
	ResponseContentType string                     `json:"response_content_type"`
	StatusByCode        map[string]int             `json:"status_by_code"`
	RetryableByCode     map[string]bool            `json:"retryable_by_code"`
	Required            []string                   `json:"required"`
	Properties          map[string]json.RawMessage `json:"properties"`
	Additional          bool                       `json:"additionalProperties"`
}

func TestMachineRunContractMatchesRegisteredBoundary(t *testing.T) {
	t.Parallel()

	contract := readMachineRunContract(t)
	if contract.Revision != 6 || contract.SchemaDialect != draft202012Schema ||
		contract.BasePath != "/rpc/agent-controller" {
		t.Fatalf("Run contract identity = %+v", contract)
	}
	boundary, err := NewHandler(
		&catalogServiceStub{}, &lifecycleServiceStub{}, &runServiceStub{},
		&agentQueryServiceStub{}, &agentEventServiceStub{}, func(context.Context) error { return nil },
	)
	if err != nil {
		t.Fatalf("new Run boundary: %v", err)
	}
	mux, ok := boundary.(*http.ServeMux)
	if !ok {
		t.Fatalf("handler type = %T, want *http.ServeMux", boundary)
	}

	want := make(map[string]struct{})
	for _, route := range (&handler{}).routes() {
		if strings.Contains(route.pattern, " "+contract.BasePath+"/") {
			want[route.pattern] = struct{}{}
		}
	}
	seen := make(map[string]struct{}, len(contract.Methods)+1)
	assertMachineRunRoute(t, mux, contract.BasePath, "status", contract.Status, false, seen)
	for name, route := range contract.Methods {
		assertMachineRunRoute(t, mux, contract.BasePath, name, route, true, seen)
	}
	if len(seen) != len(want) {
		missing := make([]string, 0)
		for route := range want {
			if _, exists := seen[route]; !exists {
				missing = append(missing, route)
			}
		}
		slices.Sort(missing)
		t.Fatalf("Run contract is missing registered routes: %v", missing)
	}
	assertMachineRunErrorMetadata(t, contract.Error)
}

func TestMachineRunContractValidatesActualHTTPBoundary(t *testing.T) {
	t.Parallel()

	contract := readMachineRunContract(t)
	now := time.Date(2026, 9, 1, 0, 0, 0, 0, time.UTC)
	runs := &runServiceStub{
		access: application.AgentAccessView{
			PrincipalID: "user-1", AgentID: "agent-1", AccessRevision: "access-1",
			PromptCapabilities: ports.PromptCapabilities{Image: true, EmbeddedContext: true},
		},
		acquired: application.AcquireRunResult{
			AdmissionID: "admission-1", AdmissionDeadline: now.Add(time.Minute),
			AgentSpecRevision: "spec-1", ExecutionRevision: "execution-1",
			RuntimeMCPSourceDigest:   strings.Repeat("a", 64),
			AgentExecutionSpecDigest: strings.Repeat("b", 64), CredentialVersion: "version-1",
			Runtime: ports.AdmittedRuntime{
				RuntimeRevision: "runtime-1", RuntimeExecutionID: "runtime-execution-1",
				MCPEndpoint: "http://runtime-1:8091/mcp",
			},
			ExecutionSpec: ports.AdmittedExecutionSpec{
				SystemPrompt: "Useful", ContextPolicyVersion: domain.ContextPolicyV1,
				SkillInstructions: []ports.SkillInstruction{}, Model: domain.ModelSpec{
					BaseURL: "https://model.example/v1", Model: "model-1",
					ContextWindow: 32768, MaxOutputTokens: 4096,
				},
				MaxModelRequests: 16, CredentialRef: "credential-1",
			},
		},
		credential: application.CredentialView{
			CredentialVersion: "version-1", SecretType: "bearer", Secret: "secret-1",
		},
		finished: application.FinishRunResult{
			Status: "finished", AdmissionState: domain.AdmissionReleased,
		},
	}
	boundary, err := NewHandler(
		&catalogServiceStub{}, &lifecycleServiceStub{}, runs,
		&agentQueryServiceStub{}, &agentEventServiceStub{}, func(context.Context) error { return nil },
	)
	if err != nil {
		t.Fatalf("new Run boundary: %v", err)
	}
	requestBodies := map[string]string{
		"resolve_agent_access": `{"request_id":"request-access","agent_access_subject":"subject-1"}`,
		"acquire_run":          `{"request_id":"request-acquire","agent_id":"agent-1","principal_id":"user-1","expected_access_revision":"access-1","session_id":"session-1"}`,
		"resolve_credential":   `{"request_id":"request-credential","admission_id":"admission-1","credential_ref":"credential-1"}`,
		"finish_run":           `{"request_id":"request-finish","admission_id":"admission-1","terminal_class":"completed","tool_effect_state":"settled","stop_reason":"end_turn","error_class":null}`,
	}

	status := httptest.NewRecorder()
	boundary.ServeHTTP(status, httptest.NewRequest(
		contract.Status.Method, contract.BasePath+contract.Status.Path, nil,
	))
	assertMachineRunHTTPResponse(t, contract, "status", contract.Status, status)
	for name, route := range contract.Methods {
		body, exists := requestBodies[name]
		if !exists {
			t.Fatalf("Run method %q has no request fixture", name)
		}
		assertInlineRunSchema(t, contract, name+" request", route.Request, []byte(body))
		request := httptest.NewRequest(
			route.Method, contract.BasePath+route.Path, strings.NewReader(body),
		)
		request.Header.Set("Content-Type", route.RequestContentType)
		request.Header.Set("Accept", route.ResponseContentType)
		response := httptest.NewRecorder()
		boundary.ServeHTTP(response, request)
		assertMachineRunHTTPResponse(t, contract, name, route, response)
	}
}

func TestMachineRunContractValidatesActualHTTPErrorBoundary(t *testing.T) {
	t.Parallel()

	contract := readMachineRunContract(t)
	tests := []struct {
		code string
		err  error
	}{
		{code: "access_denied", err: application.ErrAccessDenied},
		{code: "agent_not_found", err: application.ErrAgentNotFound},
		{code: "agent_busy", err: application.ErrAgentBusy},
		{code: "agent_rebuilding", err: application.ErrAgentRebuilding},
		{code: "agent_build_failed", err: application.ErrAgentBuildFailed},
		{code: "agent_not_ready", err: application.ErrAgentNotReady},
		{code: "admission_not_found", err: application.ErrAdmissionNotFound},
		{code: "credential_not_allowed", err: application.ErrCredentialNotAllowed},
		{code: "invalid_request", err: application.ErrInvalidInput},
		{code: "dependency_unavailable", err: application.ErrDependencyUnavailable},
		{code: "internal_error", err: errors.New("unexpected failure")},
	}
	seen := make(map[string]struct{}, len(tests))
	body := `{"request_id":"request-acquire","agent_id":"agent-1","principal_id":"user-1","expected_access_revision":"access-1","session_id":"session-1"}`
	for _, test := range tests {
		t.Run(test.code, func(t *testing.T) {
			boundary, err := NewHandler(
				&catalogServiceStub{}, &lifecycleServiceStub{}, &runServiceStub{err: test.err},
				&agentQueryServiceStub{}, &agentEventServiceStub{}, func(context.Context) error { return nil },
			)
			if err != nil {
				t.Fatalf("new Run error boundary: %v", err)
			}
			route := contract.Methods["acquire_run"]
			request := httptest.NewRequest(
				route.Method, contract.BasePath+route.Path, strings.NewReader(body),
			)
			request.Header.Set("Content-Type", route.RequestContentType)
			response := httptest.NewRecorder()
			boundary.ServeHTTP(response, request)
			var payload errorResponse
			if err := json.Unmarshal(response.Body.Bytes(), &payload); err != nil {
				t.Fatalf("decode Run error: %v body=%s", err, response.Body.String())
			}
			if response.Code != contract.Error.StatusByCode[test.code] || payload.Code != test.code ||
				payload.Retryable != contract.Error.RetryableByCode[test.code] {
				t.Fatalf("Run error status=%d payload=%+v", response.Code, payload)
			}
			if mediaType := strings.Split(response.Header().Get("Content-Type"), ";")[0]; mediaType != contract.Error.ResponseContentType {
				t.Fatalf("Run error content type=%q", mediaType)
			}
			assertInlineRunSchema(t, contract, "error", machineRunErrorSchema(contract.Error), response.Body.Bytes())
			seen[test.code] = struct{}{}
		})
	}
	if len(seen) != len(contract.Error.StatusByCode) {
		t.Fatalf("Run error boundary coverage=%v contract=%v", seen, contract.Error.StatusByCode)
	}
}

func readMachineRunContract(t *testing.T) machineRunContract {
	t.Helper()
	var contract machineRunContract
	readStrictContractJSON(
		t, filepath.Join(repositoryRoot(t), "contracts/agent-controller/run-contract.json"), &contract,
	)
	return contract
}

func assertMachineRunRoute(
	t *testing.T,
	mux *http.ServeMux,
	basePath string,
	name string,
	route machineRunRoute,
	requiresRequest bool,
	seen map[string]struct{},
) {
	t.Helper()
	path := basePath + route.Path
	key := route.Method + " " + path
	if _, duplicate := seen[key]; duplicate {
		t.Fatalf("duplicate Run route %s", key)
	}
	request := httptest.NewRequest(route.Method, path, nil)
	_, pattern := mux.Handler(request)
	if pattern != key {
		t.Fatalf("Run route %s is registered as %q", key, pattern)
	}
	if route.SuccessStatus < 200 || route.SuccessStatus >= 300 ||
		route.ResponseContentType != "application/json" || len(route.Response) == 0 {
		t.Fatalf("Run route %s.%s is incomplete: %+v", name, key, route)
	}
	if requiresRequest && (route.RequestContentType != "application/json" || len(route.Request) == 0) {
		t.Fatalf("Run route %s request contract is incomplete: %+v", name, route)
	}
	seen[key] = struct{}{}
}

func assertMachineRunHTTPResponse(
	t *testing.T,
	contract machineRunContract,
	name string,
	route machineRunRoute,
	response *httptest.ResponseRecorder,
) {
	t.Helper()
	if response.Code != route.SuccessStatus {
		t.Fatalf("Run %s status=%d want=%d body=%s", name, response.Code, route.SuccessStatus, response.Body.String())
	}
	if mediaType := strings.Split(response.Header().Get("Content-Type"), ";")[0]; mediaType != route.ResponseContentType {
		t.Fatalf("Run %s content type=%q want=%q", name, mediaType, route.ResponseContentType)
	}
	assertInlineRunSchema(t, contract, name+" response", route.Response, response.Body.Bytes())
}

func assertInlineRunSchema(
	t *testing.T,
	contract machineRunContract,
	name string,
	schemaPayload json.RawMessage,
	instancePayload []byte,
) {
	t.Helper()
	if contract.SchemaDialect != draft202012Schema {
		t.Fatalf("Run schema dialect = %q", contract.SchemaDialect)
	}
	document, err := jsonschema.UnmarshalJSON(bytes.NewReader(schemaPayload))
	if err != nil {
		t.Fatalf("decode Run %s schema: %v", name, err)
	}
	compiler := jsonschema.NewCompiler()
	compiler.DefaultDraft(jsonschema.Draft2020)
	compiler.AssertFormat()
	resourceID := "https://antnest.local/agent-controller/run-contract/" + strings.ReplaceAll(name, " ", "-")
	if err := compiler.AddResource(resourceID, document); err != nil {
		t.Fatalf("load Run %s schema: %v", name, err)
	}
	definition, err := compiler.Compile(resourceID)
	if err != nil {
		t.Fatalf("compile Run %s schema: %v", name, err)
	}
	instance, err := jsonschema.UnmarshalJSON(bytes.NewReader(instancePayload))
	if err != nil {
		t.Fatalf("decode Run %s instance: %v body=%s", name, err, instancePayload)
	}
	if err := definition.Validate(instance); err != nil {
		t.Fatalf("Run %s violates schema: %v body=%s", name, err, instancePayload)
	}
}

func machineRunErrorSchema(contract machineRunError) json.RawMessage {
	payload, err := json.Marshal(struct {
		Type       string                     `json:"type"`
		Required   []string                   `json:"required"`
		Properties map[string]json.RawMessage `json:"properties"`
		Additional bool                       `json:"additionalProperties"`
	}{
		Type: contract.Type, Required: contract.Required,
		Properties: contract.Properties, Additional: contract.Additional,
	})
	if err != nil {
		panic(err)
	}
	return payload
}

func assertMachineRunErrorMetadata(t *testing.T, contract machineRunError) {
	t.Helper()
	if contract.Type != "object" || contract.ResponseContentType != "application/json" ||
		contract.Additional || len(contract.StatusByCode) == 0 ||
		len(contract.StatusByCode) != len(contract.RetryableByCode) {
		t.Fatalf("Run error contract is incomplete: %+v", contract)
	}
	var codeSchema struct {
		Enum []string `json:"enum"`
	}
	if err := json.Unmarshal(contract.Properties["code"], &codeSchema); err != nil {
		t.Fatalf("decode Run error codes: %v", err)
	}
	slices.Sort(codeSchema.Enum)
	metadataCodes := make([]string, 0, len(contract.StatusByCode))
	for code := range contract.StatusByCode {
		if _, exists := contract.RetryableByCode[code]; !exists {
			t.Fatalf("Run error %q has no retryability contract", code)
		}
		metadataCodes = append(metadataCodes, code)
	}
	slices.Sort(metadataCodes)
	if !slices.Equal(codeSchema.Enum, metadataCodes) {
		t.Fatalf("Run error schema codes=%v metadata=%v", codeSchema.Enum, metadataCodes)
	}
}
