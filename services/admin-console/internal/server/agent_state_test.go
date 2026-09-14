package server

import (
	"encoding/json"
	"testing"
)

func TestAgentProjectionPreservesStateHierarchyAndDiagnostics(t *testing.T) {
	payload := []byte(`{"agent_id":"a1","lifecycle_state":"created","activation_state":"enabled","runtime_state":"exited","runtime_reason":"container_exit","runtime_detail":"process exited with code 1","runtime_observed_at":"2026-09-13T00:00:00Z","runtime":{"runtime_revision":"r1","mcp_endpoint":"http://private/mcp"}}`)
	result, err := projectAgent(payload)
	if err != nil {
		t.Fatal(err)
	}
	var got map[string]any
	if err := json.Unmarshal(result, &got); err != nil {
		t.Fatal(err)
	}
	for key, want := range map[string]string{"lifecycle_state": "created", "activation_state": "enabled", "runtime_state": "exited", "runtime_reason": "container_exit", "runtime_detail": "process exited with code 1", "runtime_observed_at": "2026-09-13T00:00:00Z"} {
		if got[key] != want {
			t.Fatalf("projection lost %s: %+v", key, got)
		}
	}
	runtime := got["runtime"].(map[string]any)
	if len(runtime) != 1 || runtime["runtime_revision"] != "r1" {
		t.Fatalf("bad configured target: %+v", runtime)
	}
}
