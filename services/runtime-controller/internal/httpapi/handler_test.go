package httpapi

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"go.opentelemetry.io/otel/trace"

	"soft/antnest-platform/services/runtime-controller/internal/application"
	"soft/antnest-platform/services/runtime-controller/internal/domain"
	runtimecontracts "soft/antnest-platform/services/runtime-controller/internal/runtimeprotocol"
)

func TestPrepareReturnsAcceptedOperation(t *testing.T) {
	service := &fakeService{
		prepareResult: domain.PreparePlan{
			Runtime:   domain.Runtime{AgentID: "agent-1", DesiredGeneration: 1, Status: domain.RuntimePending},
			Operation: domain.Operation{ID: "operation-1", AgentID: "agent-1", Kind: domain.OperationPrepare, Status: domain.OperationPending},
		},
	}
	handler, err := New(service, &fakeWorkService{})
	if err != nil {
		t.Fatalf("new handler: %v", err)
	}
	request := httptest.NewRequest(http.MethodPut, "/internal/v1/runtimes/agent-1", bytes.NewBufferString(`{
		"image_ref":"antnest/runtime:test","network_mode":"restricted"
	}`))
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("Idempotency-Key", "prepare-1")
	response := httptest.NewRecorder()

	handler.ServeHTTP(response, request)

	if response.Code != http.StatusAccepted {
		t.Fatalf("status = %d body=%s", response.Code, response.Body.String())
	}
	if service.prepareInput.AgentID != "agent-1" || service.prepareInput.IdempotencyKey != "prepare-1" {
		t.Fatalf("unexpected input: %+v", service.prepareInput)
	}
	var body operationResponse
	if err := json.Unmarshal(response.Body.Bytes(), &body); err != nil {
		t.Fatalf("decode response: %v", err)
	}
	if body.OperationID != "operation-1" || body.Status != domain.OperationPending {
		t.Fatalf("unexpected body: %+v", body)
	}
}

func TestPrepareRequiresIdempotencyKey(t *testing.T) {
	handler, err := New(&fakeService{}, &fakeWorkService{})
	if err != nil {
		t.Fatalf("new handler: %v", err)
	}
	request := httptest.NewRequest(http.MethodPut, "/internal/v1/runtimes/agent-1", bytes.NewBufferString(`{
		"image_ref":"antnest/runtime:test","network_mode":"restricted"
	}`))
	request.Header.Set("Content-Type", "application/json")
	response := httptest.NewRecorder()

	handler.ServeHTTP(response, request)

	if response.Code != http.StatusBadRequest || response.Header().Get("Content-Type") != "application/problem+json" {
		t.Fatalf("unexpected response: status=%d content-type=%q body=%s",
			response.Code, response.Header().Get("Content-Type"), response.Body.String())
	}
	var body problem
	if err := json.Unmarshal(response.Body.Bytes(), &body); err != nil || body.Code != "invalid_request" {
		t.Fatalf("problem body=%+v err=%v", body, err)
	}
}

func TestPrepareRejectsOversizedIdempotencyKey(t *testing.T) {
	handler, err := New(&fakeService{}, &fakeWorkService{})
	if err != nil {
		t.Fatalf("new handler: %v", err)
	}
	request := httptest.NewRequest(http.MethodPut, "/internal/v1/runtimes/agent-1", bytes.NewBufferString(`{
		"image_ref":"antnest/runtime:test","network_mode":"restricted"
	}`))
	request.Header.Set("Idempotency-Key", strings.Repeat("界", domain.MaxIdempotencyKeyCharacters+1))
	response := httptest.NewRecorder()

	handler.ServeHTTP(response, request)

	if response.Code != http.StatusBadRequest {
		t.Fatalf("status=%d body=%s", response.Code, response.Body.String())
	}
}

func TestValidationProblemReturnsStableCodeAndTrace(t *testing.T) {
	handler, err := New(&fakeService{err: domain.ErrInvalidArgument}, &fakeWorkService{})
	if err != nil {
		t.Fatalf("new handler: %v", err)
	}
	request := httptest.NewRequest(
		http.MethodPut,
		"/internal/v1/runtimes/agent-1",
		bytes.NewBufferString(`{"image_ref":"","network_mode":"restricted"}`),
	)
	request.Header.Set("Idempotency-Key", "invalid-prepare")
	traceID := trace.TraceID{1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16}
	spanContext := trace.NewSpanContext(trace.SpanContextConfig{
		TraceID: traceID,
		SpanID:  trace.SpanID{1, 2, 3, 4, 5, 6, 7, 8},
	})
	request = request.WithContext(trace.ContextWithSpanContext(request.Context(), spanContext))
	response := httptest.NewRecorder()

	handler.ServeHTTP(response, request)

	var body problem
	if err := json.Unmarshal(response.Body.Bytes(), &body); err != nil {
		t.Fatalf("decode problem: %v", err)
	}
	if response.Code != http.StatusBadRequest || body.Code != "invalid_request" ||
		body.TraceID != traceID.String() {
		t.Fatalf("unexpected validation problem: status=%d body=%+v", response.Code, body)
	}
}

