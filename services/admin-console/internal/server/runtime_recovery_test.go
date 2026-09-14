package server

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestUnavailableAgentHistoryProjection(t *testing.T) {
	for _, history := range []string{"", "execution-previous"} {
		t.Run("history="+history, func(t *testing.T) {
			backend := newBackendStub()
			source := map[string]any{
				"agent_id": "agent-1", "desired_state": "enabled", "lifecycle_state": "created", "activation_state": "enabled", "runtime_state": "absent",
				"agent_spec_revision": "spec-previous", "last_successful_execution_revision": history,
				"failure_code": "runtime_deleted", "failure_stage": "runtime_observation",
				"access_revision": "access-private", "runtime_execution_id": "process-private",
				"mcp_endpoint": "http://private.internal/mcp", "credential_ref": "credential-private",
			}
			encoded, err := json.Marshal(source)
			if err != nil {
				t.Fatal(err)
			}
			backend.enqueueFor("/internal/agents/agent-1", http.StatusOK, string(encoded))
			response := httptest.NewRecorder()
			newTestHandler(t, backend).ServeHTTP(response,
				scopedLifecycleRequest(http.MethodGet, "/api/admin/agents/agent-1", "", "org-1"))
			if response.Code != http.StatusOK {
				t.Fatalf("projection status=%d body=%s", response.Code, response.Body)
			}
			var result map[string]any
			decodeBytes(t, response.Body.Bytes(), &result)
			if result["agent_spec_revision"] != "spec-previous" {
				t.Fatalf("missing historical spec: %v", result)
			}
			if history != "" && result["last_successful_execution_revision"] != history {
				t.Fatalf("missing recovery history: %v", result)
			}
			for _, key := range []string{"runtime", "configuration", "executable_execution_revision"} {
				if _, exists := result[key]; exists {
					t.Fatalf("history fabricated executable state: %s", key)
				}
			}
			if strings.Contains(response.Body.String(), "private") {
				t.Fatalf("private source fields leaked: %s", response.Body)
			}
		})
	}
}
