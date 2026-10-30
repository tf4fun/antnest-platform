package rpc

import (
	"bytes"
	"encoding/json"
	"os"
	"testing"
)

type resourceDeliveryEntry struct {
	Name             string          `json:"name"`
	Configuration    json.RawMessage `json:"configuration"`
	TemplateResource json.RawMessage `json:"template_resources"`
}

func readResourceDeliveryEntries(t *testing.T) []resourceDeliveryEntry {
	t.Helper()
	input := os.Getenv("ANTNEST_RUNTIME_RESOURCE_INPUT")
	if input == "" {
		t.Skip("only run by the resource delivery contract bridge")
	}
	raw, err := os.ReadFile(input)
	if err != nil {
		t.Fatal(err)
	}
	var entries []resourceDeliveryEntry
	if err := json.Unmarshal(raw, &entries); err != nil {
		t.Fatal(err)
	}
	if len(entries) != 7 {
		t.Fatalf("expected seven producer entries, got %d", len(entries))
	}
	return entries
}

func TestRuntimeResourceDeliveryConsumer(t *testing.T) {
	for _, entry := range readResourceDeliveryEntries(t) {
		var wire struct {
			Resources struct {
				CPUMillis      uint64 `json:"cpu_millis"`
				WorkspaceBytes uint64 `json:"workspace_bytes"`
			} `json:"resources"`
		}
		if err := json.Unmarshal(entry.Configuration, &wire); err != nil {
			t.Fatalf("%s: decode emitted resource values: %v", entry.Name, err)
		}
		var dto configurationDTO
		decoder := json.NewDecoder(bytes.NewReader(entry.Configuration))
		decoder.DisallowUnknownFields()
		if err := decoder.Decode(&dto); err != nil {
			t.Fatalf("%s: consumer DTO rejected producer bytes: %v", entry.Name, err)
		}
		resolved, err := dto.domain().Resolve("agent-1", 7)
		if err != nil {
			t.Fatalf("%s: deployment validation rejected producer bytes: %v", entry.Name, err)
		}
		if resolved.Resources.EffectiveCPUMillis() != wire.Resources.CPUMillis ||
			resolved.Resources.EffectiveWorkspaceBytes() != wire.Resources.WorkspaceBytes {
			t.Fatalf("%s: effective limits cpu=%d workspace=%d, emitted %d/%d",
				entry.Name, resolved.Resources.EffectiveCPUMillis(),
				resolved.Resources.EffectiveWorkspaceBytes(),
				wire.Resources.CPUMillis, wire.Resources.WorkspaceBytes)
		}
	}
	t.Logf("ANTNEST_RUNTIME_RESOURCE_CONSUMER=7")
}
