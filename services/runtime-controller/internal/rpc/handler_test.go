package rpc

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

	"go.opentelemetry.io/otel/attribute"
	sdktrace "go.opentelemetry.io/otel/sdk/trace"
	"go.opentelemetry.io/otel/sdk/trace/tracetest"

	"soft/antnest-platform/services/runtime-controller/internal/control"
	"soft/antnest-platform/services/runtime-controller/internal/deployment"
	"soft/antnest-platform/services/runtime-controller/internal/observation"
	"soft/antnest-platform/services/runtime-controller/internal/platform"
)

const testRuntimeRevision = deployment.RuntimeRevision("rtv_0123456789abcdef0123456789abcdef")

func TestInitializeRuntimeRequiresIdempotencyKeyAndStrictJSON(t *testing.T) {
	service := &fakeService{}
	handler := newTestHandler(t, service)
	body := `{"configuration":{},"unknown":true}`
	request := httptest.NewRequest(http.MethodPost, "/internal/runtimes/agent-1/initialize", strings.NewReader(body))
	request.Header.Set("Idempotency-Key", "request-1")
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	if response.Code != http.StatusBadRequest || service.initializeCalls != 0 {
		t.Fatalf("strict JSON response=%d calls=%d body=%s", response.Code, service.initializeCalls, response.Body.String())
	}

	request = httptest.NewRequest(http.MethodPost, "/internal/runtimes/agent-1/initialize", bytes.NewReader(nil))
	response = httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	if response.Code != http.StatusBadRequest || !strings.Contains(response.Body.String(), "idempotency_key_required") {
		t.Fatalf("missing idempotency response=%d body=%s", response.Code, response.Body.String())
	}
}

func TestInitializeRuntimeReturnsCompletedOperation(t *testing.T) {
	service := &fakeService{operation: deployment.Operation{
		RequestID: "request-1", Kind: deployment.OperationInitializeRuntime,
		AgentID: "agent-1", RuntimeRevision: testRuntimeRevision,
		State:  deployment.OperationCompleted,
		Effect: deployment.EffectCompleted,
	}}
	handler := newTestHandler(t, service)
	payload := initializeRequest{Configuration: configurationDTO{}}
	encoded, _ := json.Marshal(payload)
	request := httptest.NewRequest(http.MethodPost, "/internal/runtimes/agent-1/initialize", bytes.NewReader(encoded))
	request.Header.Set("Idempotency-Key", "request-1")
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	if response.Code != http.StatusOK || service.agentID != "agent-1" ||
		!strings.Contains(response.Body.String(), `"target_revision":"`+string(testRuntimeRevision)+`"`) {
		t.Fatalf("initialize response=%d agent_id=%q body=%s", response.Code, service.agentID, response.Body.String())
	}
}

func TestLifecycleMutationTraceCarriesLogicalOperationIdentity(t *testing.T) {
	recorder := tracetest.NewSpanRecorder()
	provider := sdktrace.NewTracerProvider(sdktrace.WithSpanProcessor(recorder))
	original := rpcTracer
	rpcTracer = provider.Tracer("runtime-controller-rpc-test")
	t.Cleanup(func() {
		rpcTracer = original
		_ = provider.Shutdown(context.Background())
	})
	service := &fakeService{operation: deployment.Operation{
		RequestID: "request-1", Kind: deployment.OperationInitializeRuntime,
		AgentID: "agent-1", RuntimeRevision: testRuntimeRevision,
		State: deployment.OperationCompleted, Effect: deployment.EffectCompleted,
	}}
	handler := newTestHandler(t, service)
	encoded, _ := json.Marshal(initializeRequest{Configuration: configurationDTO{}})
	request := httptest.NewRequest(http.MethodPost, "/internal/runtimes/agent-1/initialize", bytes.NewReader(encoded))
	request.Header.Set("Idempotency-Key", "request-1")
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)

	spans := recorder.Ended()
	if len(spans) != 1 || spans[0].Name() != "runtime.lifecycle.initialize_runtime" {
		t.Fatalf("lifecycle spans = %+v", spans)
	}
	attributes := make(map[attribute.Key]attribute.Value)
	for _, value := range spans[0].Attributes() {
		attributes[value.Key] = value.Value
	}
	for key, want := range map[attribute.Key]string{
		"antnest.agent.id":                "agent-1",
		"antnest.operation.id":            "request-1",
		"antnest.operation.kind":          string(deployment.OperationInitializeRuntime),
		"antnest.runtime.target_revision": string(testRuntimeRevision),
		"antnest.result":                  string(deployment.OperationCompleted),
	} {
		if got := attributes[key].AsString(); got != want {
			t.Fatalf("span attribute %s = %q, want %q", key, got, want)
		}
	}
}

