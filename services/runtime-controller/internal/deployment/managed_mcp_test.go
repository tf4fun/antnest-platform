package deployment

import (
	"encoding/json"
	"fmt"
	"reflect"
	"strings"
	"testing"
)

func managedConfiguration(t *testing.T, servers string) Configuration {
	t.Helper()
	base := testDeployment()
	input := map[string]any{"image_ref": base.ImageRef, "network": base.RuntimeSpec.Network,
		"resources": base.Resources, "mcp_servers": json.RawMessage(servers)}
	payload, err := json.Marshal(input)
	if err != nil {
		t.Fatal(err)
	}
	var result Configuration
	if err := json.Unmarshal(payload, &result); err != nil {
		t.Fatal(err)
	}
	return result
}

func TestManagedMCPConfigurationReachesRuntimeSpec(t *testing.T) {
	servers := `[{"id":"docs","command":"node","args":["/skills/docs/server.js"],"env":{"TOKEN":"test-only-canary"}}]`
	configuration := managedConfiguration(t, servers)
	resolved, err := configuration.Resolve("agent-1", 7)
	if err != nil {
		t.Fatal(err)
	}
	payload, err := json.Marshal(resolved.RuntimeSpec)
	if err != nil {
		t.Fatal(err)
	}
	var wire map[string]any
	var want any
	if err := json.Unmarshal(payload, &wire); err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal([]byte(servers), &want); err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(wire["mcp_servers"], want) {
		t.Fatal("managed MCP configuration was changed or dropped")
	}
	before, err := DigestValue(resolved)
	if err != nil {
		t.Fatal(err)
	}
	changed, err := managedConfiguration(t, strings.ReplaceAll(servers, "test-only-canary", "new-value")).Resolve("agent-1", 7)
	if err != nil {
		t.Fatal(err)
	}
	after, err := DigestValue(changed)
	if err != nil {
		t.Fatal(err)
	}
	if before == after {
		t.Fatal("managed configuration is absent from deployment digest")
	}
	configuration.MCPServers[0].Env["TOKEN"] = "mutated"
	if resolved.RuntimeSpec.MCPServers[0].Env["TOKEN"] != "test-only-canary" {
		t.Fatal("resolved input aliases caller-owned environment")
	}
	for _, format := range []string{"%v", "%+v", "%#v"} {
		if strings.Contains(fmt.Sprintf(format, resolved.RuntimeSpec.MCPServers), "test-only-canary") {
			t.Fatal("debug formatting leaked MCP environment")
		}
	}
}

func TestManagedMCPConfigurationEnforcesAggregateBounds(t *testing.T) {
	servers := make([]MCPServer, 9)
	for index := range servers {
		servers[index] = MCPServer{ID: fmt.Sprintf("server-%d", index), Command: "node"}
	}
	if err := validateMCPServers(servers[:8]); err != nil {
		t.Fatal(err)
	}
	if err := validateMCPServers(servers); err == nil {
		t.Fatal("too many servers accepted")
	}
	for index := range servers {
		servers[index].Env = map[string]string{"TOKEN": strings.Repeat("a", 8192)}
	}
	if err := validateMCPServers(servers[:8]); err == nil {
		t.Fatal("oversized bootstrap accepted")
	}
	server := MCPServer{ID: "docs", Command: "node", Args: make([]string, 5)}
	for index := range server.Args {
		server.Args[index] = strings.Repeat("a", 8192)
	}
	if err := validateMCPServers([]MCPServer{server}); err == nil {
		t.Fatal("oversized server accepted")
	}
}

func TestManagedMCPConfigurationRejectsInvalidBootstrap(t *testing.T) {
	for _, servers := range []string{
		`[{"id":"docs","command":"node"},{"id":"docs","command":"python"}]`,
		`[{"id":"../docs","command":"node"}]`,
		`[{"id":"docs","command":""}]`,
		`[{"id":"docs","command":"node","args":["\u0000"]}]`,
		`[{"id":"docs","command":"node","env":{"HOME":"/root"}}]`,
		`[{"id":"docs","command":"node","env":{"ANTNEST_RUNTIME_SPEC":"canary"}}]`,
		`[{"id":"docs","command":"node","env":{"1TOKEN":"canary"}}]`,
		`[{"id":"docs","command":"node","args":["` + strings.Repeat("a", 8193) + `"]}]`,
	} {
		if err := managedConfiguration(t, servers).Validate(); err == nil {
			t.Fatal("invalid managed MCP input accepted")
		}
	}
	if err := managedConfiguration(t, `[]`).Validate(); err != nil {
		t.Fatal(err)
	}
	if err := managedConfiguration(t, `[{"id":"docs","command":"python"}]`).Validate(); err != nil {
		t.Fatal(err)
	}
}
