package rpc

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"regexp"
	"strings"
	"testing"
	"time"

	"mime"

	"github.com/santhosh-tekuri/jsonschema/v6"

	"github.com/tf4fun/antnest-platform/services/runtime-controller/internal/acpincarnation"
	"github.com/tf4fun/antnest-platform/services/runtime-controller/internal/deployment"
	"github.com/tf4fun/antnest-platform/services/runtime-controller/internal/observation"
	"github.com/tf4fun/antnest-platform/services/runtime-controller/internal/platform"
	"github.com/tf4fun/antnest-platform/services/runtime-controller/internal/skillset"
)

func contractRefDoc(t *testing.T, file string) map[string]any {
	t.Helper()
	base := filepath.Join(serviceRoot(t), "../../contracts")
	clean := filepath.Clean(filepath.Join(base, "runtime-controller", file))
	if !strings.HasPrefix(clean, filepath.Clean(base)+string(filepath.Separator)) {
		t.Fatalf("reference escapes contract directory: %s", file)
	}
	var doc map[string]any
	readJSONFile(t, clean, &doc)
	return doc
}

func resolveContractRef(t *testing.T, docs map[string]map[string]any, base string, reference string) {
	t.Helper()
	file, fragment, _ := strings.Cut(reference, "#")
	target := file
	if target == "" {
		target = base
	}
	doc, ok := docs[target]
	if !ok {
		doc = contractRefDoc(t, target)
		docs[target] = doc
	}
	node := doc
	for _, segment := range strings.Split(strings.TrimPrefix(fragment, "/"), "/") {
		if segment == "" {
			continue
		}
		next, ok := node[segment]
		if !ok {
			t.Fatalf("unresolvable schema reference %s", reference)
		}
		node, ok = next.(map[string]any)
		if !ok {
			t.Fatalf("non-object schema segment in %s", reference)
		}
	}
}

func TestRouteSchemaDeclarationsResolve(t *testing.T) {
	root := serviceRoot(t)
	var contract map[string]any
	readJSONFile(t, filepath.Join(root, "../../contracts/runtime-controller/control-contract.json"), &contract)
	var schema map[string]any
	readJSONFile(t, filepath.Join(root, "../../contracts/runtime-controller/control-api.ids-v2.schema.json"), &schema)
	docs := map[string]map[string]any{"control-api.ids-v2.schema.json": schema}

	routes := contract["routes"].([]any)
	if len(routes) != 19 {
		t.Fatalf("expected 19 published routes, got %d", len(routes))
	}
	errorMap := contract["errors"].(map[string]any)
	seen := map[string]bool{}
	for _, item := range routes {
		route := item.(map[string]any)
		label := route["method"].(string) + " " + route["path"].(string)
		if seen[label] {
			t.Fatalf("duplicate route %s", label)
		}
		seen[label] = true
		if body, ok := route["request_body"].(string); ok && body != "none" {
			resolveContractRef(t, docs, "control-api.ids-v2.schema.json", body)
		} else if !ok {
			t.Fatalf("route %s missing request_body", label)
		}
		for _, raw := range route["responses"].(map[string]any) {
			entry := raw.(map[string]any)
			if body, ok := entry["body"].(string); ok && body != "none" {
				resolveContractRef(t, docs, "control-api.ids-v2.schema.json", body)
			}
			if sse, ok := entry["sse"].(map[string]any); ok {
				resolveContractRef(t, docs, "control-api.ids-v2.schema.json", sse["data"].(string))
				resolveContractRef(t, docs, "control-api.ids-v2.schema.json", sse["id"].(string))
			}
		}
		errs, _ := route["errors"].([]any)
		for _, code := range errs {
			entry, ok := errorMap[code.(string)].(map[string]any)
			if !ok {
				t.Fatalf("route %s declares unknown error %v", label, code)
			}
			if _, ok := entry["status"]; !ok {
				t.Fatalf("error %v has no status", code)
			}
			if body, ok := entry["body"].(string); ok {
				resolveContractRef(t, docs, "control-api.ids-v2.schema.json", body)
			}
		}
	}
}

