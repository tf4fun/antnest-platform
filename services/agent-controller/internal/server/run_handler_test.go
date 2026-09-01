package server

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"soft/antnest-platform/services/agent-controller/internal/application"
	"soft/antnest-platform/services/agent-controller/internal/domain"
	"soft/antnest-platform/services/agent-controller/internal/ports"
)

func TestRunHandlerServesAgentACPContract(t *testing.T) {
	t.Parallel()

	now := time.Unix(1400, 0).UTC()
	runs := &runServiceStub{
		access: application.AgentAccessView{
			PrincipalID: "user-1", AgentID: "agent-1", AccessRevision: "access-1",
			PromptCapabilities: ports.PromptCapabilities{Image: true},
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
	handler, err := NewHandler(
		&catalogServiceStub{}, &lifecycleServiceStub{}, runs,
		func(context.Context) error { return nil },
	)
	if err != nil {
		t.Fatalf("new handler: %v", err)
	}

	assertJSONRequest(t, handler, "/rpc/agent-controller/resolve-agent-access",
		`{"request_id":"request-access-1","agent_access_subject":"subject-1"}`,
		func(payload map[string]any) {
			if payload["agent_id"] != "agent-1" || payload["access_revision"] != "access-1" {
				t.Fatalf("access response = %+v", payload)
			}
		},
	)
	assertJSONRequest(t, handler, "/rpc/agent-controller/acquire-run",
		`{"request_id":"request-run-1","agent_id":"agent-1","principal_id":"user-1","expected_access_revision":"access-1","session_id":"session-1"}`,
		func(payload map[string]any) {
			executionSpec, ok := payload["execution_spec"].(map[string]any)
			if !ok || payload["admission_id"] != "admission-1" {
				t.Fatalf("acquire response = %+v", payload)
			}
			skills, ok := executionSpec["skill_instructions"].([]any)
			if !ok || len(skills) != 0 {
				t.Fatalf("Skill instructions = %#v", executionSpec["skill_instructions"])
			}
		},
	)
	credentialResponse := assertJSONRequest(t, handler, "/rpc/agent-controller/resolve-credential",
		`{"request_id":"request-credential-1","admission_id":"admission-1","credential_ref":"credential-1"}`,
		func(payload map[string]any) {
			if payload["secret"] != "secret-1" || payload["credential_version"] != "version-1" {
				t.Fatalf("credential response = %+v", payload)
			}
		},
	)
	if credentialResponse.Header().Get("Cache-Control") != "no-store" ||
		credentialResponse.Header().Get("Pragma") != "no-cache" {
		t.Fatalf("credential cache headers = %v", credentialResponse.Header())
	}
	assertJSONRequest(t, handler, "/rpc/agent-controller/finish-run",
		`{"request_id":"request-finish-1","admission_id":"admission-1","terminal_class":"completed","tool_effect_state":"settled","stop_reason":"end_turn","error_class":null}`,
		func(payload map[string]any) {
			if payload["status"] != "finished" || payload["admission_state"] != "released" {
				t.Fatalf("finish response = %+v", payload)
			}
		},
	)
	if runs.finish.StopReason != "end_turn" || runs.finish.ErrorClass != "" {
		t.Fatalf("FinishRun input = %+v", runs.finish)
	}
}

func TestFinishRunRequiresExplicitNullableFields(t *testing.T) {
	t.Parallel()

	runs := &runServiceStub{}
	handler, err := NewHandler(
		&catalogServiceStub{}, &lifecycleServiceStub{}, runs,
		func(context.Context) error { return nil },
	)
	if err != nil {
		t.Fatalf("new handler: %v", err)
	}
	response := httptest.NewRecorder()
	request := httptest.NewRequest(
		http.MethodPost, "/rpc/agent-controller/finish-run",
		strings.NewReader(`{"request_id":"request-finish-1","admission_id":"admission-1","terminal_class":"cancelled","tool_effect_state":"none"}`),
	)
	handler.ServeHTTP(response, request)
	if response.Code != http.StatusBadRequest || runs.finish.RequestID != "" {
		t.Fatalf("missing nullable fields status=%d input=%+v", response.Code, runs.finish)
	}
}

func TestRunHandlerUsesConsumerSpecificErrorClasses(t *testing.T) {
	t.Parallel()

	runs := &runServiceStub{err: application.ErrAgentBusy}
	handler, err := NewHandler(
		&catalogServiceStub{}, &lifecycleServiceStub{}, runs,
		func(context.Context) error { return nil },
	)
	if err != nil {
		t.Fatalf("new handler: %v", err)
	}
	response := httptest.NewRecorder()
	request := httptest.NewRequest(
		http.MethodPost, "/rpc/agent-controller/acquire-run",
		strings.NewReader(`{"request_id":"request-run-1","agent_id":"agent-1","principal_id":"user-1","expected_access_revision":"access-1","session_id":"session-1"}`),
	)
	handler.ServeHTTP(response, request)
	var payload errorResponse
	if err := json.Unmarshal(response.Body.Bytes(), &payload); err != nil {
		t.Fatalf("decode error response: %v", err)
	}
	if response.Code != http.StatusConflict || payload.Code != "agent_busy" || !payload.Retryable {
		t.Fatalf("Run error status=%d payload=%+v", response.Code, payload)
	}
}

func assertJSONRequest(
	t *testing.T, handler http.Handler, path string, body string, assert func(map[string]any),
) *httptest.ResponseRecorder {
	t.Helper()
	response := httptest.NewRecorder()
	request := httptest.NewRequest(http.MethodPost, path, strings.NewReader(body))
	handler.ServeHTTP(response, request)
	if response.Code != http.StatusOK {
		t.Fatalf("%s status=%d body=%s", path, response.Code, response.Body.String())
	}
	var payload map[string]any
	if err := json.Unmarshal(response.Body.Bytes(), &payload); err != nil {
		t.Fatalf("decode %s response: %v", path, err)
	}
	assert(payload)
	return response
}

type runServiceStub struct {
	access       application.AgentAccessView
	accessIn     application.ResolveAgentAccessInput
	acquired     application.AcquireRunResult
	acquireIn    application.AcquireRunInput
	credential   application.CredentialView
	credentialIn application.ResolveCredentialInput
	finished     application.FinishRunResult
	finish       application.FinishRunInput
	err          error
}

func (service *runServiceStub) ResolveAgentAccess(
	_ context.Context, input application.ResolveAgentAccessInput,
) (application.AgentAccessView, error) {
	service.accessIn = input
	return service.access, service.err
}

func (service *runServiceStub) AcquireRun(
	_ context.Context, input application.AcquireRunInput,
) (application.AcquireRunResult, error) {
	service.acquireIn = input
	return service.acquired, service.err
}

func (service *runServiceStub) ResolveCredential(
	_ context.Context, input application.ResolveCredentialInput,
) (application.CredentialView, error) {
	service.credentialIn = input
	return service.credential, service.err
}

func (service *runServiceStub) FinishRun(
	_ context.Context, input application.FinishRunInput,
) (application.FinishRunResult, error) {
	service.finish = input
	return service.finished, service.err
}

var _ RunService = (*runServiceStub)(nil)
