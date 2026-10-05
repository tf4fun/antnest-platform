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

func TestSavedDiscoveryUsesScopedControllerModelsWithoutReadingCredentials(t *testing.T) {
	backend := newBackendStub()
	backend.enqueue(http.StatusOK, `{"models":[{"model_id":"remote","display_name":"Remote","context_window":128000,"supports_images":true,"credential":{"api_key":"synthetic-secret"},"api_key":"synthetic-secret"}],"credential":{"api_key":"synthetic-secret"}}`)
	response := requestAdmin(t, newTestHandler(t, backend), http.MethodGet, "/api/admin/provider-connections/c1/models/discovery", "")
	if response.Code != http.StatusOK || strings.Contains(response.Body.String(), "synthetic-secret") {
		t.Fatalf("discovery response=%d %s", response.Code, response.Body.String())
	}
	if len(backend.calls) != 1 || backend.calls[0].Target != upstream.AgentController || backend.calls[0].Method != http.MethodPost || backend.calls[0].Path != "/internal/provider-connections/c1/discover-models" || backend.calls[0].Query != "" {
		t.Fatalf("discovery did not use Controller: %+v", backend.calls)
	}
	var payload map[string]any
	decodeBytes(t, backend.calls[0].Body, &payload)
	if len(payload) != 1 || payload["organization_id"] != "org-1" {
		t.Fatalf("scope or credential leaked into discovery request: %+v", payload)
	}
	if response.Header().Get("Cache-Control") != "no-store" || len(response.Header().Values("Cache-Control")) != 1 || strings.Contains(response.Body.String(), "pricing") {
		t.Fatal("cached or invented metadata")
	}
}
func TestDraftDiscoveryForwardsEphemeralCredentialOnlyToController(t *testing.T) {
	backend := newBackendStub()
	backend.enqueue(http.StatusOK, `{"models":[]}`)
	body := `{"provider_key":"deepseek","base_url":"http://127.0.0.1:1/v1","credential":{"method":"api_key","api_key":"synthetic-secret"}}`
	response := requestAdmin(t, newTestHandler(t, backend), http.MethodPost, "/api/admin/provider-models/discovery", body)
	if response.Code != http.StatusOK || len(backend.calls) != 1 || strings.Contains(response.Body.String(), "synthetic-secret") {
		t.Fatalf("draft did not proxy to Controller: %d %s", response.Code, response.Body.String())
	}
	call := backend.calls[0]
	if call.Target != upstream.AgentController || call.Method != http.MethodPost || call.Path != "/internal/provider-discovery/draft" || call.Query != "" {
		t.Fatalf("wrong destination: %+v", call)
	}
	var payload map[string]any
	decodeBytes(t, call.Body, &payload)
	if payload["organization_id"] != "org-1" || payload["base_url"] != "http://127.0.0.1:1/v1" || payload["credential"].(map[string]any)["api_key"] != "synthetic-secret" {
		t.Fatal("ephemeral draft or signed scope changed")
	}
}
func TestDiscoveryRejectsMissingInvalidAndCredentialOnlyResponses(t *testing.T) {
	for _, body := range []string{`{}`, `{"models":null}`, `{"models":[{}]}`, `{"models":[{"model_id":"x","display_name":"X","context_window":0}]}`, `{"connection":{"connection_id":"c1","enabled":true},"credential":{"api_key":"secret"}}`} {
		t.Run(body, func(t *testing.T) {
			backend := newBackendStub()
			backend.enqueue(http.StatusOK, body)
			response := requestAdmin(t, newTestHandler(t, backend), http.MethodGet, "/api/admin/provider-connections/c1/models/discovery", "")
			if response.Code != http.StatusBadGateway || strings.Contains(response.Body.String(), "secret") || len(backend.calls) != 1 {
				t.Fatalf("invalid discovery accepted: %d %s", response.Code, response.Body.String())
			}
		})
	}
}
func TestDiscoveryMapsControllerFailuresWithoutEchoingPrivateDetails(t *testing.T) {
	for _, scenario := range []struct {
		status int
		code   string
	}{
		{422, "provider_endpoint_forbidden"}, {503, "provider_endpoint_unavailable"}, {502, "provider_discovery_failed"},
		{404, "reference_not_found"}, {409, "reference_disabled"}, {403, "organization_mismatch"},
	} {
		t.Run(scenario.code, func(t *testing.T) {
			backend := newBackendStub()
			payload, _ := json.Marshal(map[string]any{"code": scenario.code, "message": "synthetic-secret in http://private/v1", "retryable": scenario.status >= 500, "api_key": "synthetic-secret"})
			backend.enqueue(scenario.status, string(payload))
			response := requestAdmin(t, newTestHandler(t, backend), http.MethodGet, "/api/admin/provider-connections/c1/models/discovery", "")
			if response.Code != scenario.status || !strings.Contains(response.Body.String(), scenario.code) || strings.Contains(response.Body.String(), "synthetic-secret") || strings.Contains(response.Body.String(), "http://private") {
				t.Fatalf("private discovery error escaped: %d %s", response.Code, response.Body.String())
			}
		})
	}
}
func TestDraftDiscoveryRejectsBrowserAuthorityAndMalformedCredential(t *testing.T) {
	for _, body := range []string{
		`{"organization_id":"evil","provider_key":"deepseek","base_url":"https://provider.example","credential":{"method":"api_key","api_key":"secret"}}`,
		`{"provider_key":"deepseek","base_url":"https://provider.example","credential":{"method":"oauth","api_key":"secret"}}`,
		`{"provider_key":"deepseek","base_url":"https://provider.example","credential":{"method":"api_key","api_key":""}}`,
		`{"provider_key":"deepseek","base_url":"https://provider.example","credential":{"method":"api_key","api_key":"secret"},"allow_private_endpoints":true}`,
	} {
		backend := newBackendStub()
		response := requestAdmin(t, newTestHandler(t, backend), http.MethodPost, "/api/admin/provider-models/discovery", body)
		if response.Code != http.StatusBadRequest || len(backend.calls) != 0 {
			t.Fatalf("invalid draft reached Controller: %d", response.Code)
		}
	}
}
func TestDiscoveryRequiresAdministratorBeforeCallingController(t *testing.T) {
	for _, route := range []struct{ method, path string }{
		{http.MethodGet, "/api/admin/provider-connections/c1/models/discovery"}, {http.MethodPost, "/api/admin/provider-models/discovery"},
	} {
		for _, member := range []bool{false, true} {
			backend := newBackendStub()
			handler := newTestHandler(t, backend)
			request := httptest.NewRequest(route.method, route.path, nil)
			expected := http.StatusUnauthorized
			if member {
				request.Header.Set(principal.HeaderUserID, "user-1")
				request.Header.Set(principal.HeaderOrganizationID, "org-1")
				request.Header.Set(principal.HeaderMembershipID, "membership-1")
				request.Header.Set(principal.HeaderSystemRole, "user")
				request.Header.Set(principal.HeaderOrganizationRole, "member")
				expected = http.StatusForbidden
			}
			response := httptest.NewRecorder()
			handler.ServeHTTP(response, request)
			if response.Code != expected || len(backend.calls) > 0 {
				t.Fatalf("authority boundary: %d", response.Code)
			}
		}
	}
}
