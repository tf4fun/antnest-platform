package server

import (
	"encoding/json"
	"net/http/httptest"
	"os"
	"path/filepath"
	"runtime"
	"testing"

	"github.com/stretchr/testify/require"
)

func TestAdminContractRegistersAuditAndSynchronizationReads(t *testing.T) {
	t.Parallel()
	_, file, _, ok := runtime.Caller(0)
	require.True(t, ok)
	body, err := os.ReadFile(filepath.Join(filepath.Dir(file), "../../../../contracts/admin-console/admin-contract.json"))
	require.NoError(t, err)
	var contract struct {
		Version  int    `json:"version"`
		BasePath string `json:"base_path"`
		Routes   map[string]struct {
			Method string `json:"method"`
			Path   string `json:"path"`
		} `json:"routes"`
		Dependencies map[string][]string `json:"dependencies"`
	}
	require.NoError(t, json.Unmarshal(body, &contract))
	require.Equal(t, 50, contract.Version)
	require.Equal(t, []string{"list_execution_audits", "get_execution_audit", "list_execution_events"}, contract.Dependencies["agent_acp"])
	require.Contains(t, contract.Dependencies["agent_controller"], "execution_synchronization")
	require.Contains(t, contract.Dependencies["agent_controller"], "catalog_availability")
	require.Contains(t, contract.Dependencies["agent_controller"], "agent_skill_preparation")
	require.Equal(t, []string{"search_skill_sources", "preview_skill_source", "promote_skill_source", "list_skills", "publish_skill", "list_skill_versions", "publish_skill_version", "download_skill_version"}, contract.Dependencies["skill_registry"])
	boundary, ok := newTestHandler(t, newBackendStub()).(*businessFixture)
	require.True(t, ok)
	for _, name := range []string{"list_execution_audits", "get_execution_audit", "list_execution_events", "get_execution_synchronization", "get_agent_skill_preparation", "get_agent_skill_preparation_by_key", "set_provider_availability", "set_model_availability", "set_template_availability", "discover_provider_models", "discover_draft_models"} {
		route, exists := contract.Routes[name]
		require.True(t, exists, name)
		request := httptest.NewRequest(route.Method, contract.BasePath+route.Path, nil)
		_, registered := boundary.mux.Handler(request)
		require.Equal(t, route.Method+" "+contract.BasePath+route.Path, registered)
	}
	for _, name := range contract.Dependencies["skill_registry"] {
		route := contract.Routes[name]
		request := httptest.NewRequest(route.Method, contract.BasePath+route.Path, nil)
		_, registered := boundary.mux.Handler(request)
		require.Equal(t, route.Method+" "+contract.BasePath+route.Path, registered)
	}
}
