package e2e

import (
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/propagation"
	sdktrace "go.opentelemetry.io/otel/sdk/trace"
	"go.opentelemetry.io/otel/sdk/trace/tracetest"
	"go.opentelemetry.io/otel/trace"
	commonpb "go.temporal.io/api/common/v1"
	temporalotel "go.temporal.io/sdk/contrib/opentelemetry"
	"go.temporal.io/sdk/converter"
	"go.temporal.io/sdk/interceptor"
	"go.temporal.io/sdk/testsuite"
	"go.temporal.io/sdk/worker"

	"soft/antnest-platform/services/agent-controller/internal/application"
	"soft/antnest-platform/services/agent-controller/internal/credentials"
	"soft/antnest-platform/services/agent-controller/internal/domain"
	"soft/antnest-platform/services/agent-controller/internal/egressclient"
	"soft/antnest-platform/services/agent-controller/internal/orchestration"
	"soft/antnest-platform/services/agent-controller/internal/ports"
	"soft/antnest-platform/services/agent-controller/internal/repository/postgres"
	"soft/antnest-platform/services/agent-controller/internal/runtimeclient"
	"soft/antnest-platform/services/agent-controller/internal/server"
	"soft/antnest-platform/services/agent-controller/internal/telemetry"
)

func TestAgentLifecycleAcrossHTTPPostgresAndDependencyContracts(t *testing.T) {
	if os.Getenv("ANTNEST_AGENT_CONTROLLER_TEST_DATABASE_URL") == "" {
		t.Skip("ANTNEST_AGENT_CONTROLLER_TEST_DATABASE_URL is not set")
	}
	previousProvider := otel.GetTracerProvider()
	previousPropagator := otel.GetTextMapPropagator()
	traceProvider := sdktrace.NewTracerProvider()
	otel.SetTracerProvider(traceProvider)
	otel.SetTextMapPropagator(propagation.TraceContext{})
	t.Cleanup(func() {
		_ = traceProvider.Shutdown(context.Background())
		otel.SetTracerProvider(previousProvider)
		otel.SetTextMapPropagator(previousPropagator)
	})
	for _, scenario := range []struct {
		name        string
		runtimeLost bool
	}{
		{name: "available"},
		{name: "runtime_loss", runtimeLost: true},
	} {
		t.Run(scenario.name, func(t *testing.T) {
			spanRecorder := tracetest.NewSpanRecorder()
			traceProvider.RegisterSpanProcessor(spanRecorder)
			t.Cleanup(func() { traceProvider.UnregisterSpanProcessor(spanRecorder) })
			testAgentLifecycleAcrossHTTP(t, scenario.runtimeLost, spanRecorder)
		})
	}
}

