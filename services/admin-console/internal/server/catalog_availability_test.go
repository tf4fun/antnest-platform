package server

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/stretchr/testify/require"
	"soft/antnest-platform/services/admin-console/internal/principal"
	"soft/antnest-platform/services/admin-console/internal/upstream"
)

func TestCatalogAvailabilityUsesOneScopedControllerCommand(t *testing.T) {
	for _, resource := range []struct{ browser, upstream string }{
		{"provider-connections", "provider-connections"}, {"model-profiles", "model-profiles"}, {"templates", "agent-templates"},
	} {
		for _, body := range []string{`{"expected_enabled":true,"enabled":false}`, `{"expected_enabled":false,"enabled":true}`, `{"expected_enabled":true,"enabled":true}`, `{"expected_enabled":false,"enabled":false}`} {
			backend := newBackendStub()
			var input map[string]bool
			require.NoError(t, json.Unmarshal([]byte(body), &input))
			result, err := json.Marshal(map[string]any{"resource_id": "item-1", "enabled": input["enabled"], "updated_at": "2026-09-14T10:00:00Z", "private_metadata": "omit"})
			require.NoError(t, err)
			h := newTestHandler(t, backend)
			for range 2 {
				backend.enqueue(200, string(result))
				response := requestCatalog(t, h, "/api/admin/"+resource.browser+"/item-1/availability", body, nil)
				require.Equal(t, 200, response.Code, response.Body.String())
				require.Equal(t, "no-store", response.Header().Get("Cache-Control"))
				require.NotContains(t, response.Body.String(), "private_metadata")
			}
			require.Len(t, backend.calls, 2)
			call := backend.calls[0]
			require.Equal(t, upstream.AgentController, call.Target)
			require.Equal(t, http.MethodPut, call.Method)
			require.Equal(t, "/internal/"+resource.upstream+"/item-1/availability", call.Path)
			require.Empty(t, call.Query)
			require.Equal(t, call.Body, backend.calls[1].Body)
			var payload map[string]any
			require.NoError(t, json.Unmarshal(call.Body, &payload))
			require.Len(t, payload, 4)
			require.Equal(t, "org-1", payload["organization_id"])
			require.NotEmpty(t, payload["request_id"])
			require.Equal(t, input["expected_enabled"], payload["expected_enabled"])
			require.Equal(t, input["enabled"], payload["enabled"])
		}
	}
}

func TestCatalogAvailabilityRejectsMissingFlagsAndInjectedScope(t *testing.T) {
	for _, resource := range []string{"provider-connections", "model-profiles", "templates"} {
		for _, body := range []string{`{}`, `{"enabled":false}`, `{"expected_enabled":true}`, `{"expected_enabled":null,"enabled":false}`, `{"expected_enabled":true,"enabled":null}`, `{"expected_enabled":true,"enabled":"false"}`, `{"expected_enabled":true,"enabled":false,"organization_id":"other"}`} {
			backend := newBackendStub()
			response := requestCatalog(t, newTestHandler(t, backend), "/api/admin/"+resource+"/item/availability", body, nil)
			require.Equal(t, 400, response.Code, response.Body.String())
			require.Contains(t, response.Body.String(), `"code":"invalid_request"`)
			require.Empty(t, backend.calls)
		}
		backend := newBackendStub()
		response := requestCatalog(t, newTestHandler(t, backend), "/api/admin/"+resource+"/item/availability?organization_id=other", `{"expected_enabled":true,"enabled":false}`, nil)
		require.Equal(t, 400, response.Code)
		require.Empty(t, backend.calls)
	}
}

func TestCatalogAvailabilityPreservesReferenceConflictAndDoesNotRetry(t *testing.T) {
	body := `{"code":"resource_in_use","message":"Resource is referenced","retryable":false,"references":[{"kind":"template","resource_id":"template-1"},{"kind":"agent","resource_id":"agent-1","agent_id":"agent-1"},{"kind":"lifecycle_operation","resource_id":"operation-1","agent_id":"agent-2","operation_id":"operation-1"}],"references_truncated":true}`
	backend := newBackendStub()
	backend.enqueue(409, body)
	response := requestCatalog(t, newTestHandler(t, backend), "/api/admin/provider-connections/item/availability", `{"expected_enabled":true,"enabled":false}`, nil)
	require.Equal(t, 409, response.Code)
	require.JSONEq(t, body, response.Body.String())
	require.Len(t, backend.calls, 1)
}

func TestCatalogAvailabilityRejectsIncompleteOrMismatchedReceipt(t *testing.T) {
	for _, body := range []string{`{}`, `{"resource_id":"item","updated_at":"2026-09-14T10:00:00Z"}`, `{"resource_id":"item","enabled":null,"updated_at":"2026-09-14T10:00:00Z"}`, `{"resource_id":"other","enabled":false,"updated_at":"2026-09-14T10:00:00Z"}`, `{"resource_id":"item","enabled":true,"updated_at":"2026-09-14T10:00:00Z"}`} {
		backend := newBackendStub()
		backend.enqueue(200, body)
		response := requestCatalog(t, newTestHandler(t, backend), "/api/admin/templates/item/availability", `{"expected_enabled":true,"enabled":false}`, nil)
		require.Equal(t, 502, response.Code, response.Body.String())
	}
}

