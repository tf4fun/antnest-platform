package domain

import (
	"encoding/json"
	"reflect"
	"strings"
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

func TestModelTokenizerAndCompactionProfileIDDecodeAndRoundTrip(t *testing.T) {
	for _, tokenizer := range []string{"o200k", "cl100k", "none"} {
		var model ModelSpec
		err := json.Unmarshal([]byte(`{"base_url":"https://api.example.com/v1","model":"example",
"context_window":4096,"max_output_tokens":512,"tokenizer":"`+tokenizer+`",
"compaction_model_profile_id":"compactor-v2"}`), &model)
		if err != nil {
			t.Fatal(err)
		}
		var parameters ModelParameters
		err = json.Unmarshal([]byte(`{"model":"example","context_window":4096,"max_output_tokens":512,
"tokenizer":"`+tokenizer+`","compaction_model_profile_id":"compactor-v2"}`), &parameters)
		if err != nil {
			t.Fatal(err)
		}
		for _, candidate := range []any{model, parameters, model.Parameters(), parameters.WithEndpoint("https://api.example.com/v1")} {
			if got := modelStringField(t, candidate, "Tokenizer"); got != tokenizer {
				t.Fatalf("%T Tokenizer = %q, want %q", candidate, got, tokenizer)
			}
			if got := modelStringField(t, candidate, "CompactionModelProfileID"); got != "compactor-v2" {
				t.Fatalf("%T CompactionModelProfileID = %q, want %q", candidate, got, "compactor-v2")
			}
		}
	}
}

func TestModelTokenizerAndCompactionProfileIDAreOptional(t *testing.T) {
	var model ModelSpec
	err := json.Unmarshal([]byte(`{"base_url":"https://api.example.com/v1","model":"example",
"context_window":4096,"max_output_tokens":512}`), &model)
	if err != nil {
		t.Fatal(err)
	}
	if err := ValidateModelSpec(model); err != nil {
		t.Fatal(err)
	}
	for _, candidate := range []any{model, model.Parameters()} {
		if got := modelStringField(t, candidate, "Tokenizer"); got != "" {
			t.Fatalf("omitted tokenizer decoded as %q", got)
		}
		if got := modelStringField(t, candidate, "CompactionModelProfileID"); got != "" {
			t.Fatalf("omitted compaction profile decoded as %q", got)
		}
		payload, err := json.Marshal(candidate)
		if err != nil {
			t.Fatal(err)
		}
		var fields map[string]any
		if err := json.Unmarshal(payload, &fields); err != nil {
			t.Fatal(err)
		}
		for _, name := range []string{"tokenizer", "compaction_model_profile_id"} {
			if _, present := fields[name]; present {
				t.Fatalf("empty %s was persisted", name)
			}
		}
	}
}

func TestValidateModelSpecTokenizerAndCompactionProfileID(t *testing.T) {
	for _, test := range []struct {
		field string
		valid bool
	}{
		{``, true},
		{`,"tokenizer":"o200k"`, true},
		{`,"tokenizer":"cl100k"`, true},
		{`,"tokenizer":"none"`, true},
		{`,"tokenizer":"bogus"`, false},
		{`,"tokenizer":"O200K"`, false},
		{`,"tokenizer":" o200k"`, false},
		{`,"compaction_model_profile_id":"compactor-v2"`, true},
		{`,"compaction_model_profile_id":"` + strings.Repeat("p", 200) + `"`, true},
		{`,"compaction_model_profile_id":"has space"`, false},
		{`,"compaction_model_profile_id":" "`, false},
		{`,"compaction_model_profile_id":"` + strings.Repeat("p", 201) + `"`, false},
	} {
		var model ModelSpec
		err := json.Unmarshal([]byte(`{"base_url":"https://api.example.com/v1","model":"example",
"context_window":4096,"max_output_tokens":512`+test.field+`}`), &model)
		if err != nil {
			t.Fatalf("context field %s failed to decode: %v", test.field, err)
		}
		err = ValidateModelSpec(model)
		if test.valid && err != nil {
			t.Fatalf("valid context field %s was rejected: %v", test.field, err)
		}
		if !test.valid && err == nil {
			t.Fatalf("invalid context field accepted: %s", test.field)
		}
	}
}

func modelStringField(t *testing.T, model any, name string) string {
	t.Helper()
	field := reflect.ValueOf(model).FieldByName(name)
	if !field.IsValid() || field.Kind() != reflect.String {
		t.Fatalf("model is missing string field %s", name)
	}
	return field.String()
}
