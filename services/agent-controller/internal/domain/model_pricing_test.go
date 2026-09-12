package domain

import (
	"encoding/json"
	"math"
	"reflect"
	"testing"
)

func TestModelPricingValidatesRequiredFiniteUSDRates(t *testing.T) {
	t.Parallel()
	for _, test := range []struct {
		name    string
		pricing *ModelPricing
		valid   bool
	}{
		{"unknown", nil, true},
		{"free", testPricing(0, 0), true},
		{"positive", testPricing(2, 8), true},
		{"missing input", &ModelPricing{Currency: "USD", OutputPerMillion: rate(1)}, false},
		{"missing output", &ModelPricing{Currency: "USD", InputPerMillion: rate(1)}, false},
		{"missing currency", &ModelPricing{InputPerMillion: rate(1), OutputPerMillion: rate(1)}, false},
		{"wrong currency", &ModelPricing{Currency: "CNY", InputPerMillion: rate(1), OutputPerMillion: rate(1)}, false},
		{"negative", testPricing(-1, 2), false},
		{"nan", testPricing(math.NaN(), 2), false},
		{"infinite", testPricing(1, math.Inf(1)), false},
	} {
		t.Run(test.name, func(t *testing.T) {
			model := validModel()
			model.Pricing = test.pricing
			if err := ValidateModelSpec(model); (err == nil) != test.valid {
				t.Fatalf("validation error=%v valid=%t", err, test.valid)
			}
		})
	}
	for _, value := range []float64{-1, math.NaN(), math.Inf(1), math.Inf(-1)} {
		for _, write := range []bool{false, true} {
			model := validModel()
			model.Pricing = testPricing(1, 2)
			if write {
				model.Pricing.CacheWritePerMillion = &value
			} else {
				model.Pricing.CacheReadPerMillion = &value
			}
			if err := ValidateModelSpec(model); err == nil {
				t.Fatal("invalid cache price accepted")
			}
		}
	}
}

func TestModelPricingJSONDoesNotTurnMissingRatesIntoFree(t *testing.T) {
	t.Parallel()
	for _, raw := range []string{
		`{}`, `{"currency":"USD"}`, `{"currency":"USD","input_per_million":0}`,
		`{"currency":"USD","input_per_million":null,"output_per_million":0}`,
	} {
		model := validModel()
		if err := json.Unmarshal([]byte(raw), &model.Pricing); err != nil {
			t.Fatal(err)
		}
		if err := ValidateModelSpec(model); err == nil {
			t.Fatalf("incomplete price accepted: %s", raw)
		}
	}
	model := validModel()
	model.Pricing = testPricing(0, 0)
	encoded, err := json.Marshal(model)
	if err != nil {
		t.Fatal(err)
	}
	var decoded ModelSpec
	if err := json.Unmarshal(encoded, &decoded); err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(model, decoded) {
		t.Fatal("explicit zero was lost")
	}
}

func TestModelPricingSnapshotsAreDeeplyIsolated(t *testing.T) {
	t.Parallel()
	model := validModel()
	model.Pricing = testPricing(2, 8)
	model.Pricing.CacheReadPerMillion, model.Pricing.CacheWritePerMillion = rate(0.5), rate(3)
	revision, err := NewModelProfileRevision(ModelProfileRevisionInput{
		ID: "revision", ModelProfileID: "model", OrganizationID: "org", Revision: 1,
		Model: model,
	})
	if err != nil {
		t.Fatal(err)
	}
	template, err := NewTemplateRevision(TemplateRevisionInput{
		TemplateID: "template", OrganizationID: "org", Revision: 1, ModelProfileID: revision.Snapshot().ModelProfileID,
		SystemPrompt: "prompt", MaxModelRequests: 8, Runtime: validRuntime(), ContextPolicyVersion: "context-v1",
	})
	if err != nil {
		t.Fatal(err)
	}
	spec, err := MaterializeAgentSpec(template, revision)
	if err != nil {
		t.Fatal(err)
	}
	want := spec.Snapshot().Model.Pricing
	digest, err := spec.Digest()
	if err != nil {
		t.Fatal(err)
	}
	for _, pricing := range []*ModelPricing{model.Pricing, revision.Snapshot().Model.Pricing, spec.Snapshot().Model.Pricing} {
		pricing.Currency = "CNY"
		*pricing.InputPerMillion, *pricing.OutputPerMillion = 99, 99
		*pricing.CacheReadPerMillion, *pricing.CacheWritePerMillion = 99, 99
	}
	gotDigest, err := spec.Digest()
	if err != nil || gotDigest != digest || !reflect.DeepEqual(revision.Snapshot().Model.Pricing, want) ||
		!reflect.DeepEqual(spec.Snapshot().Model.Pricing, want) {
		t.Fatal("pricing mutation escaped snapshot")
	}
}

func testPricing(input, output float64) *ModelPricing {
	return &ModelPricing{Currency: "USD", InputPerMillion: rate(input), OutputPerMillion: rate(output)}
}

func TestModelSpecRejectsExplicitNullPricingJSON(t *testing.T) {
	for _, raw := range []string{
		`{"pricing":null}`,
		`{"Pricing":null}`,
		`{"PRICING":{"currency":"USD","input_per_million":1,"output_per_million":1,"cache_read_per_million":null}}`,
		`{"Pricing":{"currency":"USD","input_per_million":1,"output_per_million":1,"cache_write_per_million":null}}`,
		`{"pricing":{"currency":"USD","input_per_million":1,"output_per_million":1,"cache_read_per_million":null}}`,
		`{"pricing":{"currency":"USD","input_per_million":1,"output_per_million":1,"cache_write_per_million":null}}`,
	} {
		var model ModelSpec
		if err := json.Unmarshal([]byte(raw), &model); err == nil {
			t.Fatalf("null pricing accepted: %s", raw)
		}
	}
}

func rate(value float64) *float64 { return &value }