func testAgentLifecycleAcrossHTTP(t *testing.T, runtimeLost bool, spanRecorder *tracetest.SpanRecorder) {
	t.Helper()
	databaseURL := os.Getenv("ANTNEST_AGENT_CONTROLLER_TEST_DATABASE_URL")
	ctx := context.Background()
	resetE2ESchema(t, ctx, databaseURL)
	repository, err := postgres.Open(ctx, databaseURL)
	if err != nil {
		t.Fatalf("open repository: %v", err)
	}
	t.Cleanup(repository.Close)
	if err := repository.Migrate(ctx); err != nil {
		t.Fatalf("migrate repository: %v", err)
	}
	eventNotifier, err := postgres.OpenEventNotifier(ctx, databaseURL)
	if err != nil {
		t.Fatalf("open Agent event notifier: %v", err)
	}
	t.Cleanup(eventNotifier.Close)
	secretBox, err := credentials.NewSecretBox(make([]byte, 32))
	if err != nil {
		t.Fatalf("create SecretBox: %v", err)
	}
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))

	var egressCalls, runtimeCalls atomic.Int64
	var initializeCalls, updateCalls, disableCalls, enableCalls, deleteCalls atomic.Int64
	var failNextDeleteInspection atomic.Bool
	var policyMu sync.Mutex
	var runtimeMu sync.Mutex
	var currentRuntimeRevision, currentRuntimeExecutionID, currentRuntimeEndpoint string
	var currentRuntimeLifecycle, currentRuntimeHealth string
	runtimeRequestIDs := make(map[string]string)
	type egressAgentState struct {
		policyID          string
		policyVersion     uint64
		attachmentState   string
		attachmentVersion uint64
		networkVersion    uint64
	}
	egressStates := make(map[string]*egressAgentState)
	stateForAgent := func(agentID string) *egressAgentState {
		state := egressStates[agentID]
		if state == nil {
			state = &egressAgentState{
				policyID: "internet-enabled", policyVersion: 1,
				attachmentState:   ports.NetworkAttachmentClosed,
				attachmentVersion: 1, networkVersion: 1,
			}
			egressStates[agentID] = state
		}
		return state
	}
	egressServer := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		egressCalls.Add(1)
		if strings.HasPrefix(request.URL.Path, "/internal/agent-policy-assignments/") {
			agentID := strings.TrimPrefix(request.URL.Path, "/internal/agent-policy-assignments/")
			policyMu.Lock()
			defer policyMu.Unlock()
			state := stateForAgent(agentID)
			if request.Method == http.MethodPut {
				var payload struct {
					PolicyID                string `json:"policy_id"`
					Revision                uint64 `json:"revision"`
					ExpectedResourceVersion uint64 `json:"expected_resource_version"`
				}
				if err := json.NewDecoder(request.Body).Decode(&payload); err != nil ||
					payload.ExpectedResourceVersion != state.policyVersion {
					t.Fatalf("Egress policy payload = %+v err=%v", payload, err)
				}
				state.policyID = payload.PolicyID
				state.policyVersion++
			} else if request.Method != http.MethodGet {
				t.Fatalf("Egress policy request = %s %s", request.Method, request.URL.Path)
			}
			response.Header().Set("Content-Type", "application/json")
			_ = json.NewEncoder(response).Encode(map[string]any{
				"agent_id": agentID, "policy_id": state.policyID,
				"revision": 1, "resource_version": state.policyVersion,
			})
			return
		}
		if strings.HasPrefix(request.URL.Path, "/internal/agent-network-attachments/") {
			agentID := strings.TrimPrefix(request.URL.Path, "/internal/agent-network-attachments/")
			if request.Method != http.MethodPut || agentID == "" {
				t.Fatalf("Egress attachment request = %s %s", request.Method, request.URL.Path)
			}
			var payload struct {
				State                   string `json:"state"`
				ExpectedResourceVersion uint64 `json:"expected_resource_version"`
			}
			if err := json.NewDecoder(request.Body).Decode(&payload); err != nil {
				t.Fatalf("decode Egress attachment payload: %v", err)
			}
			policyMu.Lock()
			state := stateForAgent(agentID)
			if payload.State != state.attachmentState {
				if payload.ExpectedResourceVersion != state.attachmentVersion {
					policyMu.Unlock()
					t.Fatalf("Egress attachment version = %d, want %d", payload.ExpectedResourceVersion, state.attachmentVersion)
				}
				state.attachmentState = payload.State
				state.attachmentVersion++
			}
			responsePayload := egressNetworkResponse(
				agentID, ports.NetworkStateActive, state.networkVersion,
				state.attachmentState, state.attachmentVersion,
			)
			policyMu.Unlock()
			response.Header().Set("Content-Type", "application/json")
			_ = json.NewEncoder(response).Encode(responsePayload)
			return
		}
		path := strings.TrimPrefix(request.URL.Path, "/internal/agent-networks/")
		agentID := strings.TrimSuffix(path, "/release")
		if agentID == request.URL.Path || agentID == "" {
			t.Fatalf("Egress request = %s %s", request.Method, request.URL.Path)
		}
		if request.Method == http.MethodPost && path == agentID+"/release" {
			policyMu.Lock()
			state := stateForAgent(agentID)
			state.attachmentState = ports.NetworkAttachmentClosed
			state.attachmentVersion++
			state.networkVersion++
			responsePayload := egressNetworkResponse(
				agentID, ports.NetworkStateQuarantined, state.networkVersion,
				state.attachmentState, state.attachmentVersion,
			)
			policyMu.Unlock()
			response.Header().Set("Content-Type", "application/json")
			_ = json.NewEncoder(response).Encode(responsePayload)
			return
		}
		if (request.Method != http.MethodPut && request.Method != http.MethodGet) || path != agentID {
			t.Fatalf("Egress request = %s %s", request.Method, request.URL.Path)
		}
		response.Header().Set("Content-Type", "application/json")
		policyMu.Lock()
		state := stateForAgent(agentID)
		responsePayload := egressNetworkResponse(
			agentID, ports.NetworkStateActive, state.networkVersion,
			state.attachmentState, state.attachmentVersion,
		)
		policyMu.Unlock()
		_ = json.NewEncoder(response).Encode(responsePayload)
	}))
	t.Cleanup(egressServer.Close)
	runtimeServer := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		runtimeCalls.Add(1)
		if request.URL.Path == "/internal/runtimes" {
			_ = json.NewEncoder(response).Encode(map[string]any{"runtimes": []any{}})
			return
		}
		if request.URL.Path == "/internal/runtime-observations" {
			after, err := strconv.ParseUint(request.URL.Query().Get("after_sequence"), 10, 64)
			if err != nil {
				t.Fatal(err)
			}
			_ = json.NewEncoder(response).Encode(map[string]any{"observations": []any{}, "next_sequence": after})
			return
		}
		path := strings.TrimPrefix(request.URL.Path, "/internal/runtimes/")
		if request.Method == http.MethodPost && strings.Contains(path, "/skill-sets/preparations/") && strings.HasSuffix(path, "/release") {
			if request.Header.Get("Idempotency-Key") == "" {
				t.Fatal("Skill preparation release omitted idempotency key")
			}
			response.WriteHeader(http.StatusNoContent)
			return
		}
		if request.Method == http.MethodPost && strings.HasSuffix(path, "/skill-sets/prepare") {
			agentID := strings.TrimSuffix(path, "/skill-sets/prepare")
			var preparation ports.SkillPreparationRequest
			if err := json.NewDecoder(request.Body).Decode(&preparation); err != nil {
				t.Fatal(err)
			}
			if agentID == "" || request.Header.Get("Idempotency-Key") == "" || preparation.SystemSkills == nil {
				t.Fatalf("invalid Skill preparation request: agent=%q request=%q body=%+v", agentID, request.Header.Get("Idempotency-Key"), preparation)
			}
			response.Header().Set("Content-Type", "application/json")
			response.WriteHeader(http.StatusAccepted)
			_ = json.NewEncoder(response).Encode(ports.SkillPreparationReceipt{
				RequestID: request.Header.Get("Idempotency-Key"), AgentID: agentID,
				OrganizationID: preparation.OrganizationID, OwnerOperationID: preparation.OwnerOperationID,
				State: "ready", PreparedSkillSet: &ports.PreparedSkillSet{
					SkillSetDigest: preparation.SkillSetDigest, LayoutVersion: preparation.LayoutVersion,
				}, PreparedReferenceID: "psr_11111111111111111111111111111111",
			})
			return
		}
		if request.Method == http.MethodGet && path != "" && !strings.Contains(path, "/") {
			runtimeMu.Lock()
			inspection := map[string]any{
				"agent_id": path, "runtime_revision": currentRuntimeRevision,
				"lifecycle_state": currentRuntimeLifecycle, "health": currentRuntimeHealth,
				"phase": "running", "restart_count": 0, "observed_at": time.Now().UTC(),
			}
			if currentRuntimeHealth == "absent" {
				inspection["phase"] = "absent"
			}
			if currentRuntimeExecutionID != "" {
				inspection["runtime_execution_id"] = currentRuntimeExecutionID
			}
			if currentRuntimeEndpoint != "" {
				inspection["mcp_endpoint"] = currentRuntimeEndpoint
			}
			runtimeMu.Unlock()
			if inspection["lifecycle_state"] == "deleted" &&
				failNextDeleteInspection.CompareAndSwap(true, false) {
				http.Error(response, "runtime inspection temporarily unavailable", http.StatusServiceUnavailable)
				return
			}
			response.Header().Set("Content-Type", "application/json")
			_ = json.NewEncoder(response).Encode(inspection)
			return
		}
		action := "initialize"
		actionCalls := &initializeCalls
		agentID := strings.TrimSuffix(path, "/initialize")
		kind := "initialize_runtime"
		revision := "rtv_22222222222222222222222222222222"
		executionID := "runtime-execution-e2e"
		endpoint := "http://runtime-e2e:8091/mcp"
		if strings.HasSuffix(path, "/update") {
			action = "update"
			actionCalls = &updateCalls
			agentID = strings.TrimSuffix(path, "/update")
			kind = "update_runtime"
			revision = "rtv_33333333333333333333333333333333"
			executionID = "runtime-execution-rebuilt-e2e"
			endpoint = "http://runtime-rebuilt-e2e:8091/mcp"
			var payload struct {
				ExpectedRevision string `json:"expected_revision"`
			}
			if err := json.NewDecoder(request.Body).Decode(&payload); err != nil ||
				payload.ExpectedRevision != "rtv_22222222222222222222222222222222" {
				t.Fatalf("Runtime update payload = %+v err=%v", payload, err)
			}
		} else if strings.HasSuffix(path, "/disable") {
			action = "disable"
			actionCalls = &disableCalls
			agentID = strings.TrimSuffix(path, "/disable")
			kind = "disable_runtime"
			revision = "rtv_44444444444444444444444444444444"
			executionID = ""
			endpoint = ""
			var payload struct {
				ExpectedRevision string `json:"expected_revision"`
			}
			if err := json.NewDecoder(request.Body).Decode(&payload); err != nil ||
				payload.ExpectedRevision != "rtv_33333333333333333333333333333333" {
				t.Fatalf("Runtime disable payload = %+v err=%v", payload, err)
			}
		} else if strings.HasSuffix(path, "/enable") {
			action = "enable"
			actionCalls = &enableCalls
			agentID = strings.TrimSuffix(path, "/enable")
			kind = "enable_runtime"
			revision = "rtv_55555555555555555555555555555555"
			executionID = "runtime-execution-enabled-e2e"
			endpoint = "http://runtime-enabled-e2e:8091/mcp"
			var payload struct {
				ExpectedRevision string `json:"expected_revision"`
			}
			if err := json.NewDecoder(request.Body).Decode(&payload); err != nil ||
				payload.ExpectedRevision != "rtv_44444444444444444444444444444444" {
				t.Fatalf("Runtime enable payload = %+v err=%v", payload, err)
			}
		} else if strings.HasSuffix(path, "/delete") {
			action = "delete"
			actionCalls = &deleteCalls
			agentID = strings.TrimSuffix(path, "/delete")
			kind = "delete_runtime"
			revision = "rtv_66666666666666666666666666666666"
			executionID = ""
			endpoint = ""
			var payload struct {
				ExpectedRevision string `json:"expected_revision"`
			}
			if err := json.NewDecoder(request.Body).Decode(&payload); err != nil ||
				payload.ExpectedRevision != "rtv_55555555555555555555555555555555" {
				t.Fatalf("Runtime delete payload = %+v err=%v", payload, err)
			}
		}
		requestID := request.Header.Get("Idempotency-Key")
		if request.Method != http.MethodPost || path != agentID+"/"+action || agentID == "" || requestID == "" {
			t.Fatalf("Runtime request = %s %s idempotency=%q", request.Method, request.URL.Path, requestID)
		}
		inspection := map[string]any{
			"agent_id": agentID, "runtime_revision": revision,
			"lifecycle_state": "provisioned", "health": "healthy",
			"mcp_endpoint": endpoint, "runtime_execution_id": executionID,
			"restart_count": 0, "observed_at": "2026-09-01T00:00:00Z",
		}
		switch action {
		case "disable":
			inspection["lifecycle_state"] = "disabled"
			inspection["health"] = "absent"
			delete(inspection, "mcp_endpoint")
			delete(inspection, "runtime_execution_id")
		case "delete":
			inspection["lifecycle_state"] = "deleted"
			inspection["health"] = "absent"
			delete(inspection, "mcp_endpoint")
			delete(inspection, "runtime_execution_id")
		}
		runtimeMu.Lock()
		requestKey := agentID + ":" + action
		if previous := runtimeRequestIDs[requestKey]; previous != "" && previous != requestID {
			runtimeMu.Unlock()
			t.Fatalf("Runtime %s retry changed idempotency key from %q to %q", action, previous, requestID)
		}
		runtimeRequestIDs[requestKey] = requestID
		currentRuntimeRevision = revision
		currentRuntimeExecutionID = executionID
		currentRuntimeEndpoint = endpoint
		currentRuntimeLifecycle = inspection["lifecycle_state"].(string)
		currentRuntimeHealth = inspection["health"].(string)
		runtimeMu.Unlock()
		if actionCalls.Add(1) == 1 {
			if action == "delete" {
				failNextDeleteInspection.Store(true)
			}
			hijacker, ok := response.(http.Hijacker)
			if !ok {
				t.Fatalf("Runtime response does not support connection failure injection")
			}
			connection, buffered, err := hijacker.Hijack()
			if err != nil {
				t.Fatalf("hijack Runtime response: %v", err)
			}
			if _, err := io.WriteString(
				buffered,
				"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: 4096\r\n\r\n{\"request_id\":",
			); err != nil {
				_ = connection.Close()
				t.Fatalf("write partial Runtime response: %v", err)
			}
			if err := buffered.Flush(); err != nil {
				_ = connection.Close()
				t.Fatalf("flush partial Runtime response: %v", err)
			}
			_ = connection.Close()
			return
		}
		if action != "disable" && action != "delete" {
			inspection["health"] = "unknown"
			delete(inspection, "mcp_endpoint")
			delete(inspection, "runtime_execution_id")
		}
		response.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(response).Encode(map[string]any{
			"request_id": requestID, "kind": kind, "agent_id": agentID,
			"target_revision": revision, "state": "completed", "effect": "completed",
			"inspection": inspection,
			"created_at": "2026-09-01T00:00:00Z", "updated_at": "2026-09-01T00:00:01Z",
		})
	}))
	t.Cleanup(runtimeServer.Close)

	egress, err := egressclient.New(egressServer.URL, time.Second, egressServer.Client())
	if err != nil {
		t.Fatalf("create Egress client: %v", err)
	}
	runtime, err := runtimeclient.New(runtimeServer.URL, time.Second, runtimeServer.Client())
	if err != nil {
		t.Fatalf("create Runtime client: %v", err)
	}
	clock := wallClock{}
	execution, snapshot := executionPublicationPeer(t, repository, secretBox)
	lifecycle := application.NewLifecycleService(
		repository, repository, egress, runtime, clock,
		application.WithSkillPreparation(repository, runtime),
		application.WithIdentityDirectory(e2eIdentityDirectory{}),
		application.WithLifecycleExecution(execution),
	)
	handler, err := server.NewHandler(
		application.NewCatalogService(repository, secretBox, clock),
		lifecycle,
		application.NewAgentConfigurationService(repository, e2eIdentityDirectory{}, clock),
		application.NewAgentQueryService(repository),
		application.NewEventService(repository, eventNotifier, repository),
		application.NewNetworkPolicyService(repository, egress),
		repository.Ping,
	)
	if err != nil {
		t.Fatalf("create handler: %v", err)
	}
	handler = telemetry.HTTPHandler(handler, logger)
	restartedLifecycle := application.NewLifecycleService(
		repository, repository, egress, runtime, clock,
		application.WithSkillPreparation(repository, runtime),
		application.WithLifecycleExecution(execution),
	)

	recoverOperation := func(requestID string) {
		t.Helper()
		operation, err := repository.GetLifecycleOperation(ctx, requestID)
		if err != nil {
			t.Fatal(err)
		}
		parent := ""
		spans := spanRecorder.Ended()
		for i := len(spans) - 1; i >= 0; i-- {
			if spans[i].SpanKind() == trace.SpanKindServer {
				sc := spans[i].SpanContext()
				parent = "00-" + sc.TraceID().String() + "-" + sc.SpanID().String() + "-01"
				break
			}
		}
		if parent == "" {
			t.Fatal("missing HTTP admission parent")
		}
		executeLifecycleWorkflow(t, repository, restartedLifecycle, operation, parent)
		if operation.Kind == domain.OperationCreate || operation.Kind == domain.OperationRebuild || operation.Kind == domain.OperationEnable {
			pending, err := repository.GetAgent(ctx, operation.AgentID)
			if err != nil || (pending.LifecycleState != domain.AgentCreated || pending.ActivationState != domain.ActivationEnabled || pending.RuntimeState != domain.RuntimeUnknown) || pending.ExecutionRevisionID != "" || pending.ActiveOperationRequestID != "" {
				t.Fatalf("creation must finish before readiness: %+v error=%v", pending, err)
			}
			observer, err := application.NewRuntimeObservationWorker(runtime, repository, time.Second, logger)
			if err != nil {
				t.Fatal(err)
			}
			if err := observer.RunOnce(ctx); err != nil {
				t.Fatal(err)
			}
		}
	}

	provider := createTestProvider(t, handler, "agent-e2e-provider", "agent-e2e-org", "https://api.example.com/v1", "agent-e2e-secret")
	model := serveJSON(t, handler, http.MethodPost, "/internal/model-profiles", `{
		"request_id":"agent-e2e-model","organization_id":"agent-e2e-org",
		"profile_key":"deepseek","display_name":"DeepSeek",
		"model":{"model":"deepseek-chat",
			"context_window":128000,"max_output_tokens":8192,"supports_images":false,"supports_audio":true,"supports_pdf":true},
		"provider_connection_id":"`+provider["connection_id"].(string)+`"
	}`, http.StatusCreated)
	modelID := model["model_profile_id"].(string)
	template := serveJSON(t, handler, http.MethodPost, "/internal/agent-templates", `{
		"request_id":"agent-e2e-template","organization_id":"agent-e2e-org",
		"template_key":"personal","name":"Personal Agent",
		"model_profile_id":"`+modelID+`","system_prompt":"You are helpful.",
		"max_model_requests":16,"context_policy_version":"context-v1",
		"runtime":{"image_ref":"antnest/runtime@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
			"resources":{"memory_bytes":536870912,"pids_limit":256,"tmpfs_bytes":67108864}}
	}`, http.StatusCreated)
	templateID := template["template_id"].(string)
	createBody := `{
		"request_id":"agent-e2e-create","organization_id":"agent-e2e-org",
		"actor_principal_id":"agent-e2e-admin",
		"owner_user_id":"agent-e2e-user","name":"Research Agent",
		"template_id":"` + templateID + `","template_revision":1
	}`
	acceptedCreate := serveJSON(t, handler, http.MethodPost, "/internal/agents", createBody, http.StatusAccepted)
	acceptedAgent := acceptedCreate["agent"].(map[string]any)
	acceptedOperation := acceptedCreate["operation"].(map[string]any)
	if acceptedAgent["lifecycle_state"] != "not_created" ||
		acceptedOperation["state"] != "running" || acceptedOperation["phase"] != "network_ensure" ||
		egressCalls.Load() != 0 || runtimeCalls.Load() != 1 {
		t.Fatalf("accepted create crossed asynchronous boundary: response=%+v egress=%d runtime=%d",
			acceptedCreate, egressCalls.Load(), runtimeCalls.Load())
	}
	recoverOperation("agent-e2e-create")
	created := serveJSON(t, handler, http.MethodPost, "/internal/agents", createBody, http.StatusAccepted)
	agent := created["agent"].(map[string]any)
	operation := created["operation"].(map[string]any)
	if agent["lifecycle_state"] != "created" || agent["activation_state"] != "enabled" || agent["runtime_state"] != "available" || operation["state"] != "completed" ||
		agent["owner_user_id"] != "agent-e2e-user" {
		t.Fatalf("created Agent = %+v operation=%+v", agent, operation)
	}
	agentID := agent["agent_id"].(string)
	queried := serveJSON(
		t, handler, http.MethodGet,
		"/internal/agents/"+agentID+"?organization_id=agent-e2e-org", "", http.StatusOK,
	)
	if queried["owner_user_id"] != "agent-e2e-user" ||
		queried["aggregate_sequence"] != agent["aggregate_sequence"] ||
		queried["aggregate_sequence"].(float64) <= acceptedAgent["aggregate_sequence"].(float64) {
		t.Fatalf("queried Agent projection = %+v", queried)
	}
	events, err := repository.ListAgentEvents(ctx, ports.AgentEventQuery{AgentID: agentID, Limit: 100})
	if err != nil || len(events) != 4 || events[1].EventType != ports.EventAgentCreated ||
		events[2].EventType != ports.EventAgentRuntimeConditionChanged || events[3].EventType != ports.EventAgentReady ||
		float64(events[3].AggregateSequence) != queried["aggregate_sequence"] {
		t.Fatalf("creation/readiness journal differs from projection: %+v error=%v", events, err)
	}
	for _, event := range events {
		if !regexp.MustCompile(`^event_[0-9a-f]{32}$`).MatchString(event.EventID) {
			t.Errorf("event ID = %q", event.EventID)
		}
	}
	for kind, value := range map[string]string{"agent": agentID, "provider": provider["connection_id"].(string), "model": modelID, "template": templateID} {
		if !regexp.MustCompile("^" + kind + "_[0-9a-f]{32}$").MatchString(value) {
			t.Errorf("%s ID = %q", kind, value)
		}
	}
	listed := serveJSON(
		t, handler, http.MethodGet,
		"/internal/agents?organization_id=agent-e2e-org&owner_user_id=agent-e2e-user",
		"", http.StatusOK,
	)
	if items, ok := listed["items"].([]any); !ok || len(items) != 1 {
		t.Fatalf("owner Agent projection = %+v", listed)
	}
	createEgressCalls, createRuntimeCalls := egressCalls.Load(), runtimeCalls.Load()
	assertAgentConfigurationHTTP(t, handler, agent, execution, snapshot, spanRecorder)
	if egressCalls.Load() != createEgressCalls || runtimeCalls.Load() != createRuntimeCalls {
		t.Fatal("Agent defaults or credential publication changed Runtime or Egress")
	}
	replayed := serveJSON(t, handler, http.MethodPost, "/internal/agents", createBody, http.StatusAccepted)
	if _, exists := replayed["agent_access_subject"]; exists {
		t.Fatal("create response retains an opaque execution subject")
	}
	if replayed["agent"].(map[string]any)["agent_id"] != agentID ||
		egressCalls.Load() != createEgressCalls || runtimeCalls.Load() != createRuntimeCalls {
		t.Fatalf("idempotent replay repeated effects: egress=%d runtime=%d replay=%+v",
			egressCalls.Load(), runtimeCalls.Load(), replayed)
	}

	if runtimeLost {
		beforeLoss, err := repository.GetAgent(ctx, agentID)
		if err != nil {
			t.Fatal(err)
		}
		runtimeMu.Lock()
		currentRuntimeHealth = "absent"
		currentRuntimeExecutionID, currentRuntimeEndpoint = "", ""
		runtimeMu.Unlock()
		if err := repository.ApplyRuntimeObservation(ctx, ports.RuntimeObservation{
			Sequence: 1, AgentID: agentID, RuntimeRevision: beforeLoss.RuntimeRevision,
			Kind: "runtime_deleted", ObservedAt: time.Now().UTC(),
		}); err != nil {
			t.Fatal(err)
		}
		unavailable := serveJSON(t, handler, http.MethodGet,
			"/internal/agents/"+agentID+"?organization_id=agent-e2e-org", "", http.StatusOK)
		if unavailable["lifecycle_state"] != "created" || unavailable["runtime_state"] == "available" {
			t.Fatalf("HTTP projection remained runnable: %+v", unavailable)
		}
	}
	rebuildBody := `{
		"request_id":"agent-e2e-rebuild",
		"organization_id":"agent-e2e-org","actor_principal_id":"agent-e2e-admin",
		"template_id":"` + templateID + `",
		"template_revision":1
	}`
	beforeRebuildEgress, beforeRebuildRuntime := egressCalls.Load(), runtimeCalls.Load()
	acceptedRebuild := serveJSON(
		t, handler, http.MethodPost, "/internal/agents/"+agentID+"/rebuild",
		rebuildBody, http.StatusAccepted,
	)
	if acceptedRebuild["state"] != "running" || acceptedRebuild["phase"] != "drain" ||
		egressCalls.Load() != beforeRebuildEgress || runtimeCalls.Load() != beforeRebuildRuntime+1 {
		t.Fatalf("accepted rebuild crossed asynchronous boundary: %+v", acceptedRebuild)
	}
	recoverOperation("agent-e2e-rebuild")
	rebuilt := serveJSON(
		t, handler, http.MethodPost, "/internal/agents/"+agentID+"/rebuild",
		rebuildBody, http.StatusAccepted,
	)
	if rebuilt["state"] != "completed" {
		t.Fatalf("rebuild operation = %+v", rebuilt)
	}
	rebuiltBase, err := repository.GetAgentLifecycleBase(ctx, agentID)
	if err != nil {
		t.Fatalf("load rebuilt Agent: %v", err)
	}
	if !rebuiltBase.Agent.Status().RuntimeReady() ||
		rebuiltBase.Agent.AgentSpecRevisionID == agent["agent_spec_revision"] ||
		rebuiltBase.Agent.RuntimeRevision != "rtv_33333333333333333333333333333333" {
		t.Fatalf("rebuilt Agent = %+v", rebuiltBase.Agent)
	}
	rebuildEgressCalls, rebuildRuntimeCalls := egressCalls.Load(), runtimeCalls.Load()
	replayedRebuild := serveJSON(
		t, handler, http.MethodPost, "/internal/agents/"+agentID+"/rebuild",
		rebuildBody, http.StatusAccepted,
	)
	if replayedRebuild["state"] != "completed" ||
		egressCalls.Load() != rebuildEgressCalls || runtimeCalls.Load() != rebuildRuntimeCalls {
		t.Fatalf("idempotent rebuild repeated effects: egress=%d runtime=%d replay=%+v",
			egressCalls.Load(), runtimeCalls.Load(), replayedRebuild)
	}

	disableBody := `{"request_id":"agent-e2e-disable","organization_id":"agent-e2e-org","actor_principal_id":"agent-e2e-admin"}`
	beforeDisableEgress, beforeDisableRuntime := egressCalls.Load(), runtimeCalls.Load()
	acceptedDisable := serveJSON(
		t, handler, http.MethodPost, "/internal/agents/"+agentID+"/disable",
		disableBody, http.StatusAccepted,
	)
	if acceptedDisable["state"] != "running" || acceptedDisable["phase"] != "drain" ||
		egressCalls.Load() != beforeDisableEgress || runtimeCalls.Load() != beforeDisableRuntime {
		t.Fatalf("accepted disable crossed asynchronous boundary: %+v", acceptedDisable)
	}
	recoverOperation("agent-e2e-disable")
	disabled := serveJSON(
		t, handler, http.MethodPost, "/internal/agents/"+agentID+"/disable",
		disableBody, http.StatusAccepted,
	)
	if disabled["state"] != "completed" || disabled["kind"] != "disable" {
		t.Fatalf("disable operation = %+v", disabled)
	}
	disabledBase, err := repository.GetAgentLifecycleBase(ctx, agentID)
	if err != nil {
		t.Fatalf("load disabled Agent: %v", err)
	}
	if disabledBase.Agent.DesiredState != "disabled" ||
		disabledBase.Agent.LifecycleState != domain.AgentCreated || disabledBase.Agent.ActivationState != domain.ActivationDisabled ||
		disabledBase.Agent.ExecutionRevisionID != "" ||
		disabledBase.Agent.LastSuccessfulExecutionRevisionID != rebuiltBase.Agent.ExecutionRevisionID ||
		disabledBase.Agent.RuntimeRevision != "rtv_44444444444444444444444444444444" ||
		disabledBase.Agent.RuntimeExecutionID != "" || disabledBase.Agent.RuntimeMCPEndpoint != "" {
		t.Fatalf("disabled Agent = %+v", disabledBase.Agent)
	}
	disableEgressCalls, disableRuntimeCalls := egressCalls.Load(), runtimeCalls.Load()
	replayedDisable := serveJSON(
		t, handler, http.MethodPost, "/internal/agents/"+agentID+"/disable",
		disableBody, http.StatusAccepted,
	)
	if replayedDisable["state"] != "completed" ||
		egressCalls.Load() != disableEgressCalls || runtimeCalls.Load() != disableRuntimeCalls {
		t.Fatalf("idempotent disable repeated effects: egress=%d runtime=%d replay=%+v",
			egressCalls.Load(), runtimeCalls.Load(), replayedDisable)
	}

	enableBody := `{"request_id":"agent-e2e-enable","organization_id":"agent-e2e-org","actor_principal_id":"agent-e2e-admin"}`
	beforeEnableEgress, beforeEnableRuntime := egressCalls.Load(), runtimeCalls.Load()
	acceptedEnable := serveJSON(
		t, handler, http.MethodPost, "/internal/agents/"+agentID+"/enable",
		enableBody, http.StatusAccepted,
	)
	if acceptedEnable["state"] != "running" || acceptedEnable["phase"] != "network_ensure" ||
		egressCalls.Load() != beforeEnableEgress || runtimeCalls.Load() != beforeEnableRuntime+1 {
		t.Fatalf("accepted enable crossed asynchronous boundary: %+v", acceptedEnable)
	}
	recoverOperation("agent-e2e-enable")
	enabled := serveJSON(
		t, handler, http.MethodPost, "/internal/agents/"+agentID+"/enable",
		enableBody, http.StatusAccepted,
	)
	if enabled["state"] != "completed" || enabled["kind"] != "enable" {
		t.Fatalf("enable operation = %+v", enabled)
	}
	enabledBase, err := repository.GetAgentLifecycleBase(ctx, agentID)
	if err != nil {
		t.Fatalf("load enabled Agent: %v", err)
	}
	if enabledBase.Agent.DesiredState != "enabled" ||
		!enabledBase.Agent.Status().RuntimeReady() ||
		enabledBase.Agent.ExecutionRevisionID == rebuiltBase.Agent.ExecutionRevisionID ||
		enabledBase.Agent.LastSuccessfulExecutionRevisionID != enabledBase.Agent.ExecutionRevisionID ||
		enabledBase.Agent.RuntimeRevision != "rtv_55555555555555555555555555555555" ||
		enabledBase.Agent.RuntimeExecutionID != "runtime-execution-enabled-e2e" ||
		enabledBase.Agent.RuntimeMCPEndpoint != "http://runtime-enabled-e2e:8091/mcp" {
		t.Fatalf("enabled Agent = %+v", enabledBase.Agent)
	}
	enableEgressCalls, enableRuntimeCalls := egressCalls.Load(), runtimeCalls.Load()
	replayedEnable := serveJSON(
		t, handler, http.MethodPost, "/internal/agents/"+agentID+"/enable",
		enableBody, http.StatusAccepted,
	)
	if replayedEnable["state"] != "completed" ||
		egressCalls.Load() != enableEgressCalls || runtimeCalls.Load() != enableRuntimeCalls {
		t.Fatalf("idempotent enable repeated effects: egress=%d runtime=%d replay=%+v",
			egressCalls.Load(), runtimeCalls.Load(), replayedEnable)
	}

	deleteBody := `{"request_id":"agent-e2e-delete","organization_id":"agent-e2e-org","actor_principal_id":"agent-e2e-admin"}`
	beforeDeleteEgress, beforeDeleteRuntime := egressCalls.Load(), runtimeCalls.Load()
	acceptedDelete := serveJSON(
		t, handler, http.MethodPost, "/internal/agents/"+agentID+"/delete",
		deleteBody, http.StatusAccepted,
	)
	if acceptedDelete["state"] != "running" || acceptedDelete["phase"] != "drain" ||
		egressCalls.Load() != beforeDeleteEgress || runtimeCalls.Load() != beforeDeleteRuntime {
		t.Fatalf("accepted delete crossed asynchronous boundary: %+v", acceptedDelete)
	}
	recoverOperation("agent-e2e-delete")
	deleted := serveJSON(
		t, handler, http.MethodPost, "/internal/agents/"+agentID+"/delete",
		deleteBody, http.StatusAccepted,
	)
	if deleted["state"] != "completed" || deleted["kind"] != "delete" {
		t.Fatalf("delete operation = %+v", deleted)
	}
	deletedBase, err := repository.GetAgentDeleteBase(ctx, agentID)
	if err != nil {
		t.Fatalf("load deleted Agent: %v", err)
	}
	if deletedBase.Agent.DesiredState != "deleted" ||
		deletedBase.Agent.LifecycleState != "deleted" ||
		deletedBase.Agent.AgentSpecRevisionID != "" ||
		deletedBase.Agent.ExecutionRevisionID != "" ||
		deletedBase.Agent.LastSuccessfulExecutionRevisionID != enabledBase.Agent.ExecutionRevisionID ||
		deletedBase.Agent.RuntimeRevision != "" ||
		deletedBase.Agent.ActiveOperationRequestID != "" {
		t.Fatalf("deleted Agent = %+v", deletedBase.Agent)
	}
	deleteEgressCalls, deleteRuntimeCalls := egressCalls.Load(), runtimeCalls.Load()
	replayedDelete := serveJSON(
		t, handler, http.MethodPost, "/internal/agents/"+agentID+"/delete",
		deleteBody, http.StatusAccepted,
	)
	if replayedDelete["state"] != "completed" ||
		egressCalls.Load() != deleteEgressCalls || runtimeCalls.Load() != deleteRuntimeCalls {
		t.Fatalf("idempotent delete repeated effects: egress=%d runtime=%d replay=%+v",
			egressCalls.Load(), runtimeCalls.Load(), replayedDelete)
	}
	hidden := serveJSON(
		t, handler, http.MethodGet,
		"/internal/agents?organization_id=agent-e2e-org&owner_user_id=agent-e2e-user",
		"", http.StatusOK,
	)
	if items, ok := hidden["items"].([]any); !ok || len(items) != 0 {
		t.Fatalf("deleted Agent remained in default projection = %+v", hidden)
	}
	visible := serveJSON(
		t, handler, http.MethodGet,
		"/internal/agents?organization_id=agent-e2e-org&owner_user_id=agent-e2e-user&include_deleted=true",
		"", http.StatusOK,
	)
	if items, ok := visible["items"].([]any); !ok || len(items) != 1 {
		t.Fatalf("deleted Agent was not available to explicit audit query = %+v", visible)
	}
	createdIDs := make(map[string]struct{}, 2)
	for _, suffix := range []string{"b", "c"} {
		createdAgent := serveJSON(
			t, handler, http.MethodPost, "/internal/agents", `{
				"request_id":"agent-e2e-create-`+suffix+`","organization_id":"agent-e2e-org",
				"actor_principal_id":"agent-e2e-admin",
				"owner_user_id":"agent-e2e-user","name":"Research Agent `+suffix+`",
				"template_id":"`+templateID+`","template_revision":1
			}`, http.StatusAccepted,
		)
		createdIDs[createdAgent["agent"].(map[string]any)["agent_id"].(string)] = struct{}{}
		recoverOperation("agent-e2e-create-" + suffix)
	}
	firstPage := serveJSON(
		t, handler, http.MethodGet,
		"/internal/agents?organization_id=agent-e2e-org&owner_user_id=agent-e2e-user&limit=1",
		"", http.StatusOK,
	)
	firstItems := firstPage["items"].([]any)
	nextCursor, ok := firstPage["next_cursor"].(string)
	if len(firstItems) != 1 || !ok || nextCursor == "" {
		t.Fatalf("first Agent cursor page = %+v", firstPage)
	}
	firstID := firstItems[0].(map[string]any)["agent_id"].(string)
	secondPage := serveJSON(
		t, handler, http.MethodGet,
		"/internal/agents?organization_id=agent-e2e-org&owner_user_id=agent-e2e-user&limit=1&cursor="+url.QueryEscape(nextCursor),
		"", http.StatusOK,
	)
	secondItems := secondPage["items"].([]any)
	if len(secondItems) != 1 || secondPage["next_cursor"] != nil {
		t.Fatalf("second Agent cursor page = %+v", secondPage)
	}
	secondID := secondItems[0].(map[string]any)["agent_id"].(string)
	if firstID == secondID {
		t.Fatalf("Agent cursor repeated %q", firstID)
	}
	delete(createdIDs, firstID)
	delete(createdIDs, secondID)
	if len(createdIDs) != 0 {
		t.Fatalf("Agent cursor omitted identities: %+v", createdIDs)
	}
	assertLifecycleWorkflowTraceEvidence(t, spanRecorder.Ended())
}

