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
	require.Equal(t, 44, contract.Version)
	require.Equal(t, []string{"list_execution_audits", "get_execution_audit", "list_execution_events"}, contract.Dependencies["agent_acp"])
	require.Contains(t, contract.Dependencies["agent_controller"], "execution_synchronization")
	require.Contains(t, contract.Dependencies["agent_controller"], "catalog_availability")
	boundary, ok := newTestHandler(t, newBackendStub()).(*handler)
	require.True(t, ok)
	for _, name := range []string{"list_execution_audits", "get_execution_audit", "list_execution_events", "get_execution_synchronization", "set_provider_availability", "set_model_availability", "set_template_availability"} {
		route, exists := contract.Routes[name]
		require.True(t, exists, name)
		request := httptest.NewRequest(route.Method, contract.BasePath+route.Path, nil)
		_, registered := boundary.mux.Handler(request)
		require.Equal(t, route.Method+" "+contract.BasePath+route.Path, registered)
	}
}
