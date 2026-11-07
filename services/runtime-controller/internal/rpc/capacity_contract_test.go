package rpc

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"

	"github.com/tf4fun/antnest-platform/services/runtime-controller/internal/control"
	"github.com/tf4fun/antnest-platform/services/runtime-controller/internal/deployment"
)

func TestCapacityExhaustedOperationIsRetryableNotStarted503(t *testing.T) {
	service := &fakeService{operation: deployment.Operation{
		RequestID: "request-1", Kind: deployment.OperationInitializeRuntime,
		AgentID: "agent-1", RuntimeRevision: testRuntimeRevision,
		State: deployment.OperationFailed, Effect: deployment.EffectNotStarted,
		ErrorCode: "runtime_capacity_exhausted",
	}}
	handler := newTestHandler(t, service)
	request := httptest.NewRequest(http.MethodPost, "/internal/runtimes/agent-1/initialize", strings.NewReader(`{"configuration":{}}`))
	request.Header.Set("Idempotency-Key", "request-1")
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	var failure errorResponse
	if err := json.Unmarshal(response.Body.Bytes(), &failure); err != nil {
		t.Fatal(err)
	}
	if response.Code != http.StatusServiceUnavailable || failure.Code != "runtime_capacity_exhausted" || !failure.Retryable {
		t.Fatalf("capacity rejection: HTTP %d body=%s", response.Code, response.Body.String())
	}
}

func TestReadinessExposesCachedCapacityFields(t *testing.T) {
	service := &fakeService{}
	handler := newTestHandler(t, service)
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, httptest.NewRequest(http.MethodGet, "/status", nil))
	var body map[string]any
	if err := json.Unmarshal(response.Body.Bytes(), &body); err != nil {
		t.Fatal(err)
	}
	for _, field := range []string{"runtime_capacity", "runtime_count", "runtime_capacity_known"} {
		if _, ok := body[field]; !ok {
			t.Fatalf("readiness omits %s: %s", field, response.Body.String())
		}
	}
	if body["runtime_capacity_known"] != false {
		t.Fatalf("capability-less service claimed known capacity: %s", response.Body.String())
	}
	var schema controlSchema
	readJSONFile(t, filepath.Join(serviceRoot(t), "../../contracts/runtime-controller/control-api.schema.json"), &schema)
	assertRequiredFields(t, schema, "readiness", body)
}

func TestCapacitySnapshotFieldsFollowTheCachedValues(t *testing.T) {
	service := &fakeService{readiness: control.Readiness{
		DatabaseReady: true, PlatformReady: true, ObservationReady: true, MonitorReady: true,
		RuntimeCapacity: 251, RuntimeCount: 2, RuntimeCapacityKnown: true,
	}}
	handler := newTestHandler(t, service)
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, httptest.NewRequest(http.MethodGet, "/status", nil))
	var body map[string]any
	if err := json.Unmarshal(response.Body.Bytes(), &body); err != nil {
		t.Fatal(err)
	}
	if body["runtime_capacity"] != float64(251) || body["runtime_count"] != float64(2) || body["runtime_capacity_known"] != true {
		t.Fatalf("capacity snapshot was not forwarded: %s", response.Body.String())
	}
}

func TestMachineContractDeclaresCapacityExhaustion(t *testing.T) {
	root := serviceRoot(t)
	var contract machineContract
	readJSONFile(t, filepath.Join(root, "../../contracts/runtime-controller/control-contract.json"), &contract)
	if contract.Revision != 22 {
		t.Fatalf("contract revision: %d", contract.Revision)
	}
	definition, ok := contract.Errors["runtime_capacity_exhausted"]
	if !ok || definition.Status != http.StatusServiceUnavailable || !definition.Retryable || definition.Body == "" {
		t.Fatalf("capacity error mapping: %+v", definition)
	}
	code, ok := contract.OperationErrorCodes["runtime_capacity_exhausted"]
	if !ok || len(code.OperationStates) == 0 || len(code.Effects) == 0 || len(code.HTTPStatuses) == 0 {
		t.Fatalf("capacity operation mapping: %+v", code)
	}
	routes := 0
	for _, route := range contract.Routes {
		if route.Method == "POST" && strings.HasSuffix(route.Path, "/initialize") ||
			strings.HasSuffix(route.Path, "/update") || strings.HasSuffix(route.Path, "/enable") {
			routes++
			found := false
			for _, name := range route.Errors {
				if name == "runtime_capacity_exhausted" {
					found = true
				}
			}
			if !found {
				t.Fatalf("compute route %s omits the capacity error", route.Path)
			}
		}
	}
	if routes != 3 {
		t.Fatalf("expected three compute routes, saw %d", routes)
	}
}