func egressNetworkResponse(
	agentID string,
	networkState string,
	networkResourceVersion uint64,
	attachmentState string,
	attachmentResourceVersion uint64,
) map[string]any {
	return map[string]any{
		"agent_id": agentID, "tunnel_ipv4": "100.64.0.2",
		"resolver_ipv4": "100.64.0.1", "packet_contract_revision": 1,
		"egress_endpoint":             map[string]any{"ipv4": "10.20.0.8", "port": 8092},
		"state":                       networkState,
		"network_resource_version":    networkResourceVersion,
		"attachment_state":            attachmentState,
		"attachment_resource_version": attachmentResourceVersion,
	}
}

type wallClock struct{}

func (wallClock) Now() time.Time { return time.Now().UTC() }

type e2eIdentityDirectory struct{}

func (directory e2eIdentityDirectory) ResolveOwnerAuthorization(ctx context.Context, org, user string) (ports.IdentityPrincipal, error) {
	return directory.ResolvePrincipal(ctx, org, user)
}

func (e2eIdentityDirectory) ResolvePrincipal(
	_ context.Context, organizationID, userID string,
) (ports.IdentityPrincipal, error) {
	return ports.IdentityPrincipal{
		UserID: userID, OrganizationID: organizationID,
		MembershipID: "agent-e2e-membership", Active: true,
	}, nil
}

