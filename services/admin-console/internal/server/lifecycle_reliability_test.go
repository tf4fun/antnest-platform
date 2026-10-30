package server

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/tf4fun/antnest-platform/services/admin-console/internal/principal"
	"github.com/tf4fun/antnest-platform/services/admin-console/internal/upstream"
)

func reliabilityOperationPayload() map[string]any {
	return map[string]any{
		"request_id": "request-cancel-1", "agent_id": "agent-1", "kind": "create",
		"phase": "network_ensure", "state": "running",
		"created_at": "2026-09-10T00:00:00Z", "updated_at": "2026-09-10T00:00:01Z",
	}
}

func reliabilityAgentPayload() map[string]any {
	return map[string]any{
		"id": "agent-1", "organization_id": "org-1", "name": "Agent",
		"desired_state": "enabled", "lifecycle_state": "created", "activation_state": "enabled",
		"runtime_state": "unknown", "aggregate_sequence": float64(7),
		"agent_spec_revision_id": "spec-1", "runtime_revision": "rtv-1",
		"failure_code": "", "failure_stage": "",
		"created_at": "2026-09-10T00:00:00Z", "updated_at": "2026-09-10T00:00:01Z",
	}
}

func TestLifecycleReliabilityCancelForwardsScopedRequest(t *testing.T) {
	backend := newBackendStub()
	backend.enqueue(http.StatusAccepted, reliabilityOperationPayloadJSON(t, reliabilityOperationPayload()))
	handler := newTestHandler(t, backend)
	request := scopedLifecycleRequest(http.MethodPost, "/api/admin/agents/agent-1/lifecycle-operation/cancel",
		`{"operation_request_id":"request-cancel-1"}`, "org-1")
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	if response.Code != http.StatusAccepted {
		t.Fatalf("cancel must forward the upstream 202: status=%d body=%s", response.Code, response.Body.String())
	}
	if len(backend.calls) != 1 {
		t.Fatalf("expected one upstream call: %v", backend.calls)
	}
	call := backend.calls[0]
	if call.Target != upstream.AgentController || call.Method != http.MethodPost ||
		call.Path != "/internal/agents/agent-1/lifecycle-operation/cancel" || call.Query != "" {
		t.Fatalf("unexpected authority: %+v", call)
	}
	var payload map[string]any
	decodeBytes(t, call.Body, &payload)
	if payload["organization_id"] != "org-1" || payload["actor_principal_id"] != "user-admin" ||
		payload["operation_request_id"] != "request-cancel-1" || len(payload) != 3 {
		t.Fatalf("forwarded body must carry only scoped fields: %v", payload)
	}
}

func TestLifecycleReliabilityClearForwardsScopedRevision(t *testing.T) {
	backend := newBackendStub()
	backend.enqueue(http.StatusOK, reliabilityAgentPayloadJSON(t, reliabilityAgentPayload()))
	handler := newTestHandler(t, backend)
	request := scopedLifecycleRequest(http.MethodPost, "/api/admin/agents/agent-1/lifecycle-quarantine/clear",
		`{"expected_aggregate_sequence":7}`, "org-1")
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	if response.Code != http.StatusOK {
		t.Fatalf("clear must forward the upstream 200: status=%d body=%s", response.Code, response.Body.String())
	}
	call := backend.calls[0]
	if call.Target != upstream.AgentController || call.Method != http.MethodPost ||
		call.Path != "/internal/agents/agent-1/lifecycle-quarantine/clear" {
		t.Fatalf("unexpected authority: %+v", call)
	}
	var payload map[string]any
	decodeBytes(t, call.Body, &payload)
	if payload["organization_id"] != "org-1" || payload["actor_principal_id"] != "user-admin" ||
		payload["expected_aggregate_sequence"] != float64(7) || len(payload) != 3 {
		t.Fatalf("forwarded body must carry only scoped fields: %v", payload)
	}
}

