package docker

import (
	"bytes"
	"context"
	"errors"
	"testing"

	"github.com/tf4fun/antnest-platform/services/runtime-controller/internal/deployment"
	"github.com/tf4fun/antnest-platform/services/runtime-controller/internal/instanceauth"
)

func seedLegacyRuntime(engine *scopedEngine, scope, agentID string) *Container {
	container := legacyContainer(agentID, 7, scope, testDigest, true)
	engine.containers[container.Name] = container
	engine.byID[container.ID] = container.Name
	return container
}

func TestOwnedRuntimeLookupFallsBackToOwnedLegacyOnly(t *testing.T) {
	engine := newScopedEngine("test-controller")
	own := seedLegacyRuntime(engine, "test-controller", "agent-1")
	seedLegacyRuntime(engine, "other-scope", "agent-2")

	found, err := ownedRuntimeContainer(context.Background(), engine, "test-controller", "agent-1")
	if err != nil || found.ID != own.ID || found.Name != containerName("agent-1") {
		t.Fatalf("owned legacy lookup: %+v err=%v", found, err)
	}
	found, err = ownedRuntimeContainer(context.Background(), engine, "test-controller", "agent-2")
	if !errors.Is(err, ErrNotFound) {
		t.Fatalf("foreign legacy was adopted by another scope: %+v err=%v", found, err)
	}
}

func TestResolverPrepareSeesOwnedLegacyRuntimeAndSkipsRewrite(t *testing.T) {
	engine := newScopedEngine("test-controller")
	seedLegacyRuntime(engine, "test-controller", "agent-1")
	writer, err := NewResolverVolumeWriter(engine, "preparer:local", "test-controller")
	if err != nil {
		t.Fatal(err)
	}
	err = writer.Prepare(context.Background(), deployment.Key{AgentID: "agent-1", Generation: 7}, "100.64.0.1")
	if err == nil {
		t.Fatal("live legacy receiver verification passed without mounts")
	}
	name := resolverVolumeName("test-controller", "agent-1", 7)
	if _, exists := engine.volumes[name]; exists {
		t.Fatal("a live matching legacy runtime still had its resolver volume rewritten")
	}
}

func TestResolverPrepareIgnoresForeignLegacyRuntime(t *testing.T) {
	engine := newScopedEngine("test-controller")
	seedLegacyRuntime(engine, "other-scope", "agent-1")
	writer, err := NewResolverVolumeWriter(engine, "preparer:local", "test-controller")
	if err != nil {
		t.Fatal(err)
	}
	_ = writer.Prepare(context.Background(), deployment.Key{AgentID: "agent-1", Generation: 7}, "100.64.0.1")
	name := resolverVolumeName("test-controller", "agent-1", 7)
	if _, exists := engine.volumes[name]; !exists {
		t.Fatal("a foreign legacy runtime blocked this scope's resolver volume")
	}
}

func TestResolverRemoveRefusesOwnedLegacyCompute(t *testing.T) {
	engine := newScopedEngine("test-controller")
	seedLegacyRuntime(engine, "test-controller", "agent-1")
	writer, err := NewResolverVolumeWriter(engine, "preparer:local", "test-controller")
	if err != nil {
		t.Fatal(err)
	}
	if err := writer.Remove(context.Background(), deployment.Key{AgentID: "agent-1", Generation: 7}); !errors.Is(err, ErrConflict) {
		t.Fatalf("owned legacy compute did not block resolver removal: %v", err)
	}
}

func TestInstancePrepareSeesOwnedLegacyRuntimeAndSkipsRewrite(t *testing.T) {
	engine := newScopedEngine("test-controller")
	seedLegacyRuntime(engine, "test-controller", "agent-1")
	id := instanceauth.Identity{Scope: "test-controller", AgentID: "agent-1", Generation: 7}
	issuer, err := instanceauth.New(bytes.Repeat([]byte{42}, 32))
	if err != nil {
		t.Fatal(err)
	}
	record, err := issuer.Issue(id)
	if err != nil {
		t.Fatal(err)
	}
	writer, err := NewInstanceVolumeWriter(engine, "preparer:local", issuer, "test-controller")
	if err != nil {
		t.Fatal(err)
	}
	err = writer.Prepare(context.Background(), deployment.Key{AgentID: "agent-1", Generation: 7}, record)
	if err == nil {
		t.Fatal("live legacy receiver verification passed without mounts")
	}
	if _, exists := engine.volumes[instanceVolumeName(id)]; exists {
		t.Fatal("a live matching legacy runtime still had its instance volume rewritten")
	}
}

func TestMCPPrepareSeesOwnedLegacyRuntimeAndSkipsRewrite(t *testing.T) {
	engine := newScopedEngine("test-controller")
	seedLegacyRuntime(engine, "test-controller", "agent-1")
	writer, err := NewMCPVolumeWriter(engine, "preparer:local", "test-controller", mcpResolverStub{})
	if err != nil {
		t.Fatal(err)
	}
	source := &deployment.MCPTemplateSource{OrganizationID: "org", TemplateID: "template", Revision: 1}
	servers := []deployment.MCPServer{{ID: "docs", Command: "node", SecretEnv: map[string]deployment.MCPSecretDescriptor{"API_KEY": {Set: true, Fingerprint: "hmac-sha256:0123456789abcdef0123456789abcdef"}}}}
	err = writer.Prepare(context.Background(), deployment.Key{AgentID: "agent-1", Generation: 7}, source, servers)
	if err == nil {
		t.Fatal("live legacy receiver verification passed without mounts")
	}
	if _, exists := engine.volumes[mcpVolumeName("test-controller", deployment.Key{AgentID: "agent-1", Generation: 7})]; exists {
		t.Fatal("a live matching legacy runtime still had its MCP volume rewritten")
	}
}
