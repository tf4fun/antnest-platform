package e2e

import (
	"net/http"
	"testing"
)

func assertCredentialRotationDuringRun(t *testing.T, handler http.Handler, admission, credential map[string]any) {
	t.Helper()
	provider := credential["provider"].(map[string]any)
	connectionID := provider["connection_id"].(string)
	rotated := serveJSON(t, handler, http.MethodPost, "/internal/provider-connections/"+connectionID+"/credentials", mustJSON(t, map[string]any{
		"request_id": "active-run-rotation", "organization_id": "agent-e2e-org",
		"expected_version": credential["credential_version"],
		"credential":       map[string]any{"method": "api_key", "api_key": "synthetic-rotated-run-key"},
	}), http.StatusCreated)
	resolve := map[string]any{"request_id": "rotated-run-resolve", "admission_id": admission["admission_id"], "provider_connection_id": connectionID}
	result := serveJSON(t, handler, http.MethodPost, "/rpc/agent-controller/resolve-credential", mustJSON(t, resolve), http.StatusOK)
	if result["credential_version"] != rotated["credential_version"] || result["credential_version"] == credential["credential_version"] || result["secret"] != "synthetic-rotated-run-key" {
		t.Fatal("active admission did not resolve the newly rotated credential")
	}
	if mustJSON(t, result["provider"]) != mustJSON(t, provider) {
		t.Fatal("rotation changed provider binding")
	}
	if _, exists := admission["credential_version"]; exists {
		t.Fatal("admission pins a credential version")
	}
	resolve["provider_connection_id"] = "foreign-connection"
	serveJSON(t, handler, http.MethodPost, "/rpc/agent-controller/resolve-credential", mustJSON(t, resolve), http.StatusForbidden)
}
