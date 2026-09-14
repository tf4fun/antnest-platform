package server

import (
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"testing"

	"soft/antnest-platform/services/agent-controller/internal/domain"
)

func TestControlAndExecutionPricingSchemasAgree(t *testing.T) {
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
	payload, err = os.ReadFile(filepath.Join(repositoryRoot(t), "contracts/agent-acp/execution-snapshot.schema.json"))
	if err != nil {
		t.Fatal(err)
	}
	var execution map[string]any
	if err := json.Unmarshal(payload, &execution); err != nil {
		t.Fatal(err)
	}
	models := schemaProperty(t, execution, "models")
	item, ok := models["items"].(map[string]any)
	if !ok {
		t.Fatal("missing execution model schema")
	}
	pricing := schemaProperty(t, item, "pricing")
	if !reflect.DeepEqual(pricing, control.Definitions["model_pricing"]) {
		t.Fatal("control and execution price contracts drifted")
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
