package server

import (
	"encoding/json"
	"net/http"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"

	"github.com/tf4fun/antnest-platform/services/admin-console/internal/upstream"
)

func handoffFixture(t *testing.T) map[string]any {
	t.Helper()
	raw, err := os.ReadFile(filepath.Join("..", "..", "..", "..", "tests", "integration", "runtime-egress", "policy-v2-handoff.json"))
	if err != nil {
		t.Fatal(err)
	}
	var fixture map[string]any
	if err := json.Unmarshal(raw, &fixture); err != nil {
		t.Fatal(err)
	}
	return fixture
}

func TestNetworkPolicySpecWriteConsumesTheSharedHandoffFixture(t *testing.T) {
	fixture := handoffFixture(t)
	spec, _ := json.Marshal(fixture["spec"])
	assignment, _ := json.Marshal(fixture["assignment"])
	backend := newBackendStub()
	backend.enqueue(http.StatusOK, string(assignment))
	response := requestNetworkAdmin(
		t, newTestHandler(t, backend), http.MethodPut, networkPath,
		`{"spec":`+string(spec)+`,"expected_resource_version":1}`,
	)
	if response.Code != http.StatusOK {
		t.Fatalf("handoff spec write=%d %s", response.Code, response.Body.String())
	}
	assertNoInternalPolicyFields(t, response.Body.String())
	var value map[string]any
	decodeBytes(t, response.Body.Bytes(), &value)
	if value["agent_id"] != fixture["agent_id"] || value["resource_version"] != float64(2) {
		t.Fatalf("browser ack=%s", response.Body.String())
	}
	var sentSpec any
	if err := json.Unmarshal(spec, &sentSpec); err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(value["spec"], sentSpec) {
		t.Fatalf("browser ack spec mismatch: %s", response.Body.String())
	}
	call := backend.singleCall(t)
	var command map[string]any
	decodeBytes(t, call.Body, &command)
	if call.Target != upstream.AgentController || call.Method != http.MethodPut ||
		call.Path != "/internal/agents/agent-1/network-policy" {
		t.Fatalf("downstream=%+v", call)
	}
	if command["organization_id"] != fixture["organization_id"] ||
		command["actor_principal_id"] != fixture["actor_principal_id"] ||
		command["expected_resource_version"] != float64(1) || command["request_id"] == nil ||
		command["request_id"] == "" {
		t.Fatalf("trusted tuple=%v", command)
	}
	if _, leaked := command["policy_id"]; leaked {
		t.Fatalf("spec write leaked a policy_id: %v", command)
	}
	if _, leaked := command["revision"]; leaked {
		t.Fatalf("spec write leaked a revision: %v", command)
	}
	if !reflect.DeepEqual(command["spec"], sentSpec) {
		t.Fatalf("spec drifted: %v", command["spec"])
	}
}

func TestNetworkPolicyReadProjectsTheSharedHandoffSpec(t *testing.T) {
	fixture := handoffFixture(t)
	spec, _ := json.Marshal(fixture["spec"])
	view := `{"agent_id":"` + fixture["agent_id"].(string) + `","policy":{"policy_id":"` +
		fixture["policy_id"].(string) + `","revision":1,"resource_version":` +
		jsonNumber(t, fixture["assignment"].(map[string]any)["resource_version"]) +
		`,"spec":` + string(spec) + `,"digest":"` + fixture["egress_put_ack"].(map[string]any)["digest"].(string) +
		`"},"attachment":{"state":"closed","resource_version":1},"organization_id":"private"}`
	backend := newBackendStub()
	backend.enqueue(http.StatusOK, view)
	response := requestNetworkAdmin(t, newTestHandler(t, backend), http.MethodGet, networkPath, "")
	if response.Code != http.StatusOK {
		t.Fatalf("handoff read=%d %s", response.Code, response.Body.String())
	}
	assertNoInternalPolicyFields(t, response.Body.String())
	var value map[string]any
	decodeBytes(t, response.Body.Bytes(), &value)
	var expectedSpec any
	if err := json.Unmarshal(spec, &expectedSpec); err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(value["spec"], expectedSpec) || value["resource_version"] != float64(2) {
		t.Fatalf("projection=%s", response.Body.String())
	}
}

func jsonNumber(t *testing.T, value any) string {
	t.Helper()
	encoded, err := json.Marshal(value)
	if err != nil {
		t.Fatal(err)
	}
	return strings.TrimSpace(string(encoded))
}
