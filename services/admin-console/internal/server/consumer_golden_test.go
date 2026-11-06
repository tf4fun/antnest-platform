package server

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
)

func readGoldenDocument(t *testing.T, path string) any {
	t.Helper()
	contents, err := os.ReadFile(filepath.Join("../../../../contracts", path))
	if err != nil {
		t.Fatalf("read golden %s: %v", path, err)
	}
	var document any
	if err := json.Unmarshal(contents, &document); err != nil {
		t.Fatalf("parse golden %s: %v", path, err)
	}
	return document
}

func cloneGoldenDocument(t *testing.T, document any) any {
	t.Helper()
	encoded, err := json.Marshal(document)
	if err != nil {
		t.Fatalf("clone encode: %v", err)
	}
	var clone any
	if err := json.Unmarshal(encoded, &clone); err != nil {
		t.Fatalf("clone decode: %v", err)
	}
	return clone
}

func withFutureFields(value any) any {
	switch typed := value.(type) {
	case map[string]any:
		out := make(map[string]any, len(typed)+1)
		out["x_future_field"] = float64(1)
		for key, item := range typed {
			out[key] = withFutureFields(item)
		}
		return out
	case []any:
		out := make([]any, len(typed))
		for index, item := range typed {
			out[index] = withFutureFields(item)
		}
		return out
	default:
		return typed
	}
}

func projectDocument(t *testing.T, project func([]byte) ([]byte, error), document any) any {
	t.Helper()
	payload, err := json.Marshal(document)
	if err != nil {
		t.Fatalf("encode input: %v", err)
	}
	output, err := project(payload)
	if err != nil {
		t.Fatalf("projection rejected input: %v", err)
	}
	var decoded any
	if err := json.Unmarshal(output, &decoded); err != nil {
		t.Fatalf("projection output invalid JSON: %v", err)
	}
	return decoded
}

func assertGoldenProjection(t *testing.T, project func([]byte) ([]byte, error), document any) {
	t.Helper()
	baseline := projectDocument(t, project, document)
	extended := projectDocument(t, project, withFutureFields(document))
	if !reflect.DeepEqual(extended, baseline) {
		t.Fatalf("extended projection differs: %+v != %+v", extended, baseline)
	}
	encoded, err := json.Marshal(extended)
	if err != nil {
		t.Fatalf("marshal extended: %v", err)
	}
	if strings.Contains(string(encoded), "x_future_field") {
		t.Fatalf("extension member leaked into public projection")
	}
}

func projectGoldenExpectErr(t *testing.T, project func([]byte) ([]byte, error), document any, name string) {
	t.Helper()
	payload, err := json.Marshal(withFutureFields(document))
	if err != nil {
		t.Fatalf("encode input: %v", err)
	}
	if _, err := project(payload); err == nil {
		t.Fatalf("%s accepted", name)
	}
}

func auditOpaqueStripped(value any) any {
	if root, ok := value.(map[string]any); ok {
		if items, ok := root["items"].([]any); ok {
			for _, item := range items {
				if object, ok := item.(map[string]any); ok {
					for _, opaque := range []string{"payload", "request"} {
						if inner, ok := object[opaque].(map[string]any); ok {
							if _, injected := inner["x_future_field"]; !injected {
								return nil
							}
							delete(inner, "x_future_field")
						}
					}
				}
			}
		}
	}
	return value
}

func TestConsumerGoldenControllerAgents(t *testing.T) {
	assertGoldenProjection(t, projectAgent, readGoldenDocument(t, "agent-controller/examples/get-agent.ready.json"))
	assertGoldenProjection(t, projectAgentList, readGoldenDocument(t, "agent-controller/examples/list-agents.ready.json"))
	assertGoldenProjection(t, projectAgentEventList, readGoldenDocument(t, "agent-controller/examples/list-events.ready.json"))
}

func TestConsumerGoldenExecutionAuditEvents(t *testing.T) {
	for _, name := range []string{"current", "permissions", "n-1"} {
		document := readGoldenDocument(t, "agent-acp/examples/execution-events."+name+".json")
		baseline := projectDocument(t, projectExecutionAuditEvents, document)
		extended := projectDocument(t, projectExecutionAuditEvents, withFutureFields(document))
		if auditOpaqueStripped(extended) == nil {
			t.Fatalf("%s opaque payload/request projection lost injected members", name)
		}
		if !reflect.DeepEqual(extended, baseline) {
			t.Fatalf("%s extended projection differs", name)
		}
	}
}

