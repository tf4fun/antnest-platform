package server

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"soft/antnest-platform/services/admin-console/internal/principal"
)

func TestNativeModelInputProjectionSurfaces(t *testing.T) {
	for _, flags := range []string{``, `,"supports_audio":false,"supports_pdf":false`, `,"supports_audio":true,"supports_pdf":true`} {
		model := `{"model":"native","supports_images":true` + flags + `,"credential_ref":"must-not-project"}`
		for _, tc := range []struct {
			name    string
			project func([]byte) ([]byte, error)
			body    string
		}{
			{"profile", projectModelProfile, `{"model":` + model + `}`},
			{"list", projectModelProfileList, `{"items":[{"model":` + model + `}]}`},
			{"agent", projectAgent, `{"configuration":{"model_profile":{"model":` + model + `}}}`},
		} {
			t.Run(tc.name+flags, func(t *testing.T) {
				result, err := tc.project([]byte(tc.body))
				if err != nil {
					t.Fatal(err)
				}
				for _, key := range []string{"supports_audio", "supports_pdf"} {
					want := strings.Contains(flags, `"`+key+`":true`)
					if strings.Contains(string(result), `"`+key+`":true`) != want {
						t.Fatalf("lost %s: %s", key, result)
					}
				}
				if strings.Contains(string(result), "must-not-project") {
					t.Fatalf("nested private field exposed: %s", result)
				}
			})
		}
	}
}

func TestNativeModelInputCommandsPreserveFlagsAndOwnerRejections(t *testing.T) {
	for _, path := range []string{"/api/admin/model-profiles", "/api/admin/model-profiles/model-1/revisions"} {
		for _, status := range []int{http.StatusCreated, http.StatusBadRequest} {
			backend := newBackendStub()
			model := `{"model":"native","supports_images":false,"supports_audio":true,"supports_pdf":false}`
			backend.enqueue(status, `{"model_profile_id":"model-1","model":`+model+`}`)
			result := requestAdmin(t, newTestHandler(t, backend), http.MethodPost, path,
				modelCommandBody(path, "Native", model))
			if result.Code != status {
				t.Fatalf("status=%d body=%s", result.Code, result.Body)
			}
			var payload struct {
				OrganizationID string          `json:"organization_id"`
				Model          json.RawMessage `json:"model"`
			}
			decodeBytes(t, backend.singleCall(t).Body, &payload)
			if payload.OrganizationID != "org-1" || string(payload.Model) != model {
				t.Fatalf("model or trusted scope changed: %+v", payload)
			}
			if strings.Contains(result.Body.String(), "test-native-secret") {
				t.Fatal("credential projected to browser")
			}
		}
	}
}

func TestNativeModelInputRequiresAdministrator(t *testing.T) {
	for _, route := range []struct{ method, path string }{
		{http.MethodGet, "/api/admin/model-catalog"},
		{http.MethodGet, "/api/admin/provider-connections"},
		{http.MethodPost, "/api/admin/provider-connections"},
		{http.MethodGet, "/api/admin/provider-connections/connection-1"},
		{http.MethodPost, "/api/admin/provider-connections/connection-1/credentials"},
		{http.MethodGet, "/api/admin/model-profiles"},
		{http.MethodGet, "/api/admin/model-profiles/model-1"},
		{http.MethodGet, "/api/admin/model-profile-revisions/revision-1"},
		{http.MethodPost, "/api/admin/model-profiles"},
		{http.MethodPost, "/api/admin/model-profiles/model-1/revisions"},
	} {
		t.Run(route.method+route.path, func(t *testing.T) {
			backend := newBackendStub()
			request := httptest.NewRequest(route.method, route.path, strings.NewReader(`{}`))
			request.Header.Set(principal.HeaderUserID, "member")
			request.Header.Set(principal.HeaderOrganizationID, "org-1")
			request.Header.Set(principal.HeaderMembershipID, "membership-1")
			request.Header.Set(principal.HeaderSystemRole, "user")
			request.Header.Set(principal.HeaderOrganizationRole, "member")
			response := httptest.NewRecorder()
			newTestHandler(t, backend).ServeHTTP(response, request)
			if response.Code != http.StatusForbidden || len(backend.calls) != 0 {
				t.Fatalf("non-admin forwarded: status=%d", response.Code)
			}
		})
	}
}
