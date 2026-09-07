package server

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"soft/antnest-platform/services/admin-console/internal/principal"
)

const managedMCPFixture = `[{"id":"documents","command":"node","args":["server.js","two words",""],"env":{"TOKEN":"synthetic-env-value","EMPTY":""},"internal_endpoint":"must-not-project"}]`

func TestManagedMCPConfigurationTransportAndProjection(t *testing.T) {
	for _, path := range []string{"/api/admin/templates", "/api/admin/templates/template-1/revisions"} {
		t.Run(path, func(t *testing.T) {
			backend := newBackendStub()
			backend.enqueue(http.StatusCreated, `{"template_id":"template-1","runtime":{"mcp_servers":`+managedMCPFixture+`}}`)
			response := requestAdmin(t, newTestHandler(t, backend), http.MethodPost, path, `{
				"name":"Template","model_profile_revision_id":"model-1","max_model_requests":32,
				"runtime":{"image_ref":"antnest/runtime:local","mcp_servers":[{"id":"documents","command":"node","args":["server.js","two words",""],"env":{"TOKEN":"synthetic-env-value","EMPTY":""}}]}
			}`)
			if response.Code != http.StatusCreated {
				t.Fatalf("response=%d %s", response.Code, response.Body)
			}
			call := backend.singleCall(t)
			if !strings.Contains(string(call.Body), `"args":["server.js","two words",""]`) || !strings.Contains(string(call.Body), `"TOKEN":"synthetic-env-value"`) {
				t.Fatalf("MCP configuration lost in owner request: %s", call.Body)
			}
			if !strings.Contains(response.Body.String(), "synthetic-env-value") || strings.Contains(response.Body.String(), "must-not-project") {
				t.Fatalf("unexpected configuration projection: %s", response.Body)
			}
		})
	}
}

func TestManagedMCPClearAndRawValidationReachOwner(t *testing.T) {
	for _, raw := range []string{`[]`, `[{"id":"documents","command":"node","env":{"BAD":"\ud800"}}]`} {
		t.Run(raw, func(t *testing.T) {
			backend := newBackendStub()
			backend.enqueue(http.StatusBadRequest, `{"code":"invalid_argument","message":"Invalid MCP configuration"}`)
			response := requestAdmin(t, newTestHandler(t, backend), http.MethodPost, "/api/admin/templates/template-1/revisions", `{
				"name":"Template","model_profile_revision_id":"model-1","max_model_requests":32,
				"runtime":{"image_ref":"antnest/runtime:local","mcp_servers":`+raw+`}}`)
			if response.Code != http.StatusBadRequest || !strings.Contains(string(backend.singleCall(t).Body), `"mcp_servers":`+raw) {
				t.Fatal("raw MCP input did not reach its validation authority")
			}
		})
	}
}

func TestManagedMCPReadSurfaces(t *testing.T) {
	for _, path := range []string{"/api/admin/templates/template-1", "/api/admin/templates/template-1/revisions/1"} {
		backend := newBackendStub()
		backend.enqueue(http.StatusOK, `{"template_id":"template-1","runtime":{"mcp_servers":`+managedMCPFixture+`}}`)
		response := requestAdmin(t, newTestHandler(t, backend), http.MethodGet, path, "")
		if response.Code != http.StatusOK || !strings.Contains(response.Body.String(), "synthetic-env-value") {
			t.Fatalf("template configuration unavailable: %s", response.Body)
		}
		if !strings.Contains(backend.singleCall(t).Query, "organization_id=") {
			t.Fatal("configuration read lacked organization scope")
		}
		if response.Header().Get("Cache-Control") != "no-store" {
			t.Fatal("configuration response can be cached")
		}
	}
	for _, path := range []string{"/api/admin/templates", "/api/admin/agents/agent-1"} {
		backend := newBackendStub()
		payload := `{"items":[{"runtime":{"mcp_servers":` + managedMCPFixture + `}}]}`
		if strings.Contains(path, "/agents/") {
			payload = `{"configuration":{"runtime":{"mcp_servers":` + managedMCPFixture + `}}}`
		}
		backend.enqueue(http.StatusOK, payload)
		response := requestAdmin(t, newTestHandler(t, backend), http.MethodGet, path, "")
		if response.Code != http.StatusOK || strings.Contains(response.Body.String(), "synthetic-env-value") || strings.Contains(response.Body.String(), "server.js") {
			t.Fatalf("configuration values leaked in summary: %s", response.Body)
		}
		if strings.Contains(path, "/agents/") && !strings.Contains(response.Body.String(), `"id":"documents"`) {
			t.Fatal("deployed MCP summary missing")
		}
	}
}

func TestManagedMCPDefaultsProjection(t *testing.T) {
	projected, err := projectTemplate([]byte(`{"runtime":{"mcp_servers":[{"id":"docs","command":"node"}]}}`))
	if err != nil || !strings.Contains(string(projected), `"args":[],"env":{}`) {
		t.Fatalf("missing optional fields not normalized: %s %v", projected, err)
	}
}

func TestManagedMCPRequiresAdministrator(t *testing.T) {
	for _, path := range []string{"/api/admin/templates/template-1", "/api/admin/templates/template-1/revisions/1"} {
		backend := newBackendStub()
		request := httptest.NewRequest(http.MethodGet, path, nil)
		request.Header.Set(principal.HeaderUserID, "user-1")
		request.Header.Set(principal.HeaderOrganizationID, "org-1")
		request.Header.Set(principal.HeaderMembershipID, "membership-1")
		request.Header.Set(principal.HeaderSystemRole, "user")
		request.Header.Set(principal.HeaderOrganizationRole, "member")
		response := httptest.NewRecorder()
		newTestHandler(t, backend).ServeHTTP(response, request)
		if response.Code != http.StatusForbidden || len(backend.calls) != 0 {
			t.Fatalf("member reached managed configuration: status=%d", response.Code)
		}
	}
}