func assertLifecycleWorkflowTraceEvidence(t *testing.T, spans []sdktrace.ReadOnlySpan) {
	t.Helper()

	activitySpans := make(map[string]bool)
	for _, span := range spans {
		if strings.HasPrefix(span.Name(), "agent_controller.repository.") {
			t.Fatalf("obsolete repository wrapper span: %s", span.Name())
		}
		if strings.HasPrefix(span.Name(), "RunActivity:") {
			if span.InstrumentationScope().Name != "temporal-sdk-go" || !span.Parent().IsValid() {
				t.Fatalf("creation activity is not SDK instrumented: %s", span.Name())
			}
			activitySpans[span.SpanContext().SpanID().String()] = true
			continue
		}
		if span.Name() == "recover Agent lifecycle operation" {
			t.Fatal("obsolete recovery instrumentation")
		}
	}
	if len(activitySpans) < 5 {
		t.Fatalf("recovery spans = %d, want at least one per Saga", len(activitySpans))
	}
	requiredDependencies := map[string]bool{
		"initialize": false,
		"update":     false,
		"disable":    false,
		"enable":     false,
		"delete":     false,
	}
	byID := make(map[trace.SpanID]sdktrace.ReadOnlySpan)
	for _, span := range spans {
		byID[span.SpanContext().SpanID()] = span
	}
	databaseChild := false
	for _, span := range spans {
		parent := span.Parent().SpanID()
		for !activitySpans[parent.String()] && byID[parent] != nil {
			parent = byID[parent].Parent().SpanID()
		}
		if !activitySpans[parent.String()] {
			continue
		}
		if span.Name() == "HTTP POST runtime-controller" {
			for _, attr := range span.Attributes() {
				if string(attr.Key) == "rpc.method" {
					if _, required := requiredDependencies[attr.Value.AsString()]; required {
						requiredDependencies[attr.Value.AsString()] = true
					}
				}
			}
		}
		if span.InstrumentationScope().Name == "github.com/exaring/otelpgx" {
			for _, attr := range span.Attributes() {
				if attr.Key == "db.query.text" {
					databaseChild = true
				}
				if attr.Key == "pgx.query.parameters" {
					t.Fatal("database child recorded bind parameters")
				}
			}
		}
	}
	for name, found := range requiredDependencies {
		if !found {
			t.Fatalf("workflow trace is missing dependency span %q", name)
		}
	}
	if !databaseChild {
		t.Fatal("workflow trace is missing driver SQL child spans")
	}
}

