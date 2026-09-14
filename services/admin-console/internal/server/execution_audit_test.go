package server

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"

	"github.com/stretchr/testify/require"
	"soft/antnest-platform/services/admin-console/internal/principal"
	"soft/antnest-platform/services/admin-console/internal/upstream"
)

const auditSummaryFixture = `{"run_id":"run-1","session_id":"session-1","agent_id":"deleted-agent","principal_id":"owner-1","state":"completed","created_at":"2026-09-14T10:00:00.123456Z","updated_at":"2026-09-14T10:01:00Z"}`

func auditDetailFixture() string {
	return strings.TrimSuffix(auditSummaryFixture, "}") + `,"input":[{"type":"text","text":"original prompt"}],"execution_snapshot":{"modelProfileId":"model-1","executionSpec":{"model":{"model":"example-model","contextWindow":128000,"maxOutputTokens":8192,"supportsImages":false}}},"terminal_class":"completed","executor_state":"quiescent","tool_effect_state":"settled","stop_reason":"end_turn","error_class":null,"usage_measurements":[],"internal_only":"omit-me"}`
}

func TestExecutionAuditListCallsOnlyACP(t *testing.T) {
	backend := newBackendStub()
	backend.enqueue(http.StatusOK, `{"items":[],"next_cursor":null}`)
	response := requestAdmin(t, newTestHandler(t, backend), http.MethodGet,
		"/api/admin/execution-audits?agent_id=deleted-agent&limit=20&cursor=opaque-anchor", "")
	require.Equal(t, http.StatusOK, response.Code, response.Body.String())
	call := backend.singleCall(t)
	require.Equal(t, upstream.Target("agent-acp-service"), call.Target)
	require.Equal(t, http.MethodPost, call.Method)
	require.Equal(t, "/rpc/agent-acp/list-execution-audits", call.Path)
	require.JSONEq(t, `{"agent_id":"deleted-agent","limit":20,"cursor":"opaque-anchor"}`, string(call.Body))
	require.Equal(t, "no-store", response.Header().Get("Cache-Control"))
	require.JSONEq(t, `{"items":[],"next_cursor":null}`, response.Body.String())
}

func TestExecutionAuditDetailAndStreamsUseReadOnlyRPCs(t *testing.T) {
	for _, test := range []struct{ path, rpc, body, input string }{
		{"/api/admin/execution-audits/run-1", "get-execution-audit", auditDetailFixture(), `{"run_id":"run-1"}`},
		{"/api/admin/execution-audits/run-1/events?stream=execution&cursor=messages-anchor", "list-execution-events",
			`{"stream":"execution","items":[{"id":"event-1","sequence":7,"kind":"tool_result","visible":true,"payload":{"text":"tool output"},"created_at":"2026-09-14T10:00:00Z","internal_only":"omit-me"}],"next_cursor":"messages-next"}`, `{"run_id":"run-1","stream":"execution","cursor":"messages-anchor"}`},
		{"/api/admin/execution-audits/run-1/events?stream=permissions&cursor=permissions-anchor", "list-execution-events",
			`{"stream":"permissions","items":[{"tool_call_id":"call:/+1","request":{"command":"pwd"},"decision":"allow_once","reason":null,"created_at":"2026-09-14T10:00:00Z","decided_at":null,"internal_only":"omit-me"}],"next_cursor":"permissions-next"}`, `{"run_id":"run-1","stream":"permissions","cursor":"permissions-anchor"}`},
	} {
		t.Run(test.rpc+test.path, func(t *testing.T) {
			backend := newBackendStub()
			backend.enqueue(http.StatusOK, test.body)
			response := requestAdmin(t, newTestHandler(t, backend), http.MethodGet, test.path, "")
			require.Equal(t, http.StatusOK, response.Code, response.Body.String())
			call := backend.singleCall(t)
			require.Equal(t, upstream.AgentACP, call.Target)
			require.Equal(t, http.MethodPost, call.Method)
			require.Equal(t, "/rpc/agent-acp/"+test.rpc, call.Path)
			require.JSONEq(t, test.input, string(call.Body))
			require.NotContains(t, response.Body.String(), "omit-me")
			require.Equal(t, "no-store", response.Header().Get("Cache-Control"))
			var original, projected map[string]json.RawMessage
			require.NoError(t, json.Unmarshal([]byte(test.body), &original))
			require.NoError(t, json.Unmarshal(response.Body.Bytes(), &projected))
			if test.rpc == "get-execution-audit" {
				require.JSONEq(t, string(original["input"]), string(projected["input"]))
				require.JSONEq(t, string(original["execution_snapshot"]), string(projected["execution_snapshot"]))
			} else {
				require.Equal(t, original["next_cursor"], projected["next_cursor"])
				var source, view []map[string]json.RawMessage
				require.NoError(t, json.Unmarshal(original["items"], &source))
				require.NoError(t, json.Unmarshal(projected["items"], &view))
				require.Len(t, view, len(source))
				for name, value := range source[0] {
					if name != "internal_only" {
						require.JSONEq(t, string(value), string(view[0][name]), name)
					}
				}
			}
		})
	}
}

