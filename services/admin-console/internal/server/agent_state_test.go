package server

import (
	"bytes"
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

func TestAgentReadinessProjectionPreservesControllerValues(t *testing.T) {
	for _, projector := range agentReadinessProjectorsForTest() {
		for _, readiness := range []string{"preparing", "ready", "unavailable"} {
			t.Run(projector.name+"/"+readiness, func(t *testing.T) {
				agent := agentReadinessSourceForTest()
				agent["readiness"] = readiness
				got, result, err := projectAgentReadinessForTest(t, projector, agent)
				if err != nil {
					t.Fatal(err)
				}
				if got["readiness"] != readiness {
					t.Fatalf("Controller readiness was not preserved: got %v, want %q", got["readiness"], readiness)
				}
				// A healthy Runtime must not override preparing or unavailable.
				assertAgentReadinessProjectionForTest(t, got, result, "available")
			})
		}
	}
}

func TestAgentReadinessProjectionMissingRemainsUnknown(t *testing.T) {
	for _, projector := range agentReadinessProjectorsForTest() {
		for _, runtimeState := range []string{"available", "exited", "unknown"} {
			t.Run(projector.name+"/"+runtimeState, func(t *testing.T) {
				agent := agentReadinessSourceForTest()
				agent["runtime_state"] = runtimeState
				got, result, err := projectAgentReadinessForTest(t, projector, agent)
				if err != nil {
					t.Fatal(err)
				}
				if value, present := got["readiness"]; present {
					t.Fatalf("missing readiness acquired a value: %v", value)
				}
				assertAgentReadinessProjectionForTest(t, got, result, runtimeState)
			})
		}
	}
}

func TestAgentReadinessProjectionRejectsMalformedValues(t *testing.T) {
	cases := []struct {
		name  string
		value any
	}{
		{name: "null", value: nil},
		{name: "unknown", value: "pending"},
		{name: "empty", value: ""},
		{name: "case_alias", value: "Ready"},
		{name: "number", value: 1},
		{name: "bool", value: true},
		{name: "object", value: map[string]any{"readiness": "ready"}},
		{name: "array", value: []string{"ready"}},
	}
	for _, projector := range agentReadinessProjectorsForTest() {
		for _, testCase := range cases {
			t.Run(projector.name+"/"+testCase.name, func(t *testing.T) {
				agent := agentReadinessSourceForTest()
				agent["readiness"] = testCase.value
				_, result, err := projectAgentReadinessForTest(t, projector, agent)
				if err == nil {
					t.Fatal("malformed readiness was accepted")
				}
				if len(result) != 0 {
					t.Fatal("malformed readiness produced a browser response")
				}
			})
		}
	}
}

type agentReadinessProjectorForTest struct {
	name    string
	project func([]byte) ([]byte, error)
}

func agentReadinessProjectorsForTest() []agentReadinessProjectorForTest {
	return []agentReadinessProjectorForTest{
		{name: "detail", project: projectAgent},
		{name: "list", project: projectAgentList},
		{name: "create", project: projectCreateAgent},
	}
}

func agentReadinessSourceForTest() map[string]any {
	return map[string]any{
		"agent_id": "agent-1", "owner_user_id": "owner-1", "name": "Agent",
		"desired_state": "enabled", "lifecycle_state": "created", "activation_state": "enabled",
		"runtime_state": "available", "aggregate_sequence": 7,
		"agent_spec_revision": "spec-1", "executable_execution_revision": "execution-1",
		"created_at": "2026-10-23T00:00:00Z", "updated_at": "2026-10-23T00:00:01Z",
		"runtime": map[string]any{
			"runtime_revision":     "runtime-1",
			"runtime_execution_id": "private-readiness-proof-process",
			"mcp_endpoint":         "https://private-readiness-proof.invalid/mcp",
		},
		"readiness_proof": map[string]any{
			"readiness": "ready", "ready_after_revision": 10, "applied_revision": 10,
			"runtime_execution_id": "private-readiness-proof-process",
		},
		"ready_after_revision": 10, "applied_revision": 10,
		"runtime_execution_id": "private-readiness-proof-process",
	}
}

func projectAgentReadinessForTest(t *testing.T, projector agentReadinessProjectorForTest, agent map[string]any) (map[string]any, []byte, error) {
	t.Helper()
	var source any = agent
	switch projector.name {
	case "list":
		source = map[string]any{"items": []any{agent}, "next_cursor": nil}
	case "create":
		source = map[string]any{
			"agent": agent,
			"operation": map[string]any{
				"request_id": "create-1", "agent_id": "agent-1", "kind": "create",
				"phase": "completed", "state": "completed",
				"created_at": "2026-10-23T00:00:00Z", "updated_at": "2026-10-23T00:00:01Z",
			},
		}
	}
	payload, err := json.Marshal(source)
	if err != nil {
		t.Fatal(err)
	}
	result, err := projector.project(payload)
	if err != nil {
		return nil, result, err
	}
	var got map[string]any
	if err := json.Unmarshal(result, &got); err != nil {
		t.Fatal(err)
	}
	switch projector.name {
	case "list":
		items, ok := got["items"].([]any)
		if !ok || len(items) != 1 {
			t.Fatal("projection lost the original Agent inventory")
		}
		got, ok = items[0].(map[string]any)
		if !ok {
			t.Fatal("projection returned an invalid Agent item")
		}
	case "create":
		operation, ok := got["operation"].(map[string]any)
		if !ok || operation["request_id"] != "create-1" {
			t.Fatal("projection lost the original Create operation")
		}
		got, ok = got["agent"].(map[string]any)
		if !ok {
			t.Fatal("projection lost the created Agent")
		}
	}
	return got, result, nil
}

func assertAgentReadinessProjectionForTest(t *testing.T, got map[string]any, result []byte, runtimeState string) {
	t.Helper()
	for key, want := range map[string]string{
		"agent_id": "agent-1", "owner_user_id": "owner-1", "lifecycle_state": "created",
		"activation_state": "enabled", "runtime_state": runtimeState,
	} {
		if got[key] != want {
			t.Fatalf("readiness projection changed %s: got %v, want %q", key, got[key], want)
		}
	}
	runtime, ok := got["runtime"].(map[string]any)
	if !ok || len(runtime) != 1 || runtime["runtime_revision"] != "runtime-1" {
		t.Fatal("readiness projection changed the public Runtime binding")
	}
	for _, privateField := range []string{"readiness_proof", "ready_after_revision", "applied_revision", "runtime_execution_id", "mcp_endpoint", "private-readiness-proof"} {
		if bytes.Contains(result, []byte(privateField)) {
			t.Fatalf("readiness projection leaked %s", privateField)
		}
	}
}
