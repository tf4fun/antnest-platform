package domain

import (
	"encoding/json"
	"fmt"
	"strings"
	"testing"
)

func TestManagedMCPConfigurationIsFrozenInRevisionAndAgentSpec(t *testing.T) {
	t.Parallel()
	input := managedTemplateInput()
	revision, err := NewTemplateRevision(input)
	if err != nil {
		t.Fatal(err)
	}
	model, err := NewModelProfileRevision(ModelProfileRevisionInput{
		ID: "model-rev", ModelProfileID: "model", OrganizationID: "org", Revision: 1,
		Model: validModel(), CredentialRef: "credential", CredentialVersion: "version",
	})
	if err != nil {
		t.Fatal(err)
	}
	spec, err := MaterializeAgentSpec(revision, model)
	if err != nil {
		t.Fatal(err)
	}
	digest, err := spec.Digest()
	if err != nil {
		t.Fatal(err)
	}
	input.Runtime.MCPServers[0].Env["TOKEN"] = "changed"
	input.Runtime.MCPServers[0].Args[0] = "changed"
	copyOfRevision := revision.Snapshot()
	copyOfRevision.Runtime.MCPServers[0].Env["TOKEN"] = "snapshot mutation"
	copyOfSpec := spec.Snapshot()
	copyOfSpec.Runtime.MCPServers[0].Args[0] = "snapshot mutation"
	for _, runtime := range []RuntimeSpecInput{revision.Snapshot().Runtime, spec.Snapshot().Runtime} {
		if runtime.MCPServers[0].Env["TOKEN"] != "synthetic-token" || runtime.MCPServers[0].Args[0] != "server.js" {
			t.Fatal("MCP configuration escaped immutable snapshot ownership")
		}
	}
	modified, err := NewTemplateRevision(input)
	if err != nil {
		t.Fatal(err)
	}
	modifiedSpec, err := MaterializeAgentSpec(modified, model)
	if err != nil {
		t.Fatal(err)
	}
	modifiedDigest, err := modifiedSpec.Digest()
	if err != nil || modifiedDigest == digest {
		t.Fatalf("MCP change missing from digest: %v", err)
	}
	text := fmt.Sprintf("%+v %#v", spec.Snapshot().Runtime, revision.Snapshot().Runtime)
	if strings.Contains(text, "synthetic-token") || strings.Contains(text, "server.js") {
		t.Fatal("diagnostic formatting exposes process configuration")
	}
}

func TestManagedMCPConfigurationValidation(t *testing.T) {
	t.Parallel()
	tests := []struct {
		name   string
		mutate func(*RuntimeSpecInput)
	}{
		{"duplicate", func(r *RuntimeSpecInput) { r.MCPServers = append(r.MCPServers, r.MCPServers[0]) }},
		{"invalid ID", func(r *RuntimeSpecInput) { r.MCPServers[0].ID = "Documents" }},
		{"blank command", func(r *RuntimeSpecInput) { r.MCPServers[0].Command = " " }},
		{"reserved env", func(r *RuntimeSpecInput) { r.MCPServers[0].Env["ANTNEST_RUNTIME_SPEC"] = "override" }},
		{"HOME", func(r *RuntimeSpecInput) { r.MCPServers[0].Env["HOME"] = "/root" }},
		{"NUL", func(r *RuntimeSpecInput) { r.MCPServers[0].Args = []string{"a\x00b"} }},
		{"invalid UTF8", func(r *RuntimeSpecInput) { r.MCPServers[0].Command = string([]byte{255}) }},
		{"too many arguments", func(r *RuntimeSpecInput) { r.MCPServers[0].Args = make([]string, 65) }},
		{"server size", func(r *RuntimeSpecInput) {
			r.MCPServers[0].Args = []string{strings.Repeat("x", 8192), strings.Repeat("x", 8192), strings.Repeat("x", 8192), strings.Repeat("x", 8192)}
		}},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			input := managedTemplateInput()
			test.mutate(&input.Runtime)
			if _, err := NewTemplateRevision(input); err == nil {
				t.Fatal("invalid managed MCP configuration accepted")
			}
		})
	}
}

func TestManagedMCPConfigurationWireDefaultsAndLimits(t *testing.T) {
	t.Parallel()
	input := managedTemplateInput()
	input.Runtime.MCPServers = nil
	for i := range 8 {
		input.Runtime.MCPServers = append(input.Runtime.MCPServers, MCPServer{ID: fmt.Sprintf("server-%d", i), Command: "node"})
	}
	revision, err := NewTemplateRevision(input)
	if err != nil {
		t.Fatal(err)
	}
	payload, err := json.Marshal(revision.Snapshot().Runtime)
	if err != nil || !strings.Contains(string(payload), `"args":[],"env":{}`) {
		t.Fatalf("wire defaults do not match Runtime contract: %s %v", payload, err)
	}
	input.Runtime.MCPServers = append(input.Runtime.MCPServers, MCPServer{ID: "ninth", Command: "node"})
	if _, err := NewTemplateRevision(input); err == nil {
		t.Fatal("ninth MCP server accepted")
	}
	input.Runtime.MCPServers = input.Runtime.MCPServers[:8]
	for i := range input.Runtime.MCPServers {
		input.Runtime.MCPServers[i].Args = []string{strings.Repeat("x", 8192)}
	}
	if _, err := NewTemplateRevision(input); err == nil {
		t.Fatal("encoded configuration over 64 KiB accepted")
	}
}

func managedTemplateInput() TemplateRevisionInput {
	runtime := validRuntime()
	runtime.MCPServers = []MCPServer{{ID: "documents", Command: "node", Args: []string{"server.js"}, Env: map[string]string{"TOKEN": "synthetic-token"}}}
	return TemplateRevisionInput{
		TemplateID: "template", OrganizationID: "org", Revision: 1,
		ModelProfileRevisionID: "model-rev", MaxModelRequests: 8,
		ContextPolicyVersion: ContextPolicyV1, Runtime: runtime,
	}
}
