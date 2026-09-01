package server

import (
	"encoding/json"
	"os"
	"path/filepath"
	"runtime"
	"slices"
	"testing"

	"soft/antnest-platform/services/agent-controller/internal/ports"
)

func TestMachineEventContractDeclaresReplayAndResumeInputs(t *testing.T) {
	t.Parallel()

	root := repositoryRoot(t)
	var contract struct {
		Resources struct {
			Events map[string]struct {
				Method  string   `json:"method"`
				Path    string   `json:"path"`
				Query   []string `json:"query"`
				Headers []string `json:"headers"`
			} `json:"events"`
		} `json:"resources"`
	}
	readContractJSON(t, filepath.Join(root, "contracts/agent-controller/control-contract.json"), &contract)
	if len(contract.Resources.Events) != 4 {
		t.Fatalf("event contract routes = %+v", contract.Resources.Events)
	}
	for name, route := range contract.Resources.Events {
		if route.Method != "GET" || route.Path == "" || !slices.Contains(route.Query, "after_sequence") {
			t.Fatalf("event route %s is incomplete: %+v", name, route)
		}
		if name == "watch" || name == "watch_global" {
			if !slices.Contains(route.Headers, "Last-Event-ID") {
				t.Fatalf("watch route %s omits Last-Event-ID: %+v", name, route)
			}
		}
	}
}

func TestMachineEventTypesMatchProducerContract(t *testing.T) {
	t.Parallel()

	root := repositoryRoot(t)
	var schema struct {
		Defs map[string]struct {
			Properties map[string]struct {
				Enum []string `json:"enum"`
			} `json:"properties"`
		} `json:"$defs"`
	}
	readContractJSON(t, filepath.Join(root, "contracts/agent-controller/control-api.schema.json"), &schema)
	actual := schema.Defs["agent_event"].Properties["event_type"].Enum
	expected := []string{
		ports.EventAgentCreateRequested,
		ports.EventAgentReady,
		ports.EventAgentBuildFailed,
		ports.EventAgentRebuildRequested,
		ports.EventAgentRebuilt,
		ports.EventAgentDisableRequested,
		ports.EventAgentDisabled,
		ports.EventAgentDisableFailed,
		ports.EventAgentEnableRequested,
		ports.EventAgentEnabled,
		ports.EventAgentEnableFailed,
		ports.EventAgentDeleteRequested,
		ports.EventAgentDeleted,
		ports.EventRunAdmissionReleased,
		ports.EventRunAdmissionUnresolved,
	}
	if !slices.Equal(actual, expected) {
		t.Fatalf("event type schema=%v producers=%v", actual, expected)
	}
}

func repositoryRoot(t *testing.T) string {
	t.Helper()
	_, file, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("resolve contract test path")
	}
	return filepath.Clean(filepath.Join(filepath.Dir(file), "../../../.."))
}

func readContractJSON(t *testing.T, path string, target any) {
	t.Helper()
	payload, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal(payload, target); err != nil {
		t.Fatalf("parse %s: %v", path, err)
	}
}
