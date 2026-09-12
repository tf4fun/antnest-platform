package server

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"reflect"
	"strings"
	"testing"

	"soft/antnest-platform/services/admin-console/internal/principal"
	"soft/antnest-platform/services/admin-console/internal/upstream"
)

const networkPath = "/api/admin/agents/agent-1/network-policy"
const networkBody = `{"action":"allow_all","expected_resource_version":7}`
const networkAssignment = `{"agent_id":"agent-1","policy_id":"builtin/allow-all","revision":1,"resource_version":8,"credential_ref":"private-value"}`

func networkViewFixture() string {
	return `{"agent_id":"agent-1","policy":{"policy_id":"named-allow","revision":3,"resource_version":7,"spec":{"schema_version":1,"action":"deny_all","private":"hidden"},"digest":"sha256:` + strings.Repeat("a", 64) + `"},"attachment":{"state":"closed","resource_version":4,"tunnel_ip":"private"},"organization_id":"private"}`
}

func requestNetworkAdmin(t *testing.T, handler http.Handler, method, path, body string) *httptest.ResponseRecorder {
	t.Helper()
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, networkRequest(method, path, body, "org-1"))
	return response
}

func networkRequest(method, path, body, org string) *http.Request {
	request := scopedLifecycleRequest(method, path, body, org)
	expected, _ := json.Marshal([]string{org, "user-admin"})
	request.Header.Set("X-Antnest-Expected-Principal", url.PathEscape(string(expected)))
	return request
}

func TestNetworkPolicyRejectsChangedAccountBeforeDispatch(t *testing.T) {
	for _, expected := range []string{"", "invalid", `["org-1","other-admin"]`, `["other-org","user-admin"]`, `["org-1","user-admin","extra"]`} {
		backend := newBackendStub()
		request := networkRequest(http.MethodPut, networkPath, networkBody, "org-1")
		request.Header.Set("X-Antnest-Expected-Principal", url.PathEscape(expected))
		response := httptest.NewRecorder()
		newTestHandler(t, backend).ServeHTTP(response, request)
		if response.Code != http.StatusConflict || len(backend.calls) != 0 || !strings.Contains(response.Body.String(), "principal_changed") {
			t.Fatalf("expected=%q status=%d calls=%v body=%s", expected, response.Code, backend.calls, response.Body.String())
		}
	}
}

func TestNetworkPolicyReadProjectsSpecAndTrustedScope(t *testing.T) {
	backend := newBackendStub()
	backend.enqueue(http.StatusOK, networkViewFixture())
	response := requestNetworkAdmin(t, newTestHandler(t, backend), http.MethodGet, networkPath, "")
	if response.Code != 200 || response.Header().Get("Cache-Control") != "no-store" {
		t.Fatalf("response=%d %s", response.Code, response.Body.String())
	}
	var value map[string]any
	decodeBytes(t, response.Body.Bytes(), &value)
	want := map[string]any{"agent_id": "agent-1", "action": "deny_all", "resource_version": float64(7), "attachment": map[string]any{"state": "closed", "resource_version": float64(4)}}
	if !reflect.DeepEqual(value, want) || len(backend.calls) != 1 {
		t.Fatalf("projection=%v calls=%v", value, backend.calls)
	}
	call := backend.calls[0]
	query, _ := url.ParseQuery(call.Query)
	if call.Target != upstream.AgentController || call.Method != http.MethodGet || call.Path != "/internal/agents/agent-1/network-policy" || query.Get("organization_id") != "org-1" {
		t.Fatalf("call=%+v", call)
	}
}

func TestNetworkPolicyCommandIsOneScopedCAS(t *testing.T) {
	backend := newBackendStub()
	backend.enqueueFor("/internal/agents/agent-1/network-policy", http.StatusOK, networkAssignment)
	var original map[string]any
	for index, org := range []string{"org-1", "org-1", "org-2"} {
		response := httptest.NewRecorder()
		newTestHandler(t, backend).ServeHTTP(response, networkRequest(http.MethodPut, networkPath, networkBody, org))
		if response.Code != 200 || len(backend.calls) != index+1 {
			t.Fatalf("write=%d calls=%d %s", response.Code, len(backend.calls), response.Body.String())
		}
		call := backend.calls[index]
		var body map[string]any
		decodeBytes(t, call.Body, &body)
		if call.Method != http.MethodPut || call.Path != "/internal/agents/agent-1/network-policy" || body["organization_id"] != org || body["actor_principal_id"] != "user-admin" || body["policy_id"] != "builtin/allow-all" || body["revision"] != float64(1) || body["expected_resource_version"] != float64(7) {
			t.Fatalf("body=%+v call=%+v", body, call)
		}
		if index == 0 {
			original = body
		}
		if index == 1 && !reflect.DeepEqual(body, original) {
			t.Fatal("retry identity changed")
		}
		if index == 2 && body["request_id"] == original["request_id"] {
			t.Fatal("request identity shared across organizations")
		}
		if strings.TrimSpace(response.Body.String()) != `{"agent_id":"agent-1","action":"allow_all","resource_version":8}` {
			t.Fatalf("write projection=%s", response.Body.String())
		}
	}
}

