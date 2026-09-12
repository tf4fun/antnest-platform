package domain

import (
	"bytes"
	"encoding/json"
	"fmt"
	"strings"
)

func (model *ModelSpec) UnmarshalJSON(data []byte) error {
	type wireModel ModelSpec
	var decoded wireModel
	if err := decodeModelJSON(data, &decoded); err != nil {
		return err
	}
	*model = ModelSpec(decoded)
	return nil
}

func (model *ModelParameters) UnmarshalJSON(data []byte) error {
	type wireParameters ModelParameters
	var decoded wireParameters
	if err := decodeModelJSON(data, &decoded); err != nil {
		return err
	}
	*model = ModelParameters(decoded)
	return nil
}

func decodeModelJSON(data []byte, target any) error {
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(target); err != nil {
		return err
	}
	return validatePricingPresence(data)
}

// Pointer decoding alone loses the distinction between omitted and null rates.
// Check JSON presence as well so persisted models and RPC use the same contract.
func validatePricingPresence(data []byte) error {
	var fields map[string]json.RawMessage
	if err := json.Unmarshal(data, &fields); err != nil {
		return err
	}
	for name := range fields {
		if name != "pricing" && strings.EqualFold(name, "pricing") {
			return fmt.Errorf("model pricing field must use canonical lowercase spelling")
		}
	}
	raw, present := fields["pricing"]
	if !present {
		return nil
	}
	var rates map[string]any
	if err := json.Unmarshal(raw, &rates); err != nil {
		return err
	}
	if rates == nil {
		return fmt.Errorf("pricing must be an object, not null")
	}
	for name, value := range rates {
		if value == nil {
			return fmt.Errorf("pricing %s must not be null", name)
		}
	}
	return nil
}
