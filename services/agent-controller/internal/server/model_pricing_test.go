package server

import (
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"testing"

	"soft/antnest-platform/services/agent-controller/internal/domain"
)

func TestControlAndRunPricingSchemasAgree(t *testing.T) {
	payload, err := os.ReadFile(filepath.Join(repositoryRoot(t), "contracts/agent-controller/control-api.schema.json"))
	if err != nil {
		t.Fatal(err)
	}
	var control struct {
		Definitions map[string]any `json:"$defs"`
	}
	if err := json.Unmarshal(payload, &control); err != nil {
		t.Fatal(err)
	}
	run := readMachineRunContract(t)
	var response map[string]any
	if err := json.Unmarshal(run.Methods["acquire_run"].Response, &response); err != nil {
		t.Fatal(err)
	}
	pricing := schemaProperty(t, schemaProperty(t, schemaProperty(t, response, "execution_spec"), "model"), "pricing")
	if !reflect.DeepEqual(pricing, control.Definitions["model_pricing"]) {
		t.Fatal("control and run price contracts drifted")
	}
}

func sampleModelPricing() *domain.ModelPricing {
	input, output, cacheRead, cacheWrite := 2.0, 8.0, 0.5, 3.0
	return &domain.ModelPricing{Currency: "USD", InputPerMillion: &input, OutputPerMillion: &output,
		CacheReadPerMillion: &cacheRead, CacheWritePerMillion: &cacheWrite}
}

func schemaProperty(t *testing.T, object map[string]any, key string) map[string]any {
	t.Helper()
	properties, ok := object["properties"].(map[string]any)
	if !ok {
		t.Fatal("missing schema properties")
	}
	property, ok := properties[key].(map[string]any)
	if !ok {
		t.Fatalf("missing property %q", key)
	}
	return property
}