func TestLifecycleReliabilityRejectsInvalidAndForgedInput(t *testing.T) {
	for _, scenario := range []struct {
		name string
		path string
		body string
	}{
		{"cancel forged org", "/api/admin/agents/agent-1/lifecycle-operation/cancel",
			`{"operation_request_id":"request-1","organization_id":"org-9"}`},
		{"cancel forged actor", "/api/admin/agents/agent-1/lifecycle-operation/cancel",
			`{"operation_request_id":"request-1","actor_principal_id":"user-9"}`},
		{"cancel missing id", "/api/admin/agents/agent-1/lifecycle-operation/cancel", `{}`},
		{"cancel unknown field", "/api/admin/agents/agent-1/lifecycle-operation/cancel",
			`{"operation_request_id":"request-1","extra":"x"}`},
		{"cancel trailing json", "/api/admin/agents/agent-1/lifecycle-operation/cancel",
			`{"operation_request_id":"request-1"} {"a":1}`},
		{"cancel null body", "/api/admin/agents/agent-1/lifecycle-operation/cancel", `null`},
		{"cancel array body", "/api/admin/agents/agent-1/lifecycle-operation/cancel", `[1]`},
		{"cancel bad agent id", "/api/admin/agents/agent%20space/lifecycle-operation/cancel",
			`{"operation_request_id":"request-1"}`},
		{"clear zero seq", "/api/admin/agents/agent-1/lifecycle-quarantine/clear",
			`{"expected_aggregate_sequence":0}`},
		{"clear negative seq", "/api/admin/agents/agent-1/lifecycle-quarantine/clear",
			`{"expected_aggregate_sequence":-1}`},
		{"clear fractional seq", "/api/admin/agents/agent-1/lifecycle-quarantine/clear",
			`{"expected_aggregate_sequence":7.5}`},
		{"clear string seq", "/api/admin/agents/agent-1/lifecycle-quarantine/clear",
			`{"expected_aggregate_sequence":"7"}`},
		{"clear unsafe seq", "/api/admin/agents/agent-1/lifecycle-quarantine/clear",
			`{"expected_aggregate_sequence":9007199254740992}`},
		{"clear missing seq", "/api/admin/agents/agent-1/lifecycle-quarantine/clear", `{}`},
		{"clear forged org", "/api/admin/agents/agent-1/lifecycle-quarantine/clear",
			`{"expected_aggregate_sequence":7,"organization_id":"org-9"}`},
	} {
		t.Run(scenario.name, func(t *testing.T) {
			backend := newBackendStub()
			handler := newTestHandler(t, backend)
			request := scopedLifecycleRequest(http.MethodPost, scenario.path, scenario.body, "org-1")
			response := httptest.NewRecorder()
			handler.ServeHTTP(response, request)
			if response.Code == http.StatusOK || response.Code == http.StatusAccepted {
				t.Fatalf("%s must not forward: status=%d", scenario.name, response.Code)
			}
			if len(backend.calls) != 0 {
				t.Fatalf("%s reached the backend: %v", scenario.name, backend.calls)
			}
		})
	}
}

func TestLifecycleReliabilityPreservesUpstreamFailure(t *testing.T) {
	for _, scenario := range []struct {
		name   string
		path   string
		status int
		body   string
	}{
		{"cancel not found", "/api/admin/agents/agent-1/lifecycle-operation/cancel",
			http.StatusNotFound, `{"code":"agent_not_found","message":"missing"}`},
		{"cancel dependency", "/api/admin/agents/agent-1/lifecycle-operation/cancel",
			http.StatusServiceUnavailable, `{"code":"dependency_unavailable","message":"down"}`},
		{"clear conflict", "/api/admin/agents/agent-1/lifecycle-quarantine/clear",
			http.StatusConflict, `{"code":"lifecycle_conflict","message":"stale"}`},
		{"clear not found", "/api/admin/agents/agent-1/lifecycle-quarantine/clear",
			http.StatusNotFound, `{"code":"agent_not_found","message":"missing"}`},
	} {
		t.Run(scenario.name, func(t *testing.T) {
			backend := newBackendStub()
			backend.enqueue(scenario.status, scenario.body)
			handler := newTestHandler(t, backend)
			body := `{"operation_request_id":"request-1"}`
			if strings.Contains(scenario.path, "quarantine") {
				body = `{"expected_aggregate_sequence":7}`
			}
			request := scopedLifecycleRequest(http.MethodPost, scenario.path, body, "org-1")
			response := httptest.NewRecorder()
			handler.ServeHTTP(response, request)
			if response.Code != scenario.status {
				t.Fatalf("%s status=%d body=%s", scenario.name, response.Code, response.Body.String())
			}
			if len(backend.calls) != 1 {
				t.Fatalf("%s must reach the backend once: %v", scenario.name, backend.calls)
			}
		})
	}
}

func reliabilityOperationPayloadJSON(t *testing.T, payload map[string]any) string {
	t.Helper()
	encoded, err := json.Marshal(payload)
	if err != nil {
		t.Fatal(err)
	}
	return string(encoded)
}

func reliabilityAgentPayloadJSON(t *testing.T, payload map[string]any) string {
	t.Helper()
	return reliabilityOperationPayloadJSON(t, payload)
}

func reliabilityMemberRequest(method, path, body string) *http.Request {
	request := httptest.NewRequest(method, path, strings.NewReader(body))
	request.Header.Set(principal.HeaderUserID, "user-member")
	request.Header.Set(principal.HeaderOrganizationID, "org-1")
	request.Header.Set(principal.HeaderMembershipID, "membership-2")
	request.Header.Set(principal.HeaderSystemRole, "user")
	request.Header.Set(principal.HeaderOrganizationRole, "member")
	request.Header.Set("Content-Type", "application/json")
	return request
}

