package runtimeclient

import (
	"encoding/json"
	"testing"
)

func TestLiveRuntimeInspectionRequiresCanonicalGenerationKey(t *testing.T) {
	for _, key := range []string{"", "rtk_bad", " rtk_0123456789abcdef0123456789abcdef", "rtk_0123456789ABCDEF0123456789abcdef"} {
		var inspection runtimeInspectionDTO
		raw := map[string]any{
			"agent_id": "agent-1", "runtime_revision": "rtv_0123456789abcdef0123456789abcdef",
			"lifecycle_state": "provisioned", "health": "unknown", "phase": "running",
			"runtime_endpoint": "10.243.1.20", "tunnel_key_id": key,
		}
		body, _ := json.Marshal(raw)
		if err := json.Unmarshal(body, &inspection); err != nil {
			t.Fatal(err)
		}
		if validRuntimeInspection(inspection) {
			t.Fatal("accepted live peer without its canonical generation key", key)
		}
	}
}