func TestLifecycleAndQueryRoutes(t *testing.T) {
	service := &fakeService{
		lifecycleResult: domain.LifecyclePlan{
			Runtime:         domain.Runtime{AgentID: "agent-1", DesiredState: domain.DesiredStopped},
			Operation:       domain.Operation{ID: "operation-stop", Status: domain.OperationPending},
			RetainWorkspace: true,
		},
		getRuntimeResult:   domain.Runtime{AgentID: "agent-1", Status: domain.RuntimeReady},
		getOperationResult: domain.Operation{ID: "operation-stop", Status: domain.OperationSucceeded},
	}
	handler, err := New(service, &fakeWorkService{})
	if err != nil {
		t.Fatalf("new handler: %v", err)
	}

	stop := httptest.NewRequest(http.MethodPost, "/internal/v1/runtimes/agent-1/stop", nil)
	stop.Header.Set("Idempotency-Key", "stop-1")
	stopResponse := httptest.NewRecorder()
	handler.ServeHTTP(stopResponse, stop)
	if stopResponse.Code != http.StatusAccepted || service.lifecycleInput.IdempotencyKey != "stop-1" {
		t.Fatalf("stop response=%d input=%+v body=%s", stopResponse.Code, service.lifecycleInput, stopResponse.Body.String())
	}

	getRuntime := httptest.NewRequest(http.MethodGet, "/internal/v1/runtimes/agent-1", nil)
	getRuntimeResponse := httptest.NewRecorder()
	handler.ServeHTTP(getRuntimeResponse, getRuntime)
	if getRuntimeResponse.Code != http.StatusOK {
		t.Fatalf("get runtime status=%d body=%s", getRuntimeResponse.Code, getRuntimeResponse.Body.String())
	}

	getOperation := httptest.NewRequest(http.MethodGet, "/internal/v1/runtime-operations/operation-stop", nil)
	getOperationResponse := httptest.NewRecorder()
	handler.ServeHTTP(getOperationResponse, getOperation)
	if getOperationResponse.Code != http.StatusOK {
		t.Fatalf("get operation status=%d body=%s", getOperationResponse.Code, getOperationResponse.Body.String())
	}
}

func TestHealthEndpointsAreIndependentOfRuntimeState(t *testing.T) {
	handler, err := New(&fakeService{}, &fakeWorkService{})
	if err != nil {
		t.Fatalf("new handler: %v", err)
	}
	for _, path := range []string{"/healthz", "/readyz"} {
		response := httptest.NewRecorder()
		handler.ServeHTTP(response, httptest.NewRequest(http.MethodGet, path, nil))
		if response.Code != http.StatusOK {
			t.Fatalf("%s status=%d body=%s", path, response.Code, response.Body.String())
		}
	}
}

func TestReadinessReportsDependencyFailure(t *testing.T) {
	handler, err := NewWithReadiness(&fakeService{}, &fakeWorkService{}, func(context.Context) error {
		return application.ErrNotFound
	})
	if err != nil {
		t.Fatalf("new handler: %v", err)
	}
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, httptest.NewRequest(http.MethodGet, "/readyz", nil))
	if response.Code != http.StatusServiceUnavailable {
		t.Fatalf("status=%d body=%s", response.Code, response.Body.String())
	}
}

func TestExecRouteConvertsTimeoutAndReturnsRuntimeOutcome(t *testing.T) {
	work := &fakeWorkService{
		execResult: runtimecontracts.ExecResult{
			Outcome:  runtimecontracts.Outcome{Disposition: runtimecontracts.EffectCompleted},
			ExitCode: int32Pointer(0), ProcessReaped: true,
		},
	}
	handler, err := New(&fakeService{}, work)
	if err != nil {
		t.Fatalf("new handler: %v", err)
	}
	request := httptest.NewRequest(http.MethodPost,
		"/internal/v1/runtimes/agent-1/process:exec", bytes.NewBufferString(`{
			"work_id":"run-1","work_epoch":1,"work_session_id":"session-1",
			"operation_id":"operation-1",
			"request_digest":"sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
			"argv":["printf","hello"],
			"working_dir":{"root":"workspace","path":"."},
			"timeout_ms":5000
		}`))
	request.Header.Set("Content-Type", "application/json")
	response := httptest.NewRecorder()

	handler.ServeHTTP(response, request)

	if response.Code != http.StatusOK {
		t.Fatalf("status=%d body=%s", response.Code, response.Body.String())
	}
	if work.agentID != "agent-1" || work.execInput.Timeout != 5*time.Second {
		t.Fatalf("unexpected exec input: agent=%q input=%+v", work.agentID, work.execInput)
	}
}

