package docker

import (
	"context"
	"encoding/json"
	"testing"

	"github.com/tf4fun/antnest-platform/services/runtime-controller/internal/deployment"
)

func TestManagedMCPIsOnlyInjectedIntoRuntimeBootstrapAndChangesPhysicalDigest(t *testing.T) {
	engine := newFakeEngine()
	driver := newTestDriver(t, engine)
	value := testDeployment()
	before, err := driver.DeploymentDigest(value)
	if err != nil {
		t.Fatal(err)
	}
	value.RuntimeSpec.MCPServers = deployment.CloneMCPServers([]deployment.MCPServer{{ID: "docs", Command: "node", Args: []string{"/skills/docs/server.js"}, Env: map[string]string{"TOKEN": "private-token"}}})
	after, err := driver.DeploymentDigest(value)
	if err != nil {
		t.Fatal(err)
	}
	if before == after {
		t.Fatal("MCP configuration absent from physical digest")
	}
	if result := driver.Create(context.Background(), value, after); result.State != deployment.EffectCompleted {
		t.Fatalf("create state=%s", result.State)
	}
	var injected deployment.RuntimeSpec
	if err := json.Unmarshal([]byte(engine.created.Environment["ANTNEST_RUNTIME_SPEC"]), &injected); err != nil {
		t.Fatal(err)
	}
	if len(injected.MCPServers) != 1 || injected.MCPServers[0].Env["TOKEN"] != "private-token" {
		t.Fatal("MCP bootstrap configuration lost")
	}
	if _, leaked := engine.created.Environment["TOKEN"]; leaked {
		t.Fatal("MCP environment applied to root Supervisor")
	}
	if !engine.created.Mounts["/skills"].ReadOnly || engine.created.Mounts["/workspace"].ReadOnly {
		t.Fatal("MCP altered workspace/Skill mount ownership")
	}
}
