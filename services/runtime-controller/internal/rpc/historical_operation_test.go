package rpc

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"slices"
	"strings"
	"testing"
	"time"

	"soft/antnest-platform/services/runtime-controller/internal/deployment"
)

func TestOperationWireTimestampsMatchDatabasePrecision(t *testing.T) {
	now := time.Date(2026, 9, 13, 0, 0, 0, 123456789, time.UTC)
	fresh := operationFromDomain(deployment.Operation{CreatedAt: now, UpdatedAt: now})
	replayed := operationFromDomain(deployment.Operation{
		CreatedAt: now.Truncate(time.Microsecond), UpdatedAt: now.Truncate(time.Microsecond),
	})
	if !fresh.CreatedAt.Equal(replayed.CreatedAt) || !fresh.UpdatedAt.Equal(replayed.UpdatedAt) {
		t.Fatalf("operation timestamps change after database round trip: fresh=%+v replayed=%+v", fresh, replayed)
	}
}

func TestHistoricalReadinessFailureRemainsReadableAndReplayable(t *testing.T) {
	service := &fakeService{operation: deployment.Operation{
		RequestID: "historical-init", Kind: deployment.OperationInitializeRuntime,
		State: deployment.OperationFailed, Effect: deployment.EffectCompleted,
		ErrorCode: "runtime_not_ready", ErrorDetail: "PRIVATE_PROCESS_ENV",
	}}
	handler := newTestHandler(t, service)
	read := httptest.NewRecorder()
	handler.ServeHTTP(read, httptest.NewRequest(http.MethodGet, "/internal/runtime-operations/historical-init", nil))
	var operation operationDTO
	if err := json.Unmarshal(read.Body.Bytes(), &operation); err != nil {
		t.Fatal(err)
	}
	if read.Code != http.StatusOK || operation.State != deployment.OperationFailed || operation.Effect != deployment.EffectCompleted || operation.ErrorCode != "runtime_not_ready" {
		t.Fatalf("historical operation changed: %d %+v", read.Code, operation)
	}
	request := httptest.NewRequest(http.MethodPost, "/internal/runtimes/agent-1/initialize", strings.NewReader(`{"configuration":{}}`))
	request.Header.Set("Idempotency-Key", "historical-init")
	replay := httptest.NewRecorder()
	handler.ServeHTTP(replay, request)
	var failure errorResponse
	if err := json.Unmarshal(replay.Body.Bytes(), &failure); err != nil {
		t.Fatal(err)
	}
	if replay.Code != http.StatusInternalServerError || failure.Code != "runtime_not_ready" || failure.Retryable || strings.Contains(replay.Body.String(), "PRIVATE_PROCESS_ENV") {
		t.Fatalf("historical replay changed: %d %+v", replay.Code, failure)
	}
	var contract machineContract
	readJSONFile(t, filepath.Join(serviceRoot(t), "api/control-contract.json"), &contract)
	definition := contract.OperationErrorCodes[failure.Code]
	if !slices.Contains(definition.HTTPStatuses, replay.Code) || !slices.Contains(definition.OperationStates, string(operation.State)) || !slices.Contains(definition.Effects, string(operation.Effect)) {
		t.Fatalf("historical failure missing from operation contract: %+v", definition)
	}
	for _, route := range contract.Routes {
		if route.OperationID == "initializeRuntime" && !slices.Contains(route.Errors, failure.Code) {
			t.Fatal("initialize contract omits historical replay error")
		}
	}
}