func TestConsumerGoldenRejectsInvalidKnownFields(t *testing.T) {
	agent := readGoldenDocument(t, "agent-controller/examples/get-agent.ready.json").(map[string]any)
	broken := cloneGoldenDocument(t, agent).(map[string]any)
	broken["agent_id"] = float64(7)
	projectGoldenExpectErr(t, projectAgent, broken, "agent_id integer")
	broken = cloneGoldenDocument(t, agent).(map[string]any)
	broken["readiness"] = "sideways"
	projectGoldenExpectErr(t, projectAgent, broken, "readiness sideways")

	events := readGoldenDocument(t, "agent-acp/examples/execution-events.current.json").(map[string]any)
	broken = cloneGoldenDocument(t, events).(map[string]any)
	delete(broken["items"].([]any)[0].(map[string]any), "id")
	projectGoldenExpectErr(t, projectExecutionAuditEvents, broken, "event id missing")
	broken = cloneGoldenDocument(t, events).(map[string]any)
	broken["items"].([]any)[0].(map[string]any)["visible"] = "yes"
	projectGoldenExpectErr(t, projectExecutionAuditEvents, broken, "visible wrong type")

	permissions := readGoldenDocument(t, "agent-acp/examples/execution-events.permissions.json").(map[string]any)
	broken = cloneGoldenDocument(t, permissions).(map[string]any)
	delete(broken["items"].([]any)[0].(map[string]any), "decision")
	projectGoldenExpectErr(t, projectExecutionAuditEvents, broken, "decision missing")
}

func TestConsumerGoldenAgentEventListRejectsUnsupportedVersions(t *testing.T) {
	events := readGoldenDocument(t, "agent-controller/examples/list-events.ready.json").(map[string]any)
	for _, version := range []any{float64(0), float64(3), nil, "1", 1.5} {
		broken := cloneGoldenDocument(t, events).(map[string]any)
		broken["events"].([]any)[0].(map[string]any)["schema_version"] = version
		projectGoldenExpectErr(t, projectAgentEventList, broken, fmt.Sprintf("event schema_version %v", version))
	}
	missing := cloneGoldenDocument(t, events).(map[string]any)
	delete(missing["events"].([]any)[0].(map[string]any), "schema_version")
	projectGoldenExpectErr(t, projectAgentEventList, missing, "event schema_version missing")
	accepted := cloneGoldenDocument(t, events).(map[string]any)
	accepted["events"].([]any)[0].(map[string]any)["schema_version"] = float64(2)
	payload, err := json.Marshal(accepted)
	if err != nil {
		t.Fatalf("encode: %v", err)
	}
	if _, err := projectAgentEventList(payload); err != nil {
		t.Fatalf("schema_version 2 rejected: %v", err)
	}
}

func TestConsumerGoldenAuditRejectsUnsupportedMarkers(t *testing.T) {
	for _, name := range []string{"current", "permissions"} {
		base := readGoldenDocument(t, "agent-acp/examples/execution-events."+name+".json").(map[string]any)
		for _, version := range []any{float64(0), float64(2), nil, "1", 1.5} {
			broken := cloneGoldenDocument(t, base).(map[string]any)
			broken["schema_version"] = version
			projectGoldenExpectErr(t, projectExecutionAuditEvents, broken, name+" root schema_version")
			broken = cloneGoldenDocument(t, base).(map[string]any)
			broken["items"].([]any)[0].(map[string]any)["schema_version"] = version
			projectGoldenExpectErr(t, projectExecutionAuditEvents, broken, name+" item schema_version")
		}
	}
	payload, err := json.Marshal(readGoldenDocument(t, "agent-acp/examples/execution-events.n-1.json"))
	if err != nil {
		t.Fatalf("encode n-1: %v", err)
	}
	if _, err := projectExecutionAuditEvents(payload); err != nil {
		t.Fatalf("frozen n-1 markers rejected: %v", err)
	}
}