func TestLifecycleFailureKeepsRequestedIdentityAndWireErrorClassification(t *testing.T) {
	recorder := tracetest.NewSpanRecorder()
	provider := sdktrace.NewTracerProvider(sdktrace.WithSpanProcessor(recorder))
	original := rpcTracer
	rpcTracer = provider.Tracer("runtime-controller-rpc-failure-test")
	t.Cleanup(func() {
		rpcTracer = original
		_ = provider.Shutdown(context.Background())
	})
	service := &fakeService{operationErr: context.DeadlineExceeded}
	handler := newTestHandler(t, service)
	encoded, _ := json.Marshal(initializeRequest{Configuration: configurationDTO{}})
	request := httptest.NewRequest(http.MethodPost, "/internal/runtimes/agent-1/initialize", bytes.NewReader(encoded))
	request.Header.Set("Idempotency-Key", "request-1")
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)

	if response.Code != http.StatusGatewayTimeout || !strings.Contains(response.Body.String(), "deadline_exceeded") {
		t.Fatalf("deadline response=%d body=%s", response.Code, response.Body.String())
	}
	spans := recorder.Ended()
	if len(spans) != 1 {
		t.Fatalf("lifecycle spans=%d want=1", len(spans))
	}
	attributes := make(map[attribute.Key]attribute.Value)
	for _, value := range spans[0].Attributes() {
		attributes[value.Key] = value.Value
	}
	for key, want := range map[attribute.Key]string{
		"antnest.agent.id":     "agent-1",
		"antnest.operation.id": "request-1",
		"antnest.error.class":  "deadline_exceeded",
	} {
		if got := attributes[key].AsString(); got != want {
			t.Fatalf("span attribute %s=%q want=%q", key, got, want)
		}
	}
}

func TestFailedOperationUsesStableSanitizedError(t *testing.T) {
	service := &fakeService{operation: deployment.Operation{
		RequestID: "request-1", State: deployment.OperationFailed,
		Effect: deployment.EffectNotStarted, ErrorCode: "runtime_drift",
		ErrorDetail: "must not leak Docker internals",
	}}
	handler := newTestHandler(t, service)
	encoded, _ := json.Marshal(initializeRequest{Configuration: configurationDTO{}})
	request := httptest.NewRequest(http.MethodPost, "/internal/runtimes/agent-1/initialize", bytes.NewReader(encoded))
	request.Header.Set("Idempotency-Key", "request-1")
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	if response.Code != http.StatusConflict || strings.Contains(response.Body.String(), "Docker") ||
		!strings.Contains(response.Body.String(), "runtime_drift") {
		t.Fatalf("unsafe operation error: code=%d body=%s", response.Code, response.Body.String())
	}
}

func TestLifecycleMutationRoutesForwardOpaqueRevision(t *testing.T) {
	for _, test := range []struct {
		name       string
		action     string
		kind       deployment.OperationKind
		withConfig bool
	}{
		{name: "update", action: "update", kind: deployment.OperationUpdateRuntime, withConfig: true},
		{name: "disable", action: "disable", kind: deployment.OperationDisableRuntime},
		{name: "enable", action: "enable", kind: deployment.OperationEnableRuntime, withConfig: true},
		{name: "delete", action: "delete", kind: deployment.OperationDeleteRuntime},
	} {
		t.Run(test.name, func(t *testing.T) {
			service := &fakeService{operation: deployment.Operation{
				RequestID: "request-1", AgentID: "agent-1", RuntimeRevision: testRuntimeRevision,
				State: deployment.OperationCompleted, Effect: deployment.EffectCompleted,
			}}
			handler := newTestHandler(t, service)
			body := revisionRequest{ExpectedRevision: testRuntimeRevision}
			var payload any = body
			if test.withConfig {
				payload = revisionConfigurationRequest{
					ExpectedRevision: testRuntimeRevision, Configuration: configurationDTO{},
				}
			}
			encoded, _ := json.Marshal(payload)
			request := httptest.NewRequest(
				http.MethodPost, "/internal/runtimes/agent-1/"+test.action, bytes.NewReader(encoded),
			)
			request.Header.Set("Idempotency-Key", "request-1")
			response := httptest.NewRecorder()
			handler.ServeHTTP(response, request)
			if response.Code != http.StatusOK || service.command != test.kind ||
				service.expectedRevision != testRuntimeRevision || service.agentID != "agent-1" {
				t.Fatalf("response=%d command=%s revision=%s agent=%s body=%s",
					response.Code, service.command, service.expectedRevision, service.agentID,
					response.Body.String())
			}
		})
	}
}