func TestLifecycleReliabilityDeniesUnsignedAndMembers(t *testing.T) {
	bodies := map[string]string{
		"/api/admin/agents/agent-1/lifecycle-operation/cancel": `{"operation_request_id":"request-1"}`,
		"/api/admin/agents/agent-1/lifecycle-quarantine/clear": `{"expected_aggregate_sequence":7}`,
	}
	for path, body := range bodies {
		t.Run(path, func(t *testing.T) {
			backend := newBackendStub()
			handler := newTestHandler(t, backend)
			unsigned := httptest.NewRequest(http.MethodPost, path, strings.NewReader(body))
			unsigned.Header.Set("Content-Type", "application/json")
			response := httptest.NewRecorder()
			handler.ServeHTTP(response, unsigned)
			if response.Code != http.StatusUnauthorized && response.Code != http.StatusForbidden {
				t.Fatalf("unsigned request must be denied: status=%d", response.Code)
			}
			member := httptest.NewRecorder()
			handler.ServeHTTP(member, reliabilityMemberRequest(http.MethodPost, path, body))
			if member.Code != http.StatusForbidden && member.Code != http.StatusUnauthorized {
				t.Fatalf("member request must be denied: status=%d", member.Code)
			}
			if len(backend.calls) != 0 {
				t.Fatalf("denied requests reached the backend: %v", backend.calls)
			}
		})
	}
}

func TestLifecycleReliabilityExcludesPrivateUpstreamFields(t *testing.T) {
	operation := reliabilityOperationPayload()
	operation["private_runtime_endpoint"] = "10.0.0.9"
	operation["internal_tunnel_key"] = "rtk_secret"
	backend := newBackendStub()
	backend.enqueue(http.StatusAccepted, reliabilityOperationPayloadJSON(t, operation))
	handler := newTestHandler(t, backend)
	request := scopedLifecycleRequest(http.MethodPost, "/api/admin/agents/agent-1/lifecycle-operation/cancel",
		`{"operation_request_id":"request-1"}`, "org-1")
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	if response.Code != http.StatusAccepted {
		t.Fatalf("status=%d", response.Code)
	}
	if strings.Contains(response.Body.String(), "private_runtime_endpoint") ||
		strings.Contains(response.Body.String(), "rtk_secret") {
		t.Fatalf("private upstream fields leaked: %s", response.Body.String())
	}
	agentPayload := reliabilityAgentPayload()
	agentPayload["private_runtime_endpoint"] = "10.0.0.9"
	backend2 := newBackendStub()
	backend2.enqueue(http.StatusOK, reliabilityAgentPayloadJSON(t, agentPayload))
	handler2 := newTestHandler(t, backend2)
	request2 := scopedLifecycleRequest(http.MethodPost, "/api/admin/agents/agent-1/lifecycle-quarantine/clear",
		`{"expected_aggregate_sequence":7}`, "org-1")
	response2 := httptest.NewRecorder()
	handler2.ServeHTTP(response2, request2)
	if response2.Code != http.StatusOK {
		t.Fatalf("status=%d", response2.Code)
	}
	if strings.Contains(response2.Body.String(), "private_runtime_endpoint") {
		t.Fatalf("private upstream fields leaked: %s", response2.Body.String())
	}
}

func TestLifecycleReliabilityMalformedRequestsReturnBadRequest(t *testing.T) {
	for _, scenario := range []struct {
		name string
		path string
		body string
		want int
	}{
		{"cancel malformed operation id", "/api/admin/agents/agent-1/lifecycle-operation/cancel",
			`{"operation_request_id":"bad id!"}`, http.StatusBadRequest},
		{"cancel query rejected", "/api/admin/agents/agent-1/lifecycle-operation/cancel?organization_id=org-9",
			`{"operation_request_id":"request-1"}`, http.StatusBadRequest},
		{"clear null revision", "/api/admin/agents/agent-1/lifecycle-quarantine/clear",
			`{"expected_aggregate_sequence":null}`, http.StatusBadRequest},
		{"clear query rejected", "/api/admin/agents/agent-1/lifecycle-quarantine/clear?expected=1",
			`{"expected_aggregate_sequence":7}`, http.StatusBadRequest},
		{"clear fractional", "/api/admin/agents/agent-1/lifecycle-quarantine/clear",
			`{"expected_aggregate_sequence":1.5}`, http.StatusBadRequest},
	} {
		t.Run(scenario.name, func(t *testing.T) {
			backend := newBackendStub()
			handler := newTestHandler(t, backend)
			request := scopedLifecycleRequest(http.MethodPost, scenario.path, scenario.body, "org-1")
			response := httptest.NewRecorder()
			handler.ServeHTTP(response, request)
			if response.Code != scenario.want {
				t.Fatalf("%s: status=%d body=%s", scenario.name, response.Code, response.Body.String())
			}
			if len(backend.calls) != 0 {
				t.Fatalf("%s reached the backend: %v", scenario.name, backend.calls)
			}
		})
	}
}