func executeLifecycleWorkflow(t *testing.T, repository *postgres.Repository, service *application.LifecycleService, operation ports.LifecycleOperationRecord, traceParent string) {
	t.Helper()
	var suite testsuite.WorkflowTestSuite
	env := suite.NewTestWorkflowEnvironment()
	instrumentation, err := temporalotel.NewTracingInterceptor(temporalotel.TracerOptions{})
	if err != nil {
		t.Fatal(err)
	}
	env.SetWorkerOptions(worker.Options{Interceptors: []interceptor.WorkerInterceptor{instrumentation}})
	parent, err := converter.GetDefaultDataConverter().ToPayload(map[string]string{"traceparent": traceParent})
	if err != nil {
		t.Fatal(err)
	}
	env.SetHeader(&commonpb.Header{Fields: map[string]*commonpb.Payload{"_tracer-data": parent}})
	orchestration.Register(env, service)

	if operation.Kind == "create" {
		state, found, err := repository.ReplayAgentCreate(context.Background(), operation.RequestID, operation.RequestFingerprint)
		if err != nil || !found {
			t.Fatalf("creation source: %v %v", found, err)
		}
		env.ExecuteWorkflow(orchestration.CreateAgentWorkflow, application.CreateAgentInput{
			RequestID: operation.RequestID, OrganizationID: state.Agent.OrganizationID, ActorPrincipalID: "agent-e2e-admin", OwnerUserID: state.Agent.OwnerUserID, Name: state.Agent.Name, TemplateID: state.Spec.Snapshot.TemplateID, TemplateRevision: state.Spec.Snapshot.TemplateRevision})
	} else {
		command := application.LifecycleCommand{Kind: operation.Kind, RequestID: operation.RequestID, AgentID: operation.AgentID, OrganizationID: "agent-e2e-org", ActorPrincipalID: "agent-e2e-admin"}
		if operation.Kind == "rebuild" {
			state, found, err := repository.ReplayAgentRebuild(context.Background(), operation.RequestID, operation.RequestFingerprint)
			if err != nil || !found {
				t.Fatalf("rebuild source: %v %v", found, err)
			}
			command.TemplateID = state.TargetSpec.Snapshot.TemplateID
			command.TemplateRevision = state.TargetSpec.Snapshot.TemplateRevision
		}
		env.ExecuteWorkflow(orchestration.LifecycleWorkflow, command)
	}

	if err := env.GetWorkflowError(); err != nil {
		t.Fatalf("creation workflow: %v", err)
	}
	completed, err := repository.GetLifecycleOperation(context.Background(), operation.RequestID)
	if err != nil || completed.State != "completed" {
		t.Fatalf("creation did not complete without legacy lease: %+v err=%v", completed, err)
	}
}
