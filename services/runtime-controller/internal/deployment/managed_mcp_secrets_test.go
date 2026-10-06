package deployment

import (
	"bytes"
	"encoding/json"
	"testing"
)

func TestManagedMCPConfigurationPinsSecretDescriptors(t *testing.T) {
	var servers []MCPServer
	input := []byte(`[{"id":"docs","command":"node","secret_env":{"API_KEY":{"set":true,"fingerprint":"hmac-sha256:0123456789abcdef0123456789abcdef"}}}]`)
	decoder := json.NewDecoder(bytes.NewReader(input))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&servers); err != nil {
		t.Fatal("frozen secret descriptor rejected", err)
	}
	if err := validateMCPServers(servers); err != nil {
		t.Fatal(err)
	}
	encoded, err := json.Marshal(CloneMCPServers(servers))
	if err != nil || !bytes.Contains(encoded, []byte(`"fingerprint":"hmac-sha256:0123456789abcdef0123456789abcdef"`)) {
		t.Fatal("secret identity lost", err)
	}
	for _, input := range []string{`[{"id":"docs","command":"node","secret_env":{"API_KEY":{"value":"private-canary"}}}]`, `[{"id":"docs","command":"node","secret_env":{"API_KEY":{"keep":true}}}]`} {
		var decoded []MCPServer
		decoder := json.NewDecoder(bytes.NewBufferString(input))
		decoder.DisallowUnknownFields()
		if err := decoder.Decode(&decoded); err == nil && validateMCPServers(decoded) == nil {
			t.Fatal("inline value or keep accepted by RC")
		}
	}
}

func TestResolvedDeploymentOwnsFrozenMCPSource(t *testing.T) {
	configuration := testConfiguration()
	configuration.ManagedMCPTemplate = &MCPTemplateSource{OrganizationID: "org", TemplateID: "template", Revision: 1}
	configuration.MCPServers = []MCPServer{{ID: "docs", Command: "node", SecretEnv: map[string]MCPSecretDescriptor{"API_KEY": {Set: true, Fingerprint: "hmac-sha256:0123456789abcdef0123456789abcdef"}}}}
	value, err := configuration.Resolve("agent-1", 1)
	if err != nil {
		t.Fatal(err)
	}
	configuration.ManagedMCPTemplate.Revision = 2
	if value.ManagedMCPTemplate.Revision != 1 {
		t.Fatal("resolved deployment shares mutable source")
	}
}

func TestManagedMCPBootstrapTreatsFingerprintsAsControllerAuthenticatedOpaqueIDs(t *testing.T) {
	servers := []MCPServer{{ID: "docs", Command: "node", SecretEnv: map[string]MCPSecretDescriptor{"API_KEY": {Set: true, Fingerprint: "hmac-sha256:0123456789abcdef0123456789abcdef"}}}}
	if err := validateMCPServers(servers); err != nil {
		t.Fatal(err)
	}
	if err := ValidateMCPSecretValues(servers, map[string]map[string]string{"docs": {"API_KEY": "low-entropy-value"}}); err != nil {
		t.Fatal("RC incorrectly tried to derive Controller HMAC", err)
	}
	for _, name := range []string{"TMPDIR", "TMP", "TEMP", "XDG_CACHE_HOME", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_STATE_HOME", "XDG_RUNTIME_DIR"} {
		server := MCPServer{ID: "docs", Command: "node", Env: map[string]string{name: "/workspace"}}
		if validateMCPServers([]MCPServer{server}) == nil {
			t.Fatal("private cache override admitted", name)
		}
	}
}
