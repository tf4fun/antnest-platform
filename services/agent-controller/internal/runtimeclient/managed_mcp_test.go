package runtimeclient

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"reflect"
	"testing"
	"time"

	"github.com/tf4fun/antnest-platform/services/agent-controller/internal/domain"
)

func TestManagedMCPDeploymentWireContract(t *testing.T) {
	t.Parallel()
	configuration := runtimeConfiguration()
	configuration.MCPServers = []domain.MCPServer{{ID: "documents", Command: "node", Args: []string{"server.js"}, Env: map[string]string{"TOKEN": "synthetic-token"}}}
	for _, action := range []string{"initialize", "update", "enable"} {
		t.Run(action, func(t *testing.T) {
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				var payload struct {
					Configuration struct {
						Servers []domain.MCPServer `json:"mcp_servers"`
					} `json:"configuration"`
				}
				if err := json.NewDecoder(r.Body).Decode(&payload); err != nil {
					t.Error(err)
				}
				if !reflect.DeepEqual(payload.Configuration.Servers, configuration.MCPServers) {
					t.Error("managed MCP configuration lost at HTTP boundary")
				}
				w.WriteHeader(http.StatusAccepted)
				if err := json.NewEncoder(w).Encode(map[string]string{
					"request_id": "request", "agent_id": "agent", "kind": action + "_runtime", "target_revision": "rtv_11111111111111111111111111111111", "state": "running", "effect": "unknown",
				}); err != nil {
					t.Error(err)
				}
			}))
			t.Cleanup(server.Close)
			client, err := New(server.URL, time.Second, server.Client())
			if err != nil {
				t.Fatal(err)
			}
			switch action {
			case "initialize":
				_, err = client.InitializeRuntime(context.Background(), "request", "agent", configuration)
			case "update":
				_, err = client.UpdateRuntime(context.Background(), "request", "agent", "rtv_11111111111111111111111111111111", configuration)
			case "enable":
				_, err = client.EnableRuntime(context.Background(), "request", "agent", "rtv_11111111111111111111111111111111", configuration)
			}
			if err != nil {
				t.Fatal(err)
			}
		})
	}
}