func TestNetworkPolicyDenySelectionUsesDenyBuiltin(t *testing.T) {
	backend := newBackendStub()
	backend.enqueue(http.StatusOK, strings.Replace(networkAssignment, "builtin/allow-all", "builtin/deny-all", 1))
	response := requestNetworkAdmin(t, newTestHandler(t, backend), http.MethodPut, networkPath, strings.Replace(networkBody, "allow_all", "deny_all", 1))
	if response.Code != http.StatusOK || !strings.Contains(response.Body.String(), `"action":"deny_all"`) {
		t.Fatalf("response=%d %s", response.Code, response.Body.String())
	}
	call := backend.singleCall(t)
	var input map[string]any
	decodeBytes(t, call.Body, &input)
	if input["policy_id"] != "builtin/deny-all" || input["expected_resource_version"] != float64(7) {
		t.Fatalf("command=%v", input)
	}
}

func TestNetworkPolicyRejectsUntrustedInputBeforeUpstream(t *testing.T) {
	for _, scenario := range []struct {
		method, path, body string
		member, noKey      bool
		want               int
	}{
		{http.MethodGet, networkPath + "?organization_id=foreign", "", false, false, 400},
		{http.MethodPut, networkPath + "?extra=x", networkBody, false, false, 400},
		{http.MethodPut, networkPath, `{"action":"allow_all","expected_resource_version":7,"organization_id":"foreign"}`, false, false, 400},
		{http.MethodPut, networkPath, `{"action":"invalid","expected_resource_version":7}`, false, false, 400},
		{http.MethodPut, networkPath, `{"action":"deny_all","expected_resource_version":9007199254740992}`, false, false, 400},
		{http.MethodPut, networkPath, `{"action":"deny_all","expected_resource_version":0}`, false, false, 400},
		{http.MethodPut, networkPath, networkBody + `{}`, false, false, 400},
		{http.MethodPut, networkPath, networkBody, false, true, 400},
		{http.MethodGet, networkPath, "", true, false, 403},
		{http.MethodPut, networkPath, networkBody, true, false, 403},
	} {
		backend := newBackendStub()
		request := networkRequest(scenario.method, scenario.path, scenario.body, "org-1")
		if scenario.member {
			request.Header.Set(principal.HeaderSystemRole, "user")
			request.Header.Set(principal.HeaderOrganizationRole, "member")
		}
		if scenario.noKey {
			request.Header.Del("Idempotency-Key")
		}
		response := httptest.NewRecorder()
		newTestHandler(t, backend).ServeHTTP(response, request)
		if response.Code != scenario.want || len(backend.calls) != 0 {
			t.Fatalf("input=%+v status=%d calls=%v", scenario, response.Code, backend.calls)
		}
	}
}

func TestNetworkPolicyRejectsMismatchedSuccess(t *testing.T) {
	for _, scenario := range []struct{ method, body string }{
		{http.MethodGet, strings.Replace(networkViewFixture(), `"agent-1"`, `"other"`, 1)},
		{http.MethodGet, strings.Replace(networkViewFixture(), `"schema_version":1`, `"schema_version":2`, 1)},
		{http.MethodGet, strings.Replace(networkViewFixture(), `"closed"`, `"unknown"`, 1)},
		{http.MethodGet, strings.Replace(networkViewFixture(), `"resource_version":7`, `"resource_version":9007199254740992`, 1)},
		{http.MethodPut, strings.Replace(networkAssignment, `"builtin/allow-all"`, `"builtin/deny-all"`, 1)},
		{http.MethodPut, strings.Replace(networkAssignment, `"revision":1`, `"revision":2`, 1)},
		{http.MethodPut, strings.Replace(networkAssignment, `"resource_version":8`, `"resource_version":10`, 1)},
		{http.MethodPut, `null`},
	} {
		backend := newBackendStub()
		backend.enqueue(http.StatusOK, scenario.body)
		response := requestNetworkAdmin(t, newTestHandler(t, backend), scenario.method, networkPath, networkBody)
		if response.Code != 502 || strings.Contains(response.Body.String(), "private") || len(backend.calls) != 1 {
			t.Fatalf("mismatch=%d %s", response.Code, response.Body.String())
		}
	}
}

func TestNetworkPolicyErrorsPreserveMeaningNotPrivatePayload(t *testing.T) {
	for _, scenario := range []struct {
		status int
		code   string
		want   int
	}{
		{409, "resource_version_conflict", 409}, {503, "cleanup_failed", 503}, {404, "agent_not_found", 404},
		{404, "agent_network_not_found", 404}, {502, "dependency_invalid_response", 502},
		{404, "policy_revision_not_found", 404}, {409, "agent_network_unavailable", 409},
		{400, "invalid_request", 400}, {503, "dependency_unavailable", 503}, {500, "internal_error", 500},
		{503, "invalid_request", 502}, {503, "private-code", 502}, {202, "", 502},
	} {
		backend := newBackendStub()
		body, _ := json.Marshal(map[string]any{"code": scenario.code, "message": "private-upstream-data", "credential": "private-secret"})
		backend.enqueue(scenario.status, string(body))
		response := requestNetworkAdmin(t, newTestHandler(t, backend), http.MethodPut, networkPath, networkBody)
		if response.Code != scenario.want || strings.Contains(response.Body.String(), "private") || len(backend.calls) != 1 {
			t.Fatalf("scenario=%+v response=%d %s", scenario, response.Code, response.Body.String())
		}
	}
}
