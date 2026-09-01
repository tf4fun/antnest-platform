package e2e

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"soft/antnest-platform/services/agent-controller/internal/application"
	"soft/antnest-platform/services/agent-controller/internal/credentials"
	"soft/antnest-platform/services/agent-controller/internal/egressclient"
	"soft/antnest-platform/services/agent-controller/internal/repository/postgres"
	"soft/antnest-platform/services/agent-controller/internal/runtimeclient"
	"soft/antnest-platform/services/agent-controller/internal/server"
)

func TestCreateRebuildAndDisableAgentAcrossHTTPPostgresAndDependencyContracts(t *testing.T) {
	databaseURL := os.Getenv("ANTNEST_AGENT_CONTROLLER_TEST_DATABASE_URL")
	if databaseURL == "" {
		t.Skip("ANTNEST_AGENT_CONTROLLER_TEST_DATABASE_URL is not set")
	}
	ctx := context.Background()
	repository, err := postgres.Open(ctx, databaseURL)
	if err != nil {
		t.Fatalf("open repository: %v", err)
	}
	t.Cleanup(repository.Close)
	if err := repository.Migrate(ctx); err != nil {
		t.Fatalf("migrate repository: %v", err)
	}
	secretBox, err := credentials.NewSecretBox(make([]byte, 32))
	if err != nil {
		t.Fatalf("create SecretBox: %v", err)
	}

	var egressCalls, runtimeCalls atomic.Int64
	var policyMu sync.Mutex
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
		agentID := strings.TrimSuffix(strings.TrimSuffix(path, "/fence"), "/reset-flows")
		if agentID == request.URL.Path || agentID == "" {
			t.Fatalf("Egress request = %s %s", request.Method, request.URL.Path)
		}
		if request.Method == http.MethodPost &&
			(path == agentID+"/fence" || path == agentID+"/reset-flows") {
			if path == agentID+"/fence" {
				policyMu.Lock()
				if policyID != "builtin-deny-all" {
					policyID = "builtin-deny-all"
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
		action := "initialize"
		agentID := strings.TrimSuffix(path, "/initialize")
		kind := "initialize_runtime"
		revision := "rtv_22222222222222222222222222222222"
		executionID := "runtime-execution-e2e"
		endpoint := "http://runtime-e2e:8091/mcp"
		if strings.HasSuffix(path, "/update") {
			action = "update"
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
		}
		requestID := request.Header.Get("Idempotency-Key")
		if request.Method != http.MethodPost || path != agentID+"/"+action || agentID == "" || requestID == "" {
			t.Fatalf("Runtime request = %s %s idempotency=%q", request.Method, request.URL.Path, requestID)
		}
		response.Header().Set("Content-Type", "application/json")
		inspection := map[string]any{
			"agent_id": agentID, "runtime_revision": revision,
			"lifecycle_state": "ready", "health": "healthy",
			"mcp_endpoint": endpoint, "runtime_execution_id": executionID,
			"restart_count": 0, "observed_at": "2026-09-01T00:00:00Z",
		}
		if action == "disable" {
			inspection["lifecycle_state"] = "disabled"
			inspection["health"] = "absent"
			delete(inspection, "mcp_endpoint")
			delete(inspection, "runtime_execution_id")
		}
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
	clock := fixedClock{now: time.Unix(20, 0).UTC()}
	handler, err := server.NewHandler(
		application.NewCatalogService(repository, secretBox, clock),
		application.NewLifecycleService(repository, repository, egress, runtime, clock),
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
	created := serveJSON(t, handler, http.MethodPost, "/internal/agents", createBody, http.StatusAccepted)
	agent := created["agent"].(map[string]any)
	operation := created["operation"].(map[string]any)
	if agent["lifecycle_state"] != "available" || operation["state"] != "completed" ||
		agent["owner_user_id"] != "agent-e2e-user" {
		t.Fatalf("created Agent = %+v operation=%+v", agent, operation)
	}
	replayed := serveJSON(t, handler, http.MethodPost, "/internal/agents", createBody, http.StatusAccepted)
	if replayed["agent_access_subject"] != created["agent_access_subject"] ||
		egressCalls.Load() != 2 || runtimeCalls.Load() != 1 {
		t.Fatalf("idempotent replay repeated effects: egress=%d runtime=%d replay=%+v",
			egressCalls.Load(), runtimeCalls.Load(), replayed)
	}

	agentID := agent["agent_id"].(string)
	rebuildBody := `{
		"request_id":"agent-e2e-rebuild",
		"template_id":"` + templateID + `",
		"template_revision":1
	}`
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
	replayedRebuild := serveJSON(
		t, handler, http.MethodPost, "/internal/agents/"+agentID+"/rebuild",
		rebuildBody, http.StatusAccepted,
	)
	if replayedRebuild["state"] != "completed" || egressCalls.Load() != 9 || runtimeCalls.Load() != 2 {
		t.Fatalf("idempotent rebuild repeated effects: egress=%d runtime=%d replay=%+v",
			egressCalls.Load(), runtimeCalls.Load(), replayedRebuild)
	}

	disableBody := `{"request_id":"agent-e2e-disable"}`
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
	replayedDisable := serveJSON(
		t, handler, http.MethodPost, "/internal/agents/"+agentID+"/disable",
		disableBody, http.StatusAccepted,
	)
	if replayedDisable["state"] != "completed" || egressCalls.Load() != 11 || runtimeCalls.Load() != 3 {
		t.Fatalf("idempotent disable repeated effects: egress=%d runtime=%d replay=%+v",
			egressCalls.Load(), runtimeCalls.Load(), replayedDisable)
	}
}
