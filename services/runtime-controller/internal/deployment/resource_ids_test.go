package deployment

import (
	"encoding/json"
	"os"
	"testing"
)

type resourceIDVectors struct {
	Accept []string `json:"accept"`
	Reject []string `json:"reject"`
}

func TestResourceIDSharedVectors(t *testing.T) {
	data, err := os.ReadFile("../../../../contracts/common/id-vectors.json")
	if err != nil {
		t.Fatal(err)
	}
	var vectors map[string]resourceIDVectors
	if err := json.Unmarshal(data, &vectors); err != nil {
		t.Fatal(err)
	}
	for _, kind := range []string{"organizationId", "userId", "agentId"} {
		for _, value := range vectors[kind].Accept {
			if err := validateIdentifier("agent_id", value); err != nil {
				t.Errorf("%s must accept %q: %v", kind, value, err)
			}
		}
		for _, value := range vectors[kind].Reject {
			if err := validateIdentifier("agent_id", value); err == nil {
				t.Errorf("%s must reject %q", kind, value)
			}
		}
	}
}