const schemaBase = "https://schemas.antnest.dev/runtime-controller/"

func contractPattern(pattern string) (jsonschema.Regexp, error) {
	if suffix := `(?![\s\S])`; strings.HasSuffix(pattern, suffix) {
		pattern = strings.TrimSuffix(pattern, suffix) + `\z`
	}
	return regexp.Compile(pattern)
}

func TestRouteSchemaStrictEnd(t *testing.T) {
	shape, err := contractPattern(`^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?![\s\S])`)
	if err != nil {
		t.Fatal(err)
	}
	for _, input := range []string{"acp-a", "a", "member-123"} {
		if !shape.MatchString(input) {
			t.Fatalf("valid member rejected: %q", input)
		}
		for _, suffix := range []string{"\n", "\r\n", "\x00", " "} {
			if shape.MatchString(input + suffix) {
				t.Fatalf("strict end assertion admitted trailing bytes: %q", input+suffix)
			}
		}
	}
}

func schemaJSON(t *testing.T, compiler *jsonschema.Compiler, reference string) *jsonschema.Schema {
	t.Helper()
	shape, err := compiler.Compile(schemaBase + reference)
	if err != nil {
		t.Fatalf("compile %s: %v", reference, err)
	}
	return shape
}

func validateSchema(t *testing.T, compiler *jsonschema.Compiler, reference string, body []byte) {
	t.Helper()
	document, err := jsonschema.UnmarshalJSON(strings.NewReader(string(body)))
	if err != nil {
		t.Fatalf("decode JSON for %s: %v", reference, err)
	}
	if err := schemaJSON(t, compiler, reference).Validate(document); err != nil {
		t.Fatalf("schema %s rejected real payload: %v", reference, err)
	}
}

func assertRouteExchange(t *testing.T, compiler *jsonschema.Compiler, route contractRoute, recorder *httptest.ResponseRecorder) {
	t.Helper()
	label := route.Method + " " + route.Path
	reply, declared := route.Responses[fmt.Sprint(recorder.Code)]
	if !declared {
		t.Fatalf("%s returned undeclared success status %d", label, recorder.Code)
	}
	assertContentType(t, reply, recorder)
	if reply.SSE != nil {
		events := assertSSEResponse(t, compiler, reply, recorder)
		if events == 0 {
			t.Fatalf("%s produced no SSE events", label)
		}
		return
	}
	if reply.Body == "none" {
		if recorder.Body.Len() != 0 {
			t.Fatalf("%s declared empty body but got %d bytes", label, recorder.Body.Len())
		}
		return
	}
	validateSchema(t, compiler, reply.Body, recorder.Body.Bytes())
}

func assertContentType(t *testing.T, reply contractReply, recorder *httptest.ResponseRecorder) {
	t.Helper()
	actual := recorder.Header().Get("Content-Type")
	if reply.ContentType == "" {
		return
	}
	if actual == "" {
		t.Fatalf("response missing Content-Type, contract declares %s", reply.ContentType)
	}
	media, _, err := mime.ParseMediaType(actual)
	if err != nil {
		t.Fatalf("response Content-Type %q unparsable: %v", actual, err)
	}
	if media != reply.ContentType {
		t.Fatalf("Content-Type %q, contract declares %s", media, reply.ContentType)
	}
}

func assertSSEResponse(t *testing.T, compiler *jsonschema.Compiler, reply contractReply, recorder *httptest.ResponseRecorder) int {
	t.Helper()
	events := 0
	for _, frame := range strings.Split(recorder.Body.String(), "\n\n") {
		var data, id, event string
		for _, line := range strings.Split(frame, "\n") {
			if text, ok := strings.CutPrefix(line, "event:"); ok {
				event = strings.TrimSpace(text)
			}
			if text, ok := strings.CutPrefix(line, "data:"); ok {
				data = strings.TrimSpace(text)
			}
			if text, ok := strings.CutPrefix(line, "id:"); ok {
				id = strings.TrimSpace(text)
			}
		}
		if data == "" {
			continue
		}
		if reply.SSE.EventName != "" && event != reply.SSE.EventName {
			t.Fatalf("SSE event name %q, contract declares %s", event, reply.SSE.EventName)
		}
		if id == "" {
			t.Fatalf("SSE event missing required id")
		}
		events++
		validateSchema(t, compiler, reply.SSE.Data, []byte(data))
		validateSchema(t, compiler, reply.SSE.ID, []byte(id))
	}
	return events
}