func TestExecutionAuditQueryPreservesOpaqueIDsAndMicroseconds(t *testing.T) {
	backend := newBackendStub()
	backend.enqueue(http.StatusOK, `{"items":[],"next_cursor":null}`)
	query := url.Values{"agent_id": {"Agent/one #2"}, "created_from": {"2026-09-14T10:00:00.123456Z"}, "cursor": {strings.Repeat("x", 3000)}}
	response := requestAdmin(t, newTestHandler(t, backend), http.MethodGet, "/api/admin/execution-audits?"+query.Encode(), "")
	require.Equal(t, http.StatusOK, response.Code, response.Body.String())
	var payload map[string]string
	require.NoError(t, json.Unmarshal(backend.singleCall(t).Body, &payload))
	for name := range query {
		require.Equal(t, query.Get(name), payload[name])
	}
	backend = newBackendStub()
	backend.enqueue(http.StatusOK, auditDetailFixture())
	response = requestAdmin(t, newTestHandler(t, backend), http.MethodGet, "/api/admin/execution-audits/"+url.PathEscape("Run/one #2"), "")
	require.Equal(t, http.StatusOK, response.Code, response.Body.String())
	require.JSONEq(t, `{"run_id":"Run/one #2"}`, string(backend.singleCall(t).Body))
}

func TestExecutionAuditRejectsScopeInjectionAndAmbiguousQueries(t *testing.T) {
	for _, path := range []string{
		"/api/admin/execution-audits?organization_id=other", "/api/admin/execution-audits?principal_id=other",
		"/api/admin/execution-audits?limit=1&limit=2", "/api/admin/execution-audits?limit=101",
		"/api/admin/execution-audits?limit=0", "/api/admin/execution-audits?limit=nan",
		"/api/admin/execution-audits?cursor=", "/api/admin/execution-audits?cursor=%zz",
		"/api/admin/execution-audits/run-1?organization_id=other",
		"/api/admin/execution-audits/run-1/events?organization_id=other",
		"/api/admin/execution-synchronization?organization_id=other",
	} {
		backend := newBackendStub()
		response := requestAdmin(t, newTestHandler(t, backend), http.MethodGet, path, "")
		require.Equal(t, http.StatusBadRequest, response.Code, response.Body.String())
		require.Empty(t, backend.calls)
	}
}

