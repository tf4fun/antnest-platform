package domain

import (
	"encoding/json"
	"testing"
)

func TestModelParametersRejectConnectionFieldsAndInvalidPricingJSON(t *testing.T) {
	for _, field := range []string{
		`"base_url":"https://api.example.com"`, `"credential":{"api_key":"key"}`,
		`"pricing":null`, `"Pricing":null`, `"pricing":{"input_per_million":null}`,
		`"pricing":{"currency":"USD","unknown":1}`,
	} {
		var model ModelParameters
		if err := json.Unmarshal([]byte(`{"model":"example",`+field+`}`), &model); err == nil {
			t.Fatalf("invalid model parameter accepted: %s", field)
		}
	}
}

func TestModelParametersPreserveZeroValuesAndOwnPointerValues(t *testing.T) {
	var parameters ModelParameters
	err := json.Unmarshal([]byte(`{"model":"example","context_window":4096,"max_output_tokens":512,
"supports_images":false,"temperature":0,"pricing":{"currency":"USD","input_per_million":0,"output_per_million":0}}`), &parameters)
	if err != nil {
		t.Fatal(err)
	}
	model := parameters.WithEndpoint("https://api.example.com")
	copy := model.Parameters()
	*copy.Temperature, *copy.Pricing.InputPerMillion = 1, 1
	if parameters.SupportsImages || *parameters.Temperature != 0 || *model.Pricing.InputPerMillion != 0 {
		t.Fatal("model conversion changed zero values or aliased mutable fields")
	}
	payload, err := json.Marshal(parameters)
	if err != nil {
		t.Fatal(err)
	}
	var fields map[string]any
	if err := json.Unmarshal(payload, &fields); err != nil {
		t.Fatal(err)
	}
	if _, present := fields["base_url"]; present {
		t.Fatal("model persistence contains its connection endpoint")
	}
}