func routeFixture() (inspection deployment.Environment, observations []deployment.Observation) {
	now := time.Date(2026, 9, 1, 0, 0, 0, 0, time.UTC)
	return deployment.Environment{
		TunnelKeyID:        "rtk_0123456789abcdef0123456789abcdef",
		Phase:              deployment.PhaseRunning,
		AgentID:            "agent-1",
		RuntimeRevision:    testRuntimeRevision,
		LifecycleState:     deployment.LifecycleProvisioned,
		Health:             deployment.HealthHealthy,
		MCPEndpoint:        "http://antnest-runtime-agent-1:8093/mcp",
		RuntimeEndpoint:    "10.243.1.20",
		RuntimeExecutionID: "boot-1",
		ObservedAt:         now,
	}, []deployment.Observation{
		{Sequence: 1, Kind: deployment.ObservationReconciled, ObservedAt: now},
		{Sequence: 2, Kind: deployment.ObservationUpdated, AgentID: "agent-1", RuntimeRevision: testRuntimeRevision, ObservedAt: now},
		{Sequence: 3, Kind: deployment.ObservationHealthy, AgentID: "agent-1", RuntimeRevision: testRuntimeRevision, RuntimeExecutionID: "boot-1", ObservedAt: now},
	}
}

func TestRouteSchemaRealHandlers(t *testing.T) {
	compiler := contractCompiler(t)
	compiler.UseRegexpEngine(contractPattern)
	var contract machineContract
	readJSONFile(t, filepath.Join(serviceRoot(t), "../../contracts/runtime-controller/control-contract.json"), &contract)
	inspection, observations := routeFixture()

	covered := map[string]bool{}
	serve := func(route contractRoute, handler http.Handler, method, path, body, caller string, idempotent bool) []byte {
		t.Helper()
		label := method + " " + route.Path
		if covered[label] {
			t.Fatalf("duplicate coverage for %s", label)
		}
		covered[label] = true
		request := incarnationRPCRequest(method, path, body, caller)
		if body != "" {
			request.Header.Set("Content-Type", "application/json")
		}
		if idempotent {
			request.Header.Set("Idempotency-Key", "request-1")
		}
		if route.RequestBody != "" && route.RequestBody != "none" {
			if body == "" {
				t.Fatalf("%s expects %s but request was empty", label, route.RequestBody)
			}
			validateSchema(t, compiler, route.RequestBody, []byte(body))
		}
		recorder := httptest.NewRecorder()
		handler.ServeHTTP(recorder, request)
		assertRouteExchange(t, compiler, route, recorder)
		return recorder.Body.Bytes()
	}
	find := func(method, path string) contractRoute {
		t.Helper()
		for _, route := range contract.Routes {
			if route.Method == method && route.Path == path {
				return route
			}
		}
		t.Fatalf("missing contract route %s %s", method, path)
		return contractRoute{}
	}
	revision := string(testRuntimeRevision)
	configuration := `{"image_ref":"runtime:v1","network":{"packet_contract_revision":2,"egress_endpoint":{"ipv4":"10.243.0.1","port":48200},"tunnel_ipv4":"10.243.1.20","resolver_ipv4":"10.243.0.1"},"resources":{"memory_bytes":134217728,"pids_limit":16,"tmpfs_bytes":16777216}}`

	controllerService := func(operation deployment.Operation) *fakeService {
		return &fakeService{inspection: inspection, observations: observations, operation: operation}
	}

	service := controllerService(deployment.Operation{
		RequestID: "request-1", Kind: deployment.OperationInitializeRuntime,
		AgentID: "agent-1", RuntimeRevision: testRuntimeRevision,
		State: deployment.OperationCompleted, Effect: deployment.EffectCompleted,
	})
	handler := newTestHandler(t, service)

	serve(find("GET", "/status"), handler, "GET", "/status", "", "agent-controller", false)
	serve(find("GET", "/internal/runtimes"), handler, "GET", "/internal/runtimes", "", "agent-controller", false)
	serve(find("GET", "/internal/runtimes/{agent_id}"), handler, "GET", "/internal/runtimes/agent-1", "", "agent-controller", false)
	serve(find("GET", "/internal/runtime-operations/{request_id}"), handler, "GET", "/internal/runtime-operations/request-1", "", "agent-controller", false)
	serve(find("GET", "/internal/runtime-observations"), handler, "GET", "/internal/runtime-observations?after_sequence=0&limit=20", "", "agent-controller", false)

	lifecycle := []struct {
		path, kind string
		body       string
	}{
		{"/initialize", "initialize", `{"configuration":` + configuration + `}`},
		{"/update", "update", `{"expected_version":"` + revision + `","configuration":` + configuration + `}`},
		{"/enable", "enable", `{"expected_version":"` + revision + `","configuration":` + configuration + `}`},
		{"/disable", "disable", `{"expected_version":"` + revision + `"}`},
		{"/delete", "delete", `{"expected_version":"` + revision + `"}`},
	}
	operationKind := map[string]deployment.OperationKind{
		"initialize": deployment.OperationInitializeRuntime,
		"update":     deployment.OperationUpdateRuntime,
		"enable":     deployment.OperationEnableRuntime,
		"disable":    deployment.OperationDisableRuntime,
		"delete":     deployment.OperationDeleteRuntime,
	}
	for _, item := range lifecycle {
		service := controllerService(deployment.Operation{
			RequestID: "request-1", Kind: operationKind[item.kind],
			AgentID: "agent-1", RuntimeRevision: testRuntimeRevision,
			State: deployment.OperationCompleted, Effect: deployment.EffectCompleted,
		})
		handler := newTestHandler(t, service)
		route := find("POST", "/internal/runtimes/{agent_id}"+item.path)
		serve(route, handler, "POST", "/internal/runtimes/agent-1"+item.path, item.body, "agent-controller", true)
	}

	watch := find("GET", "/internal/runtime-observations/watch")
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	request := incarnationRPCRequest("GET", "/internal/runtime-observations/watch?after_sequence=0&limit=20", "", "agent-controller").WithContext(ctx)
	recorder := &routeStreamRecorder{ResponseRecorder: httptest.NewRecorder(), cancel: cancel}
	handler.ServeHTTP(recorder, request)
	assertRouteExchange(t, compiler, watch, recorder.ResponseRecorder)
	covered[watch.Method+" "+watch.Path] = true

	image := imageService{fakeService: &fakeService{}, resolve: func(_ context.Context, _ string) (platform.ImageResolution, error) {
		return platform.ImageResolution{Reference: "runtime:v1", ImageRef: "sha256:" + strings.Repeat("a", 64)}, nil
	}}
	imageHandler, err := newAuthenticatedHandler(image, observation.NewHub(), time.Second, time.Second)
	if err != nil {
		t.Fatal(err)
	}
	serve(find("GET", "/internal/runtime-images/resolve"), imageHandler, "GET", "/internal/runtime-images/resolve?reference=runtime:v1", "", "agent-controller", false)

	connection := &connectionServiceStub{fakeService: &fakeService{}}
	connectionHandler, err := newAuthenticatedHandler(connection, observation.NewHub(), time.Second, time.Second)
	if err != nil {
		t.Fatal(err)
	}
	serve(find("POST", "/internal/runtimes/{agent_id}/connection"), connectionHandler, "POST", "/internal/runtimes/agent-1/connection", `{"runtime_revision":"`+revision+`","expected_execution_id":"boot-1"}`, "agent-controller", false)

	stub := &routePreparationStub{}
	preparationHandler, err := newAuthenticatedHandler(&fakeService{}, observation.NewHub(), time.Second, time.Minute, stub)
	if err != nil {
		t.Fatal(err)
	}
	prepareBody := `{"organization_id":"org_00000000000000000000000000000000","owner_operation_id":"build-1","layout_version":1,"skill_set_digest":"sha256:` + strings.Repeat("a", 64) + `","system_skills":[]}`
	serve(find("POST", "/internal/runtimes/{agent_id}/skill-sets/prepare"), preparationHandler, "POST", "/internal/runtimes/agent-1/skill-sets/prepare", prepareBody, "agent-controller", true)
	serve(find("GET", "/internal/runtimes/{agent_id}/skill-sets/preparations/{request_id}"), preparationHandler, "GET", "/internal/runtimes/agent-1/skill-sets/preparations/request-1?organization_id=org_00000000000000000000000000000000", "", "agent-controller", false)
	serve(find("POST", "/internal/runtimes/{agent_id}/skill-sets/preparations/{request_id}/release"), preparationHandler, "POST", "/internal/runtimes/agent-1/skill-sets/preparations/request-1/release", `{"organization_id":"org_00000000000000000000000000000000","owner_operation_id":"build-1"}`, "agent-controller", true)
	if !stub.released {
		t.Fatal("release response succeeded but the preparation was not released")
	}

	incarnation := &incarnationRPCStub{}
	incarnationHandler, _, _ := incarnationRPCHandler(t, incarnation)
	input, _ := json.Marshal(incarnationRPCInput())
	serve(find("POST", "/internal/acp-incarnations/register"), incarnationHandler, "POST", incarnationRPCRegisterPath, string(input), "agent-acp-service", false)
	serve(find("GET", "/internal/acp-incarnations/{registration_id}"), incarnationHandler, "GET", incarnationRPCInspectPath, "", "agent-acp-service", false)

	history := &historyRPCPort{history: func(context.Context, acpincarnation.HistoryRequest) (acpincarnation.HistoryPage, error) {
		return historyRPCPage(1), nil
	}}
	historyHandler := historyRPCHandler(t, history, time.Second)
	serve(find("POST", "/internal/acp-incarnations/history"), historyHandler, "POST", "/internal/acp-incarnations/history", `{"member_id":"acp-a","cursor":null}`, "agent-acp-service", false)

	for _, route := range contract.Routes {
		if !covered[route.Method+" "+route.Path] {
			t.Fatalf("contract route %s %s has no real-handler coverage", route.Method, route.Path)
		}
	}
	if len(covered) != len(contract.Routes) {
		t.Fatalf("coverage %d routes, contract declares %d", len(covered), len(contract.Routes))
	}
}

