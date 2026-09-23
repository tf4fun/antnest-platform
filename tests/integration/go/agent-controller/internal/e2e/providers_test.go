package e2e

import (
	"net/http"
	"strings"
	"testing"
)

func createTestProvider(t *testing.T, handler http.Handler, requestID, organizationID, endpoint, secret string) map[string]any {
	t.Helper()
	return serveJSON(t, handler, http.MethodPost, "/internal/provider-connections", mustJSON(t, map[string]any{
		"request_id": requestID, "organization_id": organizationID, "provider_key": "deepseek",
		"display_name": "DeepSeek", "base_url": endpoint,
		"credential": map[string]string{"method": "api_key", "api_key": secret}, "models": []any{},
	}), http.StatusCreated)
}

func assertProviderManagement(t *testing.T, handler http.Handler) {
	t.Helper()
	connection := createTestProvider(t, handler, "connection-http", "provider-org", "https://api.deepseek.com", "synthetic-original-key")
	id := connection["connection_id"].(string)
	path := "/internal/provider-connections/" + id
	for _, value := range []map[string]any{
		connection,
		serveJSON(t, handler, http.MethodGet, path+"?organization_id=provider-org", "", http.StatusOK),
		serveJSON(t, handler, http.MethodGet, "/internal/provider-connections?organization_id=provider-org", "", http.StatusOK),
	} {
		if strings.Contains(mustJSON(t, value), "synthetic-original-key") || strings.Contains(mustJSON(t, value), "ciphertext") {
			t.Fatal("Provider management echoed authentication material")
		}
	}
	serveJSON(t, handler, http.MethodGet, path+"?organization_id=other-org", "", http.StatusNotFound)
	rotation := map[string]any{
		"request_id": "rotation-http", "organization_id": "provider-org", "expected_version": connection["credential_version"],
		"credential": map[string]string{"method": "api_key", "api_key": "synthetic-rotated-key"},
	}
	rotated := serveJSON(t, handler, http.MethodPost, path+"/credentials", mustJSON(t, rotation), http.StatusCreated)
	if rotated["credential_version"] == connection["credential_version"] || rotated["credential_revision"] != 2.0 {
		t.Fatal("credential rotation did not advance its own revision")
	}
	replay := serveJSON(t, handler, http.MethodPost, path+"/credentials", mustJSON(t, rotation), http.StatusCreated)
	if mustJSON(t, replay) != mustJSON(t, rotated) {
		t.Fatal("credential rotation replay changed its result")
	}
	rotation["request_id"] = "stale-rotation-http"
	serveJSON(t, handler, http.MethodPost, path+"/credentials", mustJSON(t, rotation), http.StatusConflict)
	rotation["organization_id"] = "other-org"
	serveJSON(t, handler, http.MethodPost, path+"/credentials", mustJSON(t, rotation), http.StatusNotFound)
	rotation["organization_id"], rotation["expected_version"] = "provider-org", rotated["credential_version"]
	rotation["credential"] = map[string]string{"method": "oauth", "api_key": "unsupported"}
	serveJSON(t, handler, http.MethodPost, path+"/credentials", mustJSON(t, rotation), http.StatusBadRequest)
}
