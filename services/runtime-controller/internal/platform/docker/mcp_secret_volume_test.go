package docker

import (
	"archive/tar"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"testing"

	"github.com/tf4fun/antnest-platform/services/runtime-controller/internal/deployment"
)

type mcpResolverStub struct{}

func (mcpResolverStub) Resolve(context.Context, *deployment.MCPTemplateSource, []deployment.MCPServer) (map[string]map[string]string, error) {
	return map[string]map[string]string{"docs": {"API_KEY": "mcp-private-canary"}}, nil
}

func mcpSecretArchive(t *testing.T, data []byte, mode int64) []byte {
	t.Helper()
	var body bytes.Buffer
	writer := tar.NewWriter(&body)
	for _, header := range []*tar.Header{{Name: "antnest-mcp/", Typeflag: tar.TypeDir, Mode: 0700}, {Name: "antnest-mcp/secrets.json", Typeflag: tar.TypeReg, Mode: mode, Size: int64(len(data))}} {
		if err := writer.WriteHeader(header); err != nil {
			t.Fatal(err)
		}
		if header.Typeflag == tar.TypeReg {
			if _, err := writer.Write(data); err != nil {
				t.Fatal(err)
			}
		}
	}
	if err := writer.Close(); err != nil {
		t.Fatal(err)
	}
	return body.Bytes()
}

func TestManagedMCPMountChecksPermissionsContentAndActualVolume(t *testing.T) {
	key := deployment.Key{AgentID: "agent-1", Generation: 7}
	source := &deployment.MCPTemplateSource{OrganizationID: "org", TemplateID: "template", Revision: 1}
	servers := []deployment.MCPServer{{ID: "docs", Command: "node", SecretEnv: map[string]deployment.MCPSecretDescriptor{"API_KEY": {Set: true, Fingerprint: "hmac-sha256:0123456789abcdef0123456789abcdef"}}}}
	data := []byte(`{"docs":{"API_KEY":"mcp-private-canary"}}`)
	engine := &instanceArchiveEngine{fakeEngine: newFakeEngine(), archive: mcpSecretArchive(t, data, 0400)}
	writer, err := NewMCPVolumeWriter(engine, "preparer:local", "test-controller", mcpResolverStub{})
	if err != nil {
		t.Fatal(err)
	}
	name := mcpVolumeName(writer.scope, key)
	labels := mcpVolumeLabels(writer.scope, key, source, servers)
	engine.volumes[name] = Volume{Name: name, Labels: labels}
	engine.container = exactContainer()
	engine.container.Mounts = []ObservedMount{{Type: "volume", Name: name, Destination: mcpSecretDirectory, ReadWrite: false, NoCopy: true}}
	if err := writer.VerifyRuntimeMount(t.Context(), key, source, servers, engine.container.ID); err != nil {
		t.Fatal(err)
	}
	engine.volumes[name] = Volume{Name: name, Labels: map[string]string{}}
	if err := writer.VerifyRuntimeMount(t.Context(), key, source, servers, engine.container.ID); err == nil {
		t.Fatal("Docker-created empty replacement admitted")
	}
	engine.volumes[name] = Volume{Name: name, Labels: labels}
	engine.archive = mcpSecretArchive(t, data, 0644)
	if err := writer.VerifyRuntimeMount(t.Context(), key, source, servers, engine.container.ID); err == nil {
		t.Fatal("world-readable secret file admitted")
	}
	engine.archive = mcpSecretArchive(t, []byte(`{"docs":{"OTHER":"different"}}`), 0400)
	if err := writer.VerifyRuntimeMount(t.Context(), key, source, servers, engine.container.ID); err == nil {
		t.Fatal("wrong secret names admitted")
	}
	engine.archive = mcpSecretArchive(t, data, 0400)
	engine.container.Mounts[0].ReadWrite = true
	if err := writer.VerifyRuntimeMount(t.Context(), key, source, servers, engine.container.ID); err == nil {
		t.Fatal("writable bootstrap mount admitted")
	}
}

type rejectingMCPGate struct{}

func (rejectingMCPGate) Prepare(context.Context, deployment.Key, *deployment.MCPTemplateSource, []deployment.MCPServer) error {
	return nil
}
func (rejectingMCPGate) VerifyRuntimeMount(context.Context, deployment.Key, *deployment.MCPTemplateSource, []deployment.MCPServer, string) error {
	return errors.New("actual MCP mount differs")
}
func (rejectingMCPGate) Remove(context.Context, deployment.Key) error { return nil }

func TestRuntimeNeverStartsBeforeManagedMCPMountAdmission(t *testing.T) {
	engine := newFakeEngine()
	engine.createMaterializes = true
	driver := newTestDriver(t, engine)
	driver.config.MCPMountGate = rejectingMCPGate{}
	value := testDeployment()
	value.ManagedMCPTemplate = &deployment.MCPTemplateSource{OrganizationID: "org", TemplateID: "template", Revision: 1}
	value.RuntimeSpec.MCPServers = []deployment.MCPServer{{ID: "docs", Command: "node", SecretEnv: map[string]deployment.MCPSecretDescriptor{"API_KEY": {Set: true, Fingerprint: "hmac-sha256:0123456789abcdef0123456789abcdef"}}}}
	digest, err := driver.DeploymentDigest(value)
	if err != nil {
		t.Fatal(err)
	}
	outcome := driver.Create(t.Context(), value, digest)
	if outcome.State != deployment.EffectUnknown || engine.startCalls != 0 {
		t.Fatalf("failed mount started Runtime: %+v", outcome)
	}
}

func TestManagedSecretDeploymentDigestPinsTemplateRevision(t *testing.T) {
	driver := newTestDriver(t, newFakeEngine())
	value := testDeployment()
	value.ManagedMCPTemplate = &deployment.MCPTemplateSource{OrganizationID: "org", TemplateID: "template", Revision: 1}
	value.RuntimeSpec.MCPServers = []deployment.MCPServer{{ID: "docs", Command: "node", SecretEnv: map[string]deployment.MCPSecretDescriptor{"API_KEY": {Set: true, Fingerprint: "hmac-sha256:0123456789abcdef0123456789abcdef"}}}}
	first, err := driver.DeploymentDigest(value)
	if err != nil {
		t.Fatal(err)
	}
	value.ManagedMCPTemplate.Revision = 2
	second, err := driver.DeploymentDigest(value)
	if err != nil || first == second {
		t.Fatal("deployment digest ignored frozen source", err)
	}
	spec, err := driver.containerSpec(value, second)
	if err != nil {
		t.Fatal(err)
	}
	encoded, err := json.Marshal(spec.Environment)
	if err != nil || bytes.Contains(encoded, []byte(`"value"`)) {
		t.Fatal("secret writes entered Docker environment")
	}
	mount, ok := spec.Mounts[mcpSecretDirectory]
	if !ok || !mount.ReadOnly || !mount.NoCopy {
		t.Fatal("private bootstrap mount not isolated")
	}
}