type routeStreamRecorder struct {
	*httptest.ResponseRecorder
	cancel context.CancelFunc
}

func (r *routeStreamRecorder) Flush() {
	r.ResponseRecorder.Flush()
	if strings.Contains(r.Body.String(), "data:") {
		r.cancel()
	}
}

type routePreparationStub struct {
	preparationStub
	released bool
}

func (s *routePreparationStub) Prepare(_ context.Context, requestID, agentID string, input skillset.PrepareRequest) (skillset.PreparationReceipt, error) {
	return skillset.PreparationReceipt{
		RequestID: requestID, AgentID: agentID,
		OrganizationID: input.OrganizationID, OwnerOperationID: input.OwnerOperationID,
		State: skillset.PreparationQueued,
	}, nil
}

func (s *routePreparationStub) Get(_ context.Context, org, agentID, requestID string) (skillset.PreparationReceipt, error) {
	return skillset.PreparationReceipt{
		RequestID: requestID, AgentID: agentID,
		OrganizationID: org, OwnerOperationID: "build-1",
		State: skillset.PreparationQueued,
	}, nil
}

func (s *routePreparationStub) Release(ctx context.Context, org, agentID, requestID, owner string) error {
	s.released = true
	return s.preparationStub.Release(ctx, org, agentID, requestID, owner)
}

func TestResourceIDContractRefWithinContracts(t *testing.T) {
	for _, file := range []string{"runtime-deployment.ids-v2.schema.json", "../common/ids.schema.json"} {
		if doc := contractRefDoc(t, file); len(doc) == 0 {
			t.Fatalf("expected schema document for %s", file)
		}
	}
}