type fakeService struct {
	prepareInput       application.PrepareInput
	prepareResult      domain.PreparePlan
	lifecycleInput     application.LifecycleInput
	lifecycleResult    domain.LifecyclePlan
	networkInput       application.NetworkPolicyInput
	networkResult      domain.NetworkPolicyPlan
	getRuntimeResult   domain.Runtime
	getOperationResult domain.Operation
	err                error
}

func (s *fakeService) Prepare(_ context.Context, input application.PrepareInput) (domain.PreparePlan, error) {
	s.prepareInput = input
	return s.prepareResult, s.err
}

func (s *fakeService) Stop(_ context.Context, input application.LifecycleInput) (domain.LifecyclePlan, error) {
	s.lifecycleInput = input
	return s.lifecycleResult, s.err
}

func (s *fakeService) Retire(_ context.Context, input application.LifecycleInput) (domain.LifecyclePlan, error) {
	s.lifecycleInput = input
	return s.lifecycleResult, s.err
}

func (s *fakeService) Purge(_ context.Context, input application.LifecycleInput) (domain.LifecyclePlan, error) {
	s.lifecycleInput = input
	return s.lifecycleResult, s.err
}

func (s *fakeService) UpdateNetworkPolicy(
	_ context.Context, input application.NetworkPolicyInput,
) (domain.NetworkPolicyPlan, error) {
	s.networkInput = input
	return s.networkResult, s.err
}

func (s *fakeService) GetRuntime(context.Context, string) (domain.Runtime, error) {
	return s.getRuntimeResult, s.err
}

func (s *fakeService) GetOperation(context.Context, string) (domain.Operation, error) {
	return s.getOperationResult, s.err
}

func fixedTime() time.Time {
	return time.Date(2026, 8, 28, 7, 8, 9, 0, time.UTC)
}

type fakeWorkService struct {
	agentID    string
	execInput  runtimecontracts.ExecInput
	execResult runtimecontracts.ExecResult
	err        error
}

func (s *fakeWorkService) BeginWork(
	context.Context, string, runtimecontracts.BeginWorkInput,
) (runtimecontracts.BeginWorkResult, error) {
	return runtimecontracts.BeginWorkResult{}, s.err
}

func (s *fakeWorkService) EndWork(
	context.Context, string, runtimecontracts.EndWorkInput,
) (runtimecontracts.EndWorkResult, error) {
	return runtimecontracts.EndWorkResult{}, s.err
}

func (s *fakeWorkService) Exec(
	_ context.Context, agentID string, input runtimecontracts.ExecInput,
) (runtimecontracts.ExecResult, error) {
	s.agentID = agentID
	s.execInput = input
	return s.execResult, s.err
}

func (s *fakeWorkService) ReadFile(
	context.Context, string, runtimecontracts.ReadFileInput,
) (runtimecontracts.ReadFileResult, error) {
	return runtimecontracts.ReadFileResult{}, s.err
}

func (s *fakeWorkService) WriteFile(
	context.Context, string, runtimecontracts.WriteFileInput,
) (runtimecontracts.WriteFileResult, error) {
	return runtimecontracts.WriteFileResult{}, s.err
}

func (s *fakeWorkService) EditFile(
	context.Context, string, runtimecontracts.EditFileInput,
) (runtimecontracts.EditFileResult, error) {
	return runtimecontracts.EditFileResult{}, s.err
}

func (s *fakeWorkService) ListDir(
	context.Context, string, runtimecontracts.ListDirInput,
) (runtimecontracts.ListDirResult, error) {
	return runtimecontracts.ListDirResult{}, s.err
}

func (s *fakeWorkService) CancelOperation(
	context.Context, string, runtimecontracts.CancelOperationInput,
) (runtimecontracts.CancelOperationResult, error) {
	return runtimecontracts.CancelOperationResult{}, s.err
}

func int32Pointer(value int32) *int32 { return &value }