func TestCatalogAvailabilityPreservesOwnerFailures(t *testing.T) {
	for _, resource := range []string{"provider-connections", "model-profiles", "templates"} {
		for _, status := range []int{404, 409, 500, 503} {
			backend := newBackendStub()
			body := `{"code":"owner_failure","message":"Owner rejected command","retryable":false}`
			backend.enqueue(status, body)
			response := requestCatalog(t, newTestHandler(t, backend), "/api/admin/"+resource+"/item/availability", `{"expected_enabled":true,"enabled":false}`, nil)
			require.Equal(t, status, response.Code)
			require.JSONEq(t, body, response.Body.String())
			require.Len(t, backend.calls, 1)
		}
	}
}

func TestCatalogAvailabilityValidatesTimestampWithoutReplacingHistoricalReceipt(t *testing.T) {
	for _, timestamp := range []string{`null`, `"0001-01-01T00:00:00Z"`, `"invalid"`, `"2026-09-14T10:00:00Z"`} {
		backend := newBackendStub()
		body := `{"resource_id":"item","enabled":false,"updated_at":` + timestamp + `}`
		backend.enqueue(200, body)
		response := requestCatalog(t, newTestHandler(t, backend), "/api/admin/templates/item/availability", `{"expected_enabled":true,"enabled":false}`, nil)
		if timestamp == `"2026-09-14T10:00:00Z"` {
			require.Equal(t, 200, response.Code)
			require.JSONEq(t, body, response.Body.String())
		} else {
			require.Equal(t, 502, response.Code, response.Body.String())
		}
		require.Len(t, backend.calls, 1)
	}
}

func requestCatalog(t *testing.T, h http.Handler, path, body string, mutate func(*http.Request)) *httptest.ResponseRecorder {
	t.Helper()
	return requestAdmin(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		r.Header.Set("Idempotency-Key", "catalog-availability-test-0001")
		if mutate != nil {
			mutate(r)
		}
		h.ServeHTTP(w, r)
	}), http.MethodPut, path, body)
}

func TestCatalogAvailabilityRejectsInvalidIdentityAndKey(t *testing.T) {
	for _, tc := range []struct {
		name   string
		status int
		mutate func(*http.Request)
	}{
		{"missing identity", 401, func(r *http.Request) { r.Header.Del(principal.HeaderUserID) }},
		{"member", 403, func(r *http.Request) {
			r.Header.Set(principal.HeaderSystemRole, "user")
			r.Header.Set(principal.HeaderOrganizationRole, "member")
		}},
		{"missing key", 400, func(r *http.Request) { r.Header.Del("Idempotency-Key") }},
		{"short key", 400, func(r *http.Request) { r.Header.Set("Idempotency-Key", "short") }},
	} {
		t.Run(tc.name, func(t *testing.T) {
			backend := newBackendStub()
			response := requestCatalog(t, newTestHandler(t, backend), "/api/admin/templates/item/availability", `{"expected_enabled":true,"enabled":false}`, tc.mutate)
			require.Equal(t, tc.status, response.Code, response.Body.String())
			require.Empty(t, backend.calls)
		})
	}
}

func TestCatalogAvailabilityOnlyOrganizationAndKeyDetermineRequestIdentity(t *testing.T) {
	var ids []string
	for _, tc := range []struct{ org, key, resource, body string }{
		{"org-1", "catalog-key-0000001", "templates", `{"expected_enabled":true,"enabled":false}`},
		{"org-1", "catalog-key-0000001", "model-profiles", `{"expected_enabled":false,"enabled":true}`},
		{"org-2", "catalog-key-0000001", "templates", `{"expected_enabled":true,"enabled":false}`},
		{"org-1", "catalog-key-0000002", "templates", `{"expected_enabled":true,"enabled":false}`},
	} {
		backend := newBackendStub()
		backend.enqueue(409, `{"code":"request_id_conflict","message":"Changed command"}`)
		response := requestCatalog(t, newTestHandler(t, backend), "/api/admin/"+tc.resource+"/item/availability", tc.body, func(r *http.Request) {
			r.Header.Set(principal.HeaderOrganizationID, tc.org)
			r.Header.Set("Idempotency-Key", tc.key)
		})
		require.Equal(t, 409, response.Code)
		require.Len(t, backend.calls, 1)
		var body map[string]any
		require.NoError(t, json.Unmarshal(backend.calls[0].Body, &body))
		ids = append(ids, body["request_id"].(string))
	}
	require.Equal(t, ids[0], ids[1])
	require.NotEqual(t, ids[0], ids[2])
	require.NotEqual(t, ids[0], ids[3])
}