func TestExecutionReadsRequireTrustedAdministrator(t *testing.T) {
	for _, path := range []string{"/api/admin/execution-audits", "/api/admin/execution-audits/run-1", "/api/admin/execution-audits/run-1/events", "/api/admin/execution-synchronization"} {
		backend := newBackendStub()
		handler := newTestHandler(t, backend)
		request := httptest.NewRequest(http.MethodGet, path, nil)
		response := httptest.NewRecorder()
		handler.ServeHTTP(response, request)
		require.Equal(t, http.StatusUnauthorized, response.Code)
		actor := principal.Principal{UserID: "owner-1", OrganizationID: "org-1", MembershipID: "member-1", SystemRole: "user", OrganizationRole: "member"}
		header, err := actor.Headers()
		require.NoError(t, err)
		request.Header = header
		response = httptest.NewRecorder()
		handler.ServeHTTP(response, request)
		require.Equal(t, http.StatusForbidden, response.Code)
		require.Empty(t, backend.calls)
	}
}

func TestExecutionAuditUnavailableOrInvalidDataIsNotEmptyHistory(t *testing.T) {
	for _, test := range []struct {
		path, body                     string
		upstreamStatus, expectedStatus int
	}{
		{"/api/admin/execution-audits", `{"code":"unavailable"}`, 503, 503},
		{"/api/admin/execution-audits/run-1", `{"code":"not_found"}`, 404, 404},
		{"/api/admin/execution-audits", `{"code":"access_denied"}`, 403, 403},
		{"/api/admin/execution-audits", `{}`, 200, 502},
		{"/api/admin/execution-audits", `{"items":null,"next_cursor":null}`, 200, 502},
		{"/api/admin/execution-audits", `{"items":[],"next_cursor":5}`, 200, 502},
		{"/api/admin/execution-audits", `{"items":[{}],"next_cursor":null}`, 200, 502},
		{"/api/admin/execution-audits/run-1", `{}`, 200, 502},
		{"/api/admin/execution-audits/run-1/events", `{"stream":"unknown","items":[],"next_cursor":null}`, 200, 502},
		{"/api/admin/execution-audits/run-1/events", `{"stream":"execution","items":[{}],"next_cursor":null}`, 200, 502},
		{"/api/admin/execution-audits/run-1/events", `{"stream":"permissions","items":[{}],"next_cursor":null}`, 200, 502},
	} {
		backend := newBackendStub()
		backend.enqueue(test.upstreamStatus, test.body)
		response := requestAdmin(t, newTestHandler(t, backend), http.MethodGet, test.path, "")
		require.Equal(t, test.expectedStatus, response.Code, response.Body.String())
		require.NotContains(t, response.Body.String(), `"items":[]`)
	}
}

func TestConfigurationSynchronizationUsesOnlyControllerScope(t *testing.T) {
	for _, test := range []struct {
		body   string
		status int
	}{
		{`{"organization_id":"org-1","synchronization":null}`, 200},
		{`{"organization_id":"org-1","synchronization":{"revision":8,"applied_revision":7,"updated_at":"2026-09-14T10:00:00Z","applied_at":"2026-09-14T09:00:00Z"}}`, 200},
		{`{"organization_id":"org-1","synchronization":{"revision":8,"applied_revision":0,"updated_at":"2026-09-14T10:00:00Z","applied_at":null}}`, 200},
		{`{"organization_id":"other","synchronization":null}`, 502},
		{`{"organization_id":"org-1"}`, 502},
		{`{"organization_id":"org-1","synchronization":{"revision":8,"applied_revision":9,"updated_at":"2026-09-14T10:00:00Z","applied_at":"2026-09-14T09:00:00Z"}}`, 502},
	} {
		backend := newBackendStub()
		backend.enqueue(http.StatusOK, test.body)
		response := requestAdmin(t, newTestHandler(t, backend), http.MethodGet, "/api/admin/execution-synchronization", "")
		require.Equal(t, test.status, response.Code, response.Body.String())
		call := backend.singleCall(t)
		require.Equal(t, upstream.AgentController, call.Target)
		require.Equal(t, "/internal/execution-synchronization", call.Path)
		require.Equal(t, "organization_id=org-1", call.Query)
		require.Empty(t, call.Body)
		require.NotContains(t, response.Body.String(), "organization_id")
		require.NotContains(t, response.Body.String(), "ready")
	}
}