func TestObservationListCarriesRecoveryCursor(t *testing.T) {
	service := &fakeService{observations: []deployment.Observation{
		{Sequence: 11, AgentID: "agent-1", Generation: 7, Kind: deployment.ObservationHealthy},
		{Sequence: 12, AgentID: "agent-1", Generation: 7, Kind: deployment.ObservationRestarted},
	}}
	handler := newTestHandler(t, service)
	request := httptest.NewRequest(http.MethodGet, "/internal/runtime-observations?after_sequence=10&limit=2", nil)
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	if response.Code != http.StatusOK || !strings.Contains(response.Body.String(), `"next_sequence":12`) ||
		service.after != 10 || service.limit != 2 {
		t.Fatalf("observation response=%d after=%d limit=%d body=%s", response.Code, service.after, service.limit, response.Body.String())
	}
}

func TestObservationCursorRejectsValuesBeyondPersistenceRange(t *testing.T) {
	handler := newTestHandler(t, &fakeService{})
	request := httptest.NewRequest(http.MethodGet,
		"/internal/runtime-observations?after_sequence=18446744073709551615", nil)
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	if response.Code != http.StatusBadRequest || !strings.Contains(response.Body.String(), "invalid_request") {
		t.Fatalf("overflow cursor response=%d body=%s", response.Code, response.Body.String())
	}
}

func TestObservationCursorExpiryReturnsProjectionResetSequence(t *testing.T) {
	service := &fakeService{listErr: &control.ObservationCursorExpiredError{ResetSequence: 42}}
	handler := newTestHandler(t, service)
	request := httptest.NewRequest(http.MethodGet, "/internal/runtime-observations?after_sequence=3", nil)
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	var body errorResponse
	if err := json.Unmarshal(response.Body.Bytes(), &body); err != nil {
		t.Fatal(err)
	}
	if response.Code != http.StatusGone || body.Code != "observation_cursor_expired" ||
		body.ResetSequence == nil || *body.ResetSequence != 42 {
		t.Fatalf("expired cursor response=%d body=%+v", response.Code, body)
	}
}

func TestObservationWatchReportsInitialReadFailureBeforeCommittingStream(t *testing.T) {
	handler := newTestHandler(t, &fakeService{listErr: errors.New("journal unavailable")})
	request := httptest.NewRequest(http.MethodGet, "/internal/runtime-observations/watch", nil)
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	if response.Code != http.StatusInternalServerError || !strings.Contains(response.Body.String(), "internal_error") ||
		strings.Contains(response.Header().Get("Content-Type"), "text/event-stream") {
		t.Fatalf("initial Watch failure response=%d content-type=%q body=%s",
			response.Code, response.Header().Get("Content-Type"), response.Body.String())
	}
}

func TestStatusSeparatesDependencyReadinessFromProcessLiveness(t *testing.T) {
	service := &fakeService{readyErr: errors.New("database unavailable")}
	handler := newTestHandler(t, service)
	request := httptest.NewRequest(http.MethodGet, "/status", nil)
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	if response.Code != http.StatusServiceUnavailable || !strings.Contains(response.Body.String(), `"status":"not_ready"`) {
		t.Fatalf("status response=%d body=%s", response.Code, response.Body.String())
	}
	if !strings.Contains(response.Body.String(), `"live":true`) ||
		!strings.Contains(response.Body.String(), `"ready":false`) {
		t.Fatalf("status did not separate liveness and readiness: %s", response.Body.String())
	}
}

func TestUnknownRoutesAndMethodsUseJSONErrorContract(t *testing.T) {
	handler := newTestHandler(t, &fakeService{})
	for _, test := range []struct {
		method string
		path   string
		status int
		code   string
	}{
		{method: http.MethodPost, path: "/status", status: http.StatusMethodNotAllowed, code: "method_not_allowed"},
		{method: http.MethodGet, path: "/missing", status: http.StatusNotFound, code: "route_not_found"},
	} {
		response := httptest.NewRecorder()
		handler.ServeHTTP(response, httptest.NewRequest(test.method, test.path, nil))
		if response.Code != test.status || !strings.Contains(response.Body.String(), test.code) ||
			response.Header().Get("Content-Type") != "application/json" {
			t.Fatalf("%s %s: status=%d body=%s", test.method, test.path, response.Code, response.Body.String())
		}
	}
}

func TestMutationCoordinationFailuresUseStableErrors(t *testing.T) {
	for _, test := range []struct {
		name      string
		err       error
		status    int
		code      string
		retryable bool
	}{
		{
			name: "lost lock", err: control.ErrMutationLockLost,
			status: http.StatusServiceUnavailable, code: "mutation_lock_lost", retryable: true,
		},
		{
			name: "active mutation", err: control.ErrAgentMutationInProgress,
			status: http.StatusConflict, code: "agent_mutation_in_progress", retryable: true,
		},
	} {
		t.Run(test.name, func(t *testing.T) {
			response := httptest.NewRecorder()
			writeError(response, test.err)
			var body errorResponse
			if err := json.Unmarshal(response.Body.Bytes(), &body); err != nil {
				t.Fatal(err)
			}
			if response.Code != test.status || body.Code != test.code || body.Retryable != test.retryable {
				t.Fatalf("response=%d body=%+v", response.Code, body)
			}
		})
	}
}

