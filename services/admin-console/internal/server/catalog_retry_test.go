package server

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"soft/antnest-platform/services/admin-console/internal/principal"
)

var catalogCreationCases = []struct {
	name     string
	path     string
	keyField string
	body     string
}{
	{
		name: "model", path: "/api/admin/model-profiles", keyField: "profile_key",
		body: `{"display_name":"Support model","provider_connection_id":"connection-1","model":{"model":"support","context_window":8192,"max_output_tokens":1024}}`,
	},
	{
		name: "template", path: "/api/admin/templates", keyField: "template_key",
		body: `{"name":"Support template","model_profile_id":"model-1","system_prompt":"Help users."}`,
	},
}

func TestCatalogCreationKeysFollowScopedCommandIdentity(t *testing.T) {
	for _, scenario := range catalogCreationCases {
		t.Run(scenario.name, func(t *testing.T) {
			backend := newBackendStub()
			var keys []string
			for _, attempt := range []struct{ organization, key string }{
				{"org-1", "catalog-action-0001"},
				{"org-1", "catalog-action-0001"},
				{"org-1", "catalog-action-0002"},
				{"org-2", "catalog-action-0001"},
			} {
				backend.enqueue(http.StatusCreated, `{}`)
				// Reconstructing the BFF must not lose the resource identity for replay.
				handler := newTestHandler(t, backend)
				response := catalogCreationRequest(handler, scenario.path, scenario.body, attempt.organization, attempt.key)
				if response.Code != http.StatusCreated {
					t.Fatalf("status=%d body=%s", response.Code, response.Body.String())
				}
				var payload map[string]any
				decodeBytes(t, backend.calls[len(backend.calls)-1].Body, &payload)
				key, _ := payload[scenario.keyField].(string)
				if key == "" || key != payload["request_id"] || payload["organization_id"] != attempt.organization {
					t.Fatalf("resource identity does not follow scoped command: %v", payload)
				}
				keys = append(keys, key)
			}
			if keys[0] != keys[1] || keys[0] == keys[2] || keys[0] == keys[3] {
				t.Fatalf("retry, new action, or organization isolation broken: %v", keys)
			}
			if string(backend.calls[0].Body) != string(backend.calls[1].Body) {
				t.Fatal("retry changed the payload fingerprint")
			}
		})
	}
}

func TestCatalogCreationRejectsBrowserGeneratedResourceKey(t *testing.T) {
	for _, scenario := range catalogCreationCases {
		t.Run(scenario.name, func(t *testing.T) {
			backend := newBackendStub()
			var body map[string]any
			decodeBytes(t, []byte(scenario.body), &body)
			body[scenario.keyField] = "timestamp-key-from-browser"
			payload, err := json.Marshal(body)
			if err != nil {
				t.Fatal(err)
			}
			response := catalogCreationRequest(newTestHandler(t, backend), scenario.path, string(payload), "org-1", "catalog-action-0001")
			if response.Code != http.StatusBadRequest || len(backend.calls) != 0 {
				t.Fatalf("browser resource key reached owner: status=%d calls=%d", response.Code, len(backend.calls))
			}
		})
	}
}

func catalogCreationRequest(handler http.Handler, path, body, organization, key string) *httptest.ResponseRecorder {
	request := httptest.NewRequest(http.MethodPost, path, strings.NewReader(body))
	request.Header.Set(principal.HeaderUserID, "user-admin")
	request.Header.Set(principal.HeaderOrganizationID, organization)
	request.Header.Set(principal.HeaderMembershipID, "membership-1")
	request.Header.Set(principal.HeaderSystemRole, "admin")
	request.Header.Set(principal.HeaderOrganizationRole, "admin")
	request.Header.Set("Idempotency-Key", key)
	request.Header.Set("Content-Type", "application/json")
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	return response
}
