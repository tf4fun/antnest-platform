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
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/propagation"
	sdktrace "go.opentelemetry.io/otel/sdk/trace"
	"go.opentelemetry.io/otel/sdk/trace/tracetest"

	"soft/antnest-platform/services/agent-controller/internal/application"
	"soft/antnest-platform/services/agent-controller/internal/credentials"
	"soft/antnest-platform/services/agent-controller/internal/egressclient"
	"soft/antnest-platform/services/agent-controller/internal/ports"
	"soft/antnest-platform/services/agent-controller/internal/repository/postgres"
	"soft/antnest-platform/services/agent-controller/internal/runtimeclient"
	"soft/antnest-platform/services/agent-controller/internal/server"
	"soft/antnest-platform/services/agent-controller/internal/telemetry"
)

func TestAgentLifecycleAcrossHTTPPostgresAndDependencyContracts(t *testing.T) {
	databaseURL := os.Getenv("ANTNEST_AGENT_CONTROLLER_TEST_DATABASE_URL")
	if databaseURL == "" {
		t.Skip("ANTNEST_AGENT_CONTROLLER_TEST_DATABASE_URL is not set")
	}
	ctx := context.Background()
	previousProvider := otel.GetTracerProvider()
	previousPropagator := otel.GetTextMapPropagator()
	spanRecorder := tracetest.NewSpanRecorder()
	traceProvider := sdktrace.NewTracerProvider(sdktrace.WithSpanProcessor(spanRecorder))
	otel.SetTracerProvider(traceProvider)
	otel.SetTextMapPropagator(propagation.TraceContext{})
	t.Cleanup(func() {
		_ = traceProvider.Shutdown(context.Background())
		otel.SetTracerProvider(previousProvider)
		otel.SetTextMapPropagator(previousPropagator)
	})
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
	observedLifecycleStore, err := telemetry.ObserveLifecycleStore(repository, logger)
	if err != nil {
		t.Fatalf("observe lifecycle store: %v", err)
	}
	observedRecoveryStore, err := telemetry.ObserveLifecycleRecoveryStore(repository, logger)
	if err != nil {
		t.Fatalf("observe lifecycle recovery store: %v", err)
	}
	recoveryInstrumentation, err := telemetry.ObserveLifecycleRecoveryAttempt(logger)
	if err != nil {
		t.Fatalf("observe lifecycle recovery attempt: %v", err)
	}

	var egressCalls, runtimeCalls atomic.Int64
	var initializeCalls, updateCalls, disableCalls, enableCalls, deleteCalls atomic.Int64
	var failNextDeleteInspection atomic.Bool
	var policyMu sync.Mutex
	var runtimeMu sync.Mutex
	var currentRuntimeRevision, currentRuntimeExecutionID, currentRuntimeEndpoint string
	var currentRuntimeLifecycle, currentRuntimeHealth string
	runtimeRequestIDs := make(map[string]string)
	policyID := "internet-enabled"
	policyVersion := uint64(1)
	egressServer := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		egressCalls.Add(1)
		if strings.HasPrefix(request.URL.Path, "/internal/agent-policy-assignments/") {
			agentID := strings.TrimPrefix(request.URL.Path, "/internal/agent-policy-assignments/")
			policyMu.Lock()
			defer policyMu.Unlock()
			if request.Method == http.MethodPut {
				var payload struct {
					PolicyID                string `json:"policy_id"`
					Revision                uint64 `json:"revision"`
					ExpectedResourceVersion uint64 `json:"expected_resource_version"`
				}
				if err := json.NewDecoder(request.Body).Decode(&payload); err != nil ||
					payload.ExpectedResourceVersion != policyVersion {
					t.Fatalf("Egress policy payload = %+v err=%v", payload, err)
				}
				policyID = payload.PolicyID
				policyVersion++
			} else if request.Method != http.MethodGet {
				t.Fatalf("Egress policy request = %s %s", request.Method, request.URL.Path)
			}
			response.Header().Set("Content-Type", "application/json")
			_ = json.NewEncoder(response).Encode(map[string]any{
				"agent_id": agentID, "policy_id": policyID,
				"revision": 1, "resource_version": policyVersion,
			})
			return
		}
		path := strings.TrimPrefix(request.URL.Path, "/internal/agent-networks/")
		agentID := strings.TrimSuffix(
			strings.TrimSuffix(strings.TrimSuffix(path, "/fence"), "/reset-flows"),
			"/release",
		)
		if agentID == request.URL.Path || agentID == "" {
			t.Fatalf("Egress request = %s %s", request.Method, request.URL.Path)
		}
		if request.Method == http.MethodPost && path == agentID+"/release" {
			response.Header().Set("Content-Type", "application/json")
			_ = json.NewEncoder(response).Encode(map[string]any{
				"agent_id": agentID, "tunnel_ipv4": "100.64.0.2",
				"resolver_ipv4": "100.64.0.1", "packet_contract_revision": 1,
				"egress_endpoint": map[string]any{"ipv4": "10.20.0.8", "port": 8092},
				"state":           "quarantined",
			})
			return
		}
		if request.Method == http.MethodPost &&
			(path == agentID+"/fence" || path == agentID+"/reset-flows") {
			if path == agentID+"/fence" {
				policyMu.Lock()
				if policyID != ports.BuiltinDenyAllPolicyID {
					policyID = ports.BuiltinDenyAllPolicyID
					policyVersion++
				}
				policyMu.Unlock()
			}
			response.WriteHeader(http.StatusNoContent)
			return
		}
		if (request.Method != http.MethodPut && request.Method != http.MethodGet) || path != agentID {
			t.Fatalf("Egress request = %s %s", request.Method, request.URL.Path)
		}
		response.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(response).Encode(map[string]any{
			"agent_id": agentID, "tunnel_ipv4": "100.64.0.2",
			"resolver_ipv4": "100.64.0.1", "packet_contract_revision": 1,
			"egress_endpoint": map[string]any{"ipv4": "10.20.0.8", "port": 8092},
			"state":           "active",
		})
	}))
	t.Cleanup(egressServer.Close)
	runtimeServer := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		runtimeCalls.Add(1)
		path := strings.TrimPrefix(request.URL.Path, "/internal/runtimes/")
		if request.Method == http.MethodGet && path != "" && !strings.Contains(path, "/") {
			runtimeMu.Lock()
			inspection := map[string]any{
				"agent_id": path, "runtime_revision": currentRuntimeRevision,
				"lifecycle_state": currentRuntimeLifecycle, "health": currentRuntimeHealth,
				"restart_count": 0, "observed_at": "2026-09-01T00:00:00Z",
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
			"lifecycle_state": "ready", "health": "healthy",
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
	lifecycle := application.NewLifecycleService(
		repository, observedLifecycleStore, egress, runtime, clock,
	)
	handler, err := server.NewHandler(
		application.NewCatalogService(repository, secretBox, clock),
		lifecycle,
		application.NewRunService(repository, secretBox, clock, 30*time.Minute),
		application.NewAgentQueryService(repository),
		application.NewEventService(repository, eventNotifier, repository),
		repository.Ping,
	)
	if err != nil {
		t.Fatalf("create handler: %v", err)
	}

	model := serveJSON(t, handler, http.MethodPost, "/internal/model-profiles", `{
		"request_id":"agent-e2e-model","organization_id":"agent-e2e-org",
		"profile_key":"deepseek","display_name":"DeepSeek",
		"model":{"base_url":"https://api.example.com/v1","model":"deepseek-chat",
			"context_window":128000,"max_output_tokens":8192,"supports_images":false},
		"credential":{"secret_type":"bearer","secret":"agent-e2e-secret"}
	}`, http.StatusCreated)
	revisionID := model["revision_id"].(string)
	template := serveJSON(t, handler, http.MethodPost, "/internal/agent-templates", `{
		"request_id":"agent-e2e-template","organization_id":"agent-e2e-org",
		"template_key":"personal","name":"Personal Agent",
		"model_profile_revision_id":"`+revisionID+`","system_prompt":"You are helpful.",
		"max_model_requests":16,"context_policy_version":"context-v1",
		"runtime":{"image_ref":"antnest/runtime@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
			"resources":{"memory_bytes":536870912,"pids_limit":256,"tmpfs_bytes":67108864}}
	}`, http.StatusCreated)
	templateID := template["template_id"].(string)
	createBody := `{
		"request_id":"agent-e2e-create","organization_id":"agent-e2e-org",
		"owner_user_id":"agent-e2e-user","name":"Research Agent",
		"template_id":"` + templateID + `","template_revision":1
	}`
	failedCreate := serveJSON(
		t, handler, http.MethodPost, "/internal/agents", createBody, http.StatusServiceUnavailable,
	)
	if failedCreate["code"] != "dependency_unavailable" || failedCreate["retryable"] != true {
		t.Fatalf("failed create response = %+v", failedCreate)
	}
	persisted, err := repository.GetLifecycleOperation(ctx, "agent-e2e-create")
	if err != nil || persisted.State != "running" || persisted.Phase != "runtime_initialize" {
		t.Fatalf("persisted interrupted create = %+v err=%v", persisted, err)
	}
	restartedLifecycle := application.NewLifecycleService(
		repository, observedLifecycleStore, egress, runtime, clock,
	)
	recoveryWorker, err := application.NewLifecycleRecoveryWorker(
		observedRecoveryStore, restartedLifecycle, recoveryInstrumentation,
		application.LifecycleRecoveryWorkerConfig{
			WorkerID: "agent-e2e-recovery", PollInterval: 10 * time.Millisecond,
			StaleAfter: 500 * time.Millisecond, AttemptTimeout: 200 * time.Millisecond,
			LeaseDuration: 500 * time.Millisecond, RetryMax: 500 * time.Millisecond,
		},
	)
	if err != nil {
		t.Fatalf("create lifecycle recovery worker: %v", err)
	}
	recoverOperation := func(requestID string, wantFirstPhase string) {
		t.Helper()
		processed, err := recoveryWorker.RunOnce(ctx)
		if err != nil || processed {
			t.Fatalf("fresh %s was recoverable before stale threshold: processed=%v err=%v", requestID, processed, err)
		}
		time.Sleep(550 * time.Millisecond)
		processed, err = recoveryWorker.RunOnce(ctx)
		if err != nil || !processed {
			t.Fatalf("recover interrupted %s: processed=%v err=%v", requestID, processed, err)
		}
		recoveredStep, err := repository.GetLifecycleOperation(ctx, requestID)
		if err != nil || recoveredStep.State != "running" || string(recoveredStep.Phase) != wantFirstPhase ||
			recoveredStep.RecoveryOwner != "" || recoveredStep.RecoveryLeaseUntil != nil {
			t.Fatalf("single recovered %s phase = %+v err=%v", requestID, recoveredStep, err)
		}
		for recoveredStep.State == "running" {
			time.Sleep(15 * time.Millisecond)
			processed, err = recoveryWorker.RunOnce(ctx)
			if err != nil || !processed {
				t.Fatalf("continue recovery %s: processed=%v err=%v", requestID, processed, err)
			}
			recoveredStep, err = repository.GetLifecycleOperation(ctx, requestID)
			if err != nil {
				t.Fatalf("read recovered %s: %v", requestID, err)
			}
		}
		if recoveredStep.State != "completed" || recoveredStep.Phase != "completed" ||
			recoveredStep.RecoveryOwner != "" || recoveredStep.RecoveryLeaseUntil != nil {
			t.Fatalf("terminal recovered %s = %+v", requestID, recoveredStep)
		}
	}
	recoverOperation("agent-e2e-create", "publish")
	created := serveJSON(t, handler, http.MethodPost, "/internal/agents", createBody, http.StatusAccepted)
	agent := created["agent"].(map[string]any)
	operation := created["operation"].(map[string]any)
	if agent["lifecycle_state"] != "available" || operation["state"] != "completed" ||
		agent["owner_user_id"] != "agent-e2e-user" {
		t.Fatalf("created Agent = %+v operation=%+v", agent, operation)
	}
	agentID := agent["agent_id"].(string)
	queried := serveJSON(
		t, handler, http.MethodGet, "/internal/agents/"+agentID, "", http.StatusOK,
	)
	if queried["owner_user_id"] != "agent-e2e-user" || queried["aggregate_sequence"] != float64(2) {
		t.Fatalf("queried Agent projection = %+v", queried)
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
	replayed := serveJSON(t, handler, http.MethodPost, "/internal/agents", createBody, http.StatusAccepted)
	if replayed["agent_access_subject"] != created["agent_access_subject"] ||
		egressCalls.Load() != createEgressCalls || runtimeCalls.Load() != createRuntimeCalls {
		t.Fatalf("idempotent replay repeated effects: egress=%d runtime=%d replay=%+v",
			egressCalls.Load(), runtimeCalls.Load(), replayed)
	}

	rebuildBody := `{
		"request_id":"agent-e2e-rebuild",
		"template_id":"` + templateID + `",
		"template_revision":1
	}`
	failedRebuild := serveJSON(
		t, handler, http.MethodPost, "/internal/agents/"+agentID+"/rebuild",
		rebuildBody, http.StatusServiceUnavailable,
	)
	if failedRebuild["code"] != "dependency_unavailable" || failedRebuild["retryable"] != true {
		t.Fatalf("failed rebuild response = %+v", failedRebuild)
	}
	persisted, err = repository.GetLifecycleOperation(ctx, "agent-e2e-rebuild")
	if err != nil || persisted.State != "running" || persisted.Phase != "runtime_update" {
		t.Fatalf("persisted interrupted rebuild = %+v err=%v", persisted, err)
	}
	recoverOperation("agent-e2e-rebuild", "network_ensure")
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
	if rebuiltBase.Agent.LifecycleState != "available" ||
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

	disableBody := `{"request_id":"agent-e2e-disable"}`
	failedDisable := serveJSON(
		t, handler, http.MethodPost, "/internal/agents/"+agentID+"/disable",
		disableBody, http.StatusServiceUnavailable,
	)
	if failedDisable["code"] != "dependency_unavailable" || failedDisable["retryable"] != true {
		t.Fatalf("failed disable response = %+v", failedDisable)
	}
	persisted, err = repository.GetLifecycleOperation(ctx, "agent-e2e-disable")
	if err != nil || persisted.State != "running" || persisted.Phase != "runtime_disable" {
		t.Fatalf("persisted interrupted disable = %+v err=%v", persisted, err)
	}
	recoverOperation("agent-e2e-disable", "publish")
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
		disabledBase.Agent.LifecycleState != "disabled" ||
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

	enableBody := `{"request_id":"agent-e2e-enable"}`
	failedEnable := serveJSON(
		t, handler, http.MethodPost, "/internal/agents/"+agentID+"/enable",
		enableBody, http.StatusServiceUnavailable,
	)
	if failedEnable["code"] != "dependency_unavailable" || failedEnable["retryable"] != true {
		t.Fatalf("failed enable response = %+v", failedEnable)
	}
	persisted, err = repository.GetLifecycleOperation(ctx, "agent-e2e-enable")
	if err != nil || persisted.State != "running" || persisted.Phase != "runtime_enable" {
		t.Fatalf("persisted interrupted enable = %+v err=%v", persisted, err)
	}
	recoverOperation("agent-e2e-enable", "network_restore")
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
		enabledBase.Agent.LifecycleState != "available" ||
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

	deleteBody := `{"request_id":"agent-e2e-delete"}`
	failedDelete := serveJSON(
		t, handler, http.MethodPost, "/internal/agents/"+agentID+"/delete",
		deleteBody, http.StatusServiceUnavailable,
	)
	if failedDelete["code"] != "dependency_unavailable" || failedDelete["retryable"] != true {
		t.Fatalf("failed delete response = %+v", failedDelete)
	}
	persisted, err = repository.GetLifecycleOperation(ctx, "agent-e2e-delete")
	if err != nil || persisted.State != "running" || persisted.Phase != "runtime_delete" {
		t.Fatalf("persisted interrupted delete = %+v err=%v", persisted, err)
	}
	recoverOperation("agent-e2e-delete", "network_release")
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
				"owner_user_id":"agent-e2e-user","name":"Research Agent `+suffix+`",
				"template_id":"`+templateID+`","template_revision":1
			}`, http.StatusAccepted,
		)
		createdIDs[createdAgent["agent"].(map[string]any)["agent_id"].(string)] = struct{}{}
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
	assertLifecycleRecoveryTraceEvidence(t, spanRecorder.Ended())
}

type wallClock struct{}

func (wallClock) Now() time.Time { return time.Now().UTC() }

func assertLifecycleRecoveryTraceEvidence(t *testing.T, spans []sdktrace.ReadOnlySpan) {
	t.Helper()

	recoveryRoots := make(map[string]string)
	for _, span := range spans {
		if span.Name() != "recover Agent lifecycle operation" {
			continue
		}
		if span.Parent().IsValid() {
			t.Fatalf("recovery span inherited parent: %s", span.Parent().SpanID())
		}
		workerID := ""
		for _, attr := range span.Attributes() {
			if string(attr.Key) == "antnest.lifecycle.recovery.worker_id" {
				workerID = attr.Value.AsString()
			}
		}
		if workerID != "agent-e2e-recovery" {
			t.Fatalf("recovery worker attribute = %q", workerID)
		}
		recoveryRoots[span.SpanContext().TraceID().String()] = span.SpanContext().SpanID().String()
	}
	if len(recoveryRoots) < 5 {
		t.Fatalf("recovery root traces = %d, want at least one per Saga", len(recoveryRoots))
	}
	requiredDependencies := map[string]bool{
		"agent_controller.runtime.initialize": false,
		"agent_controller.runtime.update":     false,
		"agent_controller.runtime.disable":    false,
		"agent_controller.runtime.enable":     false,
		"agent_controller.runtime.delete":     false,
	}
	repositoryChild := false
	for _, span := range spans {
		rootSpanID, recovered := recoveryRoots[span.SpanContext().TraceID().String()]
		if !recovered || span.Name() == "recover Agent lifecycle operation" ||
			span.Parent().SpanID().String() != rootSpanID {
			continue
		}
		if _, required := requiredDependencies[span.Name()]; required {
			requiredDependencies[span.Name()] = true
		}
		if strings.HasPrefix(span.Name(), "agent_controller.repository.") {
			repositoryChild = true
		}
	}
	for name, found := range requiredDependencies {
		if !found {
			t.Fatalf("recovery trace is missing dependency span %q", name)
		}
	}
	if !repositoryChild {
		t.Fatal("recovery trace is missing repository child spans")
	}
}
