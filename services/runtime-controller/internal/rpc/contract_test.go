package rpc

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	goruntime "runtime"
	"slices"
	"strings"
	"testing"
	"time"

	"soft/antnest-platform/services/runtime-controller/internal/control"
	"soft/antnest-platform/services/runtime-controller/internal/deployment"
)

type machineContract struct {
	Schemas map[string]string `json:"schemas"`
	Headers map[string]struct {
		Required bool   `json:"required"`
		Schema   string `json:"schema"`
	} `json:"headers"`
	Routes []contractRoute `json:"routes"`
	Errors map[string]struct {
		Status    int    `json:"status"`
		Retryable bool   `json:"retryable"`
		Body      string `json:"body"`
	} `json:"errors"`
	OperationErrorCodes map[string]struct {
		OperationStates      []string `json:"operation_states"`
		Effects              []string `json:"effects"`
		HTTPStatuses         []int    `json:"http_statuses"`
		RetrySameRequestOnly bool     `json:"retry_same_request_only"`
	} `json:"operation_error_codes"`
}

type contractRoute struct {
	OperationID     string                   `json:"operation_id"`
	Method          string                   `json:"method"`
	Path            string                   `json:"path"`
	PathParameters  map[string]string        `json:"path_parameters"`
	QueryParameters map[string]string        `json:"query_parameters"`
	RequiredHeaders []string                 `json:"required_headers"`
	RequestBody     string                   `json:"request_body"`
	Responses       map[string]contractReply `json:"responses"`
	Errors          []string                 `json:"errors"`
}

type contractReply struct {
	ContentType string `json:"content_type"`
	Body        string `json:"body"`
	SSE         *struct {
		EventName               string `json:"event_name"`
		ID                      string `json:"id"`
		Data                    string `json:"data"`
		ResumeWith              string `json:"resume_with"`
		Delivery                string `json:"delivery"`
		InitialReadBeforeStatus bool   `json:"initial_read_before_status"`
		PostCommitFailure       string `json:"post_commit_failure"`
	} `json:"sse"`
}

type controlSchema struct {
	Defs map[string]struct {
		Required []string          `json:"required"`
		OneOf    []json.RawMessage `json:"oneOf"`
		AllOf    []json.RawMessage `json:"allOf"`
	} `json:"$defs"`
}

func TestMachineContractCoversRegisteredHTTPBoundary(t *testing.T) {
	root := serviceRoot(t)
	var contract machineContract
	readJSONFile(t, filepath.Join(root, "api/control-contract.json"), &contract)
	var schema controlSchema
	readJSONFile(t, filepath.Join(root, "api/control-api.schema.json"), &schema)

	expectedRoutes := map[string][]string{
		"GET /status":                                   {"200", "503"},
		"GET /internal/runtimes":                        {"200"},
		"GET /internal/runtimes/{agent_id}":             {"200"},
		"POST /internal/runtimes/{agent_id}/initialize": {"200", "202"},
		"POST /internal/runtimes/{agent_id}/update":     {"200", "202"},
		"POST /internal/runtimes/{agent_id}/disable":    {"200", "202"},
		"POST /internal/runtimes/{agent_id}/enable":     {"200", "202"},
		"POST /internal/runtimes/{agent_id}/delete":     {"200", "202"},
		"GET /internal/runtime-operations/{request_id}": {"200"},
		"GET /internal/runtime-observations":            {"200"},
		"GET /internal/runtime-observations/watch":      {"200"},
	}
	if len(contract.Routes) != len(expectedRoutes) {
		t.Fatalf("contract routes=%d want=%d", len(contract.Routes), len(expectedRoutes))
	}
	for _, route := range contract.Routes {
		key := route.Method + " " + route.Path
		statuses, ok := expectedRoutes[key]
		if !ok {
			t.Fatalf("unexpected contract route %s", key)
		}
		if route.OperationID == "" {
			t.Fatalf("route %s has no operation_id", key)
		}
		for _, parameter := range pathParameters(route.Path) {
			reference := route.PathParameters[parameter]
			if reference == "" {
				t.Fatalf("route %s does not type path parameter %s", key, parameter)
			}
			assertKnownSchemaReference(t, schema, reference)
		}
		for _, reference := range route.QueryParameters {
			assertKnownSchemaReference(t, schema, reference)
		}
		for _, status := range statuses {
			response, ok := route.Responses[status]
			if !ok || response.ContentType == "" || response.Body == "" {
				t.Fatalf("route %s has incomplete %s response: %+v", key, status, response)
			}
			assertKnownSchemaReference(t, schema, response.Body)
			if response.ContentType == "text/event-stream" {
				if response.SSE == nil || response.SSE.EventName == "" || response.SSE.ID == "" ||
					response.SSE.Data == "" || response.SSE.ResumeWith == "" || response.SSE.Delivery == "" ||
					!response.SSE.InitialReadBeforeStatus || response.SSE.PostCommitFailure != "disconnect_and_resume" {
					t.Fatalf("route %s has incomplete SSE framing: %+v", key, response.SSE)
				}
				assertKnownSchemaReference(t, schema, response.SSE.ID)
				assertKnownSchemaReference(t, schema, response.SSE.Data)
			}
		}
		if route.Method == "POST" {
			if !slices.Contains(route.RequiredHeaders, "Idempotency-Key") {
				t.Fatalf("mutation route %s omits Idempotency-Key", key)
			}
			for _, code := range []string{"agent_mutation_in_progress", "mutation_lock_lost"} {
				if !slices.Contains(route.Errors, code) {
					t.Fatalf("mutation route %s omits coordination error %s", key, code)
				}
			}
		}
		for _, header := range route.RequiredHeaders {
			definition, ok := contract.Headers[header]
			if !ok || !definition.Required || definition.Schema == "" {
				t.Fatalf("route %s references incomplete header %s", key, header)
			}
			assertKnownSchemaReference(t, schema, definition.Schema)
		}
		if route.RequestBody != "" {
			assertKnownSchemaReference(t, schema, route.RequestBody)
		}
		for _, code := range route.Errors {
			if _, ok := contract.Errors[code]; !ok {
				t.Fatalf("route %s references unknown error %s", key, code)
			}
		}
		delete(expectedRoutes, key)
	}
	if len(expectedRoutes) != 0 {
		t.Fatalf("contract is missing routes: %+v", expectedRoutes)
	}
	for code, definition := range contract.Errors {
		if definition.Status < 400 || definition.Status > 599 || definition.Body == "" {
			t.Fatalf("error %s has incomplete HTTP mapping: %+v", code, definition)
		}
		assertKnownSchemaReference(t, schema, definition.Body)
	}
	for _, code := range []string{
		"runtime_not_ready", "runtime_drift", "storage_in_use", "storage_not_found",
		"storage_ownership_conflict", "platform_unavailable",
	} {
		definition, ok := contract.OperationErrorCodes[code]
		if !ok || len(definition.OperationStates) == 0 || len(definition.Effects) == 0 ||
			len(definition.HTTPStatuses) == 0 {
			t.Fatalf("operation error %s has no complete state/effect/HTTP contract: %+v", code, definition)
		}
	}
}

