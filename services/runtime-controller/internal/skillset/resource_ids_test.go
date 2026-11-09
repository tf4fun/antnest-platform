package skillset

import (
	"encoding/json"
	"os"
	"testing"
)

type resourceIDVectors struct {
	Accept []string `json:"accept"`
	Reject []string `json:"reject"`
}

func readResourceIDVectors(t *testing.T) map[string]resourceIDVectors {
	t.Helper()
	data, err := os.ReadFile("../../../../contracts/common/id-vectors.json")
	if err != nil {
		t.Fatal(err)
	}
	var vectors map[string]resourceIDVectors
	if err := json.Unmarshal(data, &vectors); err != nil {
		t.Fatal(err)
	}
	return vectors
}

func TestResourceIDSharedVectors(t *testing.T) {
	vectors := readResourceIDVectors(t)
	for _, value := range vectors["organizationId"].Accept {
		if err := Validate(value, 1, nil); err != nil {
			t.Errorf("organizationId must accept %q: %v", value, err)
		}
	}
	for _, value := range vectors["organizationId"].Reject {
		if err := Validate(value, 1, nil); err == nil {
			t.Errorf("organizationId must reject %q", value)
		}
	}
	for _, value := range vectors["agentId"].Accept {
		if !validControlIdentifier(value) {
			t.Errorf("agentId must accept %q", value)
		}
	}
	for _, value := range vectors["agentId"].Reject {
		if validControlIdentifier(value) {
			t.Errorf("agentId must reject %q", value)
		}
	}
}