func TestFiniteRPCUsesServerExecutionBudget(t *testing.T) {
	service := &fakeService{blockListUntilCanceled: true}
	handler, err := NewHandler(service, observation.NewHub(), time.Second, 5*time.Millisecond)
	if err != nil {
		t.Fatal(err)
	}
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, httptest.NewRequest(http.MethodGet, "/internal/runtimes", nil))
	if response.Code != http.StatusGatewayTimeout || !strings.Contains(response.Body.String(), "deadline_exceeded") {
		t.Fatalf("bounded List response=%d body=%s", response.Code, response.Body.String())
	}
}

func TestWatchTerminationDistinguishesServerShutdown(t *testing.T) {
	ctx, cancel := context.WithCancelCause(context.Background())
	cancel(ErrServerShutdown)
	if got := watchTermination(ctx); got != "server_shutdown" {
		t.Fatalf("watch termination=%q want=server_shutdown", got)
	}
}

func newTestHandler(t *testing.T, service Service) http.Handler {
	t.Helper()
	handler, err := NewHandler(service, observation.NewHub(), time.Second, time.Minute)
	if err != nil {
		t.Fatal(err)
	}
	return handler
}

type fakeService struct {
	operation              deployment.Operation
	inspection             deployment.Environment
	observations           []deployment.Observation
	readyErr               error
	operationErr           error
	listErr                error
	blockListUntilCanceled bool
	agentID                string
	after                  uint64
	limit                  int
	initializeCalls        int
	command                deployment.OperationKind
	expectedRevision       deployment.RuntimeRevision
	configuration          deployment.Configuration
}

func (*fakeService) ResolveImage(context.Context, string) (platform.ImageResolution, error) {
	return platform.ImageResolution{}, platform.ErrImageNotFound
}

func (s *fakeService) Status(context.Context) (control.Readiness, error) {
	if s.readyErr != nil {
		return control.Readiness{}, s.readyErr
	}
	return control.Readiness{DatabaseReady: true, PlatformReady: true, ObservationReady: true}, nil
}
func (s *fakeService) InitializeRuntime(
	_ context.Context, _ string, agentID string, configuration deployment.Configuration,
) (deployment.Operation, error) {
	s.initializeCalls++
	s.configuration = configuration
	s.agentID = agentID
	return s.operation, s.operationErr
}
func (s *fakeService) UpdateRuntime(
	_ context.Context, _ string, agentID string, revision deployment.RuntimeRevision, configuration deployment.Configuration,
) (deployment.Operation, error) {
	s.command, s.agentID, s.expectedRevision = deployment.OperationUpdateRuntime, agentID, revision
	s.configuration = configuration
	return s.operation, nil
}
func (s *fakeService) DisableRuntime(
	_ context.Context, _ string, agentID string, revision deployment.RuntimeRevision,
) (deployment.Operation, error) {
	s.command, s.agentID, s.expectedRevision = deployment.OperationDisableRuntime, agentID, revision
	return s.operation, nil
}
func (s *fakeService) EnableRuntime(
	_ context.Context, _ string, agentID string, revision deployment.RuntimeRevision, configuration deployment.Configuration,
) (deployment.Operation, error) {
	s.command, s.agentID, s.expectedRevision = deployment.OperationEnableRuntime, agentID, revision
	s.configuration = configuration
	return s.operation, nil
}
func (s *fakeService) InspectRuntime(_ context.Context, agentID string) (deployment.Environment, error) {
	s.agentID = agentID
	return s.inspection, nil
}
func (s *fakeService) DeleteRuntime(
	_ context.Context, _ string, agentID string, revision deployment.RuntimeRevision,
) (deployment.Operation, error) {
	s.command, s.agentID, s.expectedRevision = deployment.OperationDeleteRuntime, agentID, revision
	return s.operation, nil
}
func (s *fakeService) GetOperation(context.Context, string) (deployment.Operation, error) {
	return s.operation, nil
}

func (s *fakeService) ListRuntimes(ctx context.Context) ([]deployment.Environment, error) {
	if s.blockListUntilCanceled {
		<-ctx.Done()
		return nil, ctx.Err()
	}
	return nil, nil
}
func (s *fakeService) ListObservations(
	_ context.Context, after uint64, limit int,
) (deployment.ObservationWindow, error) {
	s.after, s.limit = after, limit
	window := deployment.ObservationWindow{Observations: s.observations}
	if len(s.observations) > 0 {
		window.OldestSequence = s.observations[0].Sequence
		window.LatestSequence = s.observations[len(s.observations)-1].Sequence
	}
	return window, s.listErr
}

var _ Service = (*fakeService)(nil)