func TestMachineSSEContractMatchesWireFraming(t *testing.T) {
	root := serviceRoot(t)
	var contract machineContract
	readJSONFile(t, filepath.Join(root, "api/control-contract.json"), &contract)
	var watch contractReply
	for _, route := range contract.Routes {
		if route.Method == "GET" && route.Path == "/internal/runtime-observations/watch" {
			watch = route.Responses["200"]
			break
		}
	}
	if watch.SSE == nil {
		t.Fatal("watch route has no SSE contract")
	}
	service := &fakeService{observations: []deployment.Observation{{
		Sequence: 11, Kind: deployment.ObservationReconciled,
		Source: "contract_test", ObservedAt: time.Date(2026, 8, 30, 0, 0, 0, 0, time.UTC),
	}}}
	handler := newTestHandler(t, service).(*Handler)
	request := httptest.NewRequest(http.MethodGet, "/internal/runtime-observations/watch?after_sequence=10", nil)
	response := httptest.NewRecorder()
	cursor, err := handler.writeAvailable(response, request, http.NewResponseController(response), 10)
	if err != nil || cursor != 11 {
		t.Fatalf("write SSE fixture: cursor=%d err=%v", cursor, err)
	}
	body := response.Body.String()
	if !strings.Contains(body, "id: 11\n") ||
		!strings.Contains(body, "event: "+watch.SSE.EventName+"\n") ||
		!strings.Contains(body, "data: {") {
		t.Fatalf("SSE wire frame does not match contract: %q", body)
	}
}

func TestMachineSchemaMatchesGoWireTypes(t *testing.T) {
	root := serviceRoot(t)
	var schema controlSchema
	readJSONFile(t, filepath.Join(root, "api/control-api.schema.json"), &schema)
	now := time.Date(2026, 8, 30, 0, 0, 0, 0, time.UTC)
	inspection := deployment.Environment{
		AgentID: "agent-1", RuntimeRevision: testRuntimeRevision,
		LifecycleState: deployment.LifecycleReady,
		Health:         deployment.HealthHealthy, RestartCount: 0, ObservedAt: now,
	}
	assertRequiredFields(t, schema, "initialize_request", initializeRequest{Configuration: configurationDTO{}})
	assertRequiredFields(t, schema, "revision_request", revisionRequest{ExpectedRevision: testRuntimeRevision})
	assertRequiredFields(t, schema, "revision_configuration_request", revisionConfigurationRequest{
		ExpectedRevision: testRuntimeRevision, Configuration: configurationDTO{},
	})
	assertRequiredFields(t, schema, "readiness", readinessFromDomain("ready", control.Readiness{
		DatabaseReady: true, PlatformReady: true, ObservationReady: true,
	}))
	assertRequiredFields(t, schema, "runtime_inspection", runtimeInspectionFromDomain(inspection))
	assertRequiredFields(t, schema, "runtime_list", runtimesResponse{
		Runtimes: []runtimeInspectionDTO{runtimeInspectionFromDomain(inspection)},
	})
	assertRequiredFields(t, schema, "operation", operationFromDomain(deployment.Operation{
		RequestID: "request-1", RequestDigest: "sha256:" + strings.Repeat("a", 64),
		Kind: deployment.OperationInitializeRuntime, AgentID: "agent-1",
		RuntimeRevision: testRuntimeRevision,
		State:           deployment.OperationCompleted, Effect: deployment.EffectCompleted,
		CreatedAt: now, UpdatedAt: now,
	}))
	observationValue := deployment.Observation{
		Sequence: 1, Kind: deployment.ObservationReconciled, Source: "test", ObservedAt: now,
	}
	assertRequiredFields(t, schema, "service_observation", observationFromDomain(observationValue))
	assertRequiredFields(t, schema, "observation_list", observationsResponse{
		Observations:   []observationDTO{observationFromDomain(observationValue)},
		OldestSequence: 1, LatestSequence: 1, NextSequence: 1,
	})
	assertRequiredFields(t, schema, "error", errorResponse{
		Code: "invalid_request", Message: "request is invalid", Retryable: false,
	})
	if len(schema.Defs["observation"].OneOf) != 3 {
		t.Fatalf("observation schema does not discriminate service, Environment, and Runtime facts")
	}
	if len(schema.Defs["error"].AllOf) == 0 {
		t.Fatal("error schema does not require reset_sequence only for cursor expiry")
	}
}

func TestLogicalWireTypesHidePhysicalRuntimeIdentity(t *testing.T) {
	now := time.Date(2026, 8, 31, 0, 0, 0, 0, time.UTC)
	environment := deployment.Environment{
		AgentID: "agent-1", RuntimeRevision: testRuntimeRevision,
		LifecycleState: deployment.LifecycleReady, Health: deployment.HealthHealthy,
		Generation:  9,
		SpecDigest:  "sha256:" + strings.Repeat("a", 64),
		OperationID: "private-operation", ObservedAt: now,
	}
	operation := deployment.Operation{
		RequestID: "request-1", Kind: deployment.OperationUpdateRuntime,
		AgentID: "agent-1", RuntimeRevision: testRuntimeRevision,
		State: deployment.OperationCompleted, Effect: deployment.EffectCompleted,
		Inspection: &environment, Generation: 9,
		SpecDigest: "sha256:" + strings.Repeat("a", 64),
		CreatedAt:  now, UpdatedAt: now,
	}
	for name, value := range map[string]any{
		"environment": runtimeInspectionFromDomain(environment),
		"operation":   operationFromDomain(operation),
	} {
		encoded, err := json.Marshal(value)
		if err != nil {
			t.Fatal(err)
		}
		for _, forbidden := range []string{"generation", "spec_digest", "operation_id", "platform_resource_id"} {
			if strings.Contains(string(encoded), `"`+forbidden+`"`) {
				t.Fatalf("%s leaked private field %s: %s", name, forbidden, encoded)
			}
		}
	}
}

func serviceRoot(t *testing.T) string {
	t.Helper()
	_, file, _, ok := goruntime.Caller(0)
	if !ok {
		t.Fatal("resolve contract test path")
	}
	return filepath.Clean(filepath.Join(filepath.Dir(file), "../.."))
}

func readJSONFile(t *testing.T, path string, target any) {
	t.Helper()
	encoded, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal(encoded, target); err != nil {
		t.Fatalf("parse %s: %v", path, err)
	}
}

func pathParameters(path string) []string {
	var result []string
	for _, segment := range strings.Split(path, "/") {
		if strings.HasPrefix(segment, "{") && strings.HasSuffix(segment, "}") {
			result = append(result, strings.TrimSuffix(strings.TrimPrefix(segment, "{"), "}"))
		}
	}
	return result
}

func assertKnownSchemaReference(t *testing.T, schema controlSchema, reference string) {
	t.Helper()
	const prefix = "control-api.schema.json#/$defs/"
	if strings.HasPrefix(reference, prefix) {
		name := strings.TrimPrefix(reference, prefix)
		if _, ok := schema.Defs[name]; !ok {
			t.Fatalf("unknown control schema reference %s", reference)
		}
		return
	}
	if reference != "runtime-deployment.schema.json" {
		t.Fatalf("unknown schema reference %s", reference)
	}
}

func assertRequiredFields(t *testing.T, schema controlSchema, name string, value any) {
	t.Helper()
	definition, ok := schema.Defs[name]
	if !ok {
		t.Fatalf("missing schema definition %s", name)
	}
	encoded, err := json.Marshal(value)
	if err != nil {
		t.Fatal(err)
	}
	var object map[string]json.RawMessage
	if err := json.Unmarshal(encoded, &object); err != nil {
		t.Fatal(err)
	}
	for _, field := range definition.Required {
		if _, ok := object[field]; !ok {
			t.Fatalf("Go wire type for %s omits required field %s: %s", name, field, encoded)
		}
	}
}
