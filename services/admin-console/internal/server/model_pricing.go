package server

import (
	"encoding/json"
	"errors"
	"fmt"
	"strings"
)

// This read projection validates the wire shape, not the owner's price selection.
// A value with omitzero distinguishes an absent price from an invalid explicit null.
type modelPricingSource struct {
	Currency             string   `json:"currency"`
	InputPerMillion      float64  `json:"input_per_million"`
	OutputPerMillion     float64  `json:"output_per_million"`
	CacheReadPerMillion  *float64 `json:"cache_read_per_million,omitempty"`
	CacheWritePerMillion *float64 `json:"cache_write_per_million,omitempty"`
}

func (price *modelPricingSource) UnmarshalJSON(data []byte) error {
	var fields map[string]json.RawMessage
	if err := json.Unmarshal(data, &fields); err != nil {
		return fmt.Errorf("decode model pricing: %w", err)
	}
	var currency string
	if err := json.Unmarshal(fields["currency"], &currency); err != nil || currency != "USD" {
		return errors.New("model pricing requires USD currency")
	}
	input, err := projectedModelRate(fields, "input_per_million", true)
	if err != nil {
		return err
	}
	output, err := projectedModelRate(fields, "output_per_million", true)
	if err != nil {
		return err
	}
	read, err := projectedModelRate(fields, "cache_read_per_million", false)
	if err != nil {
		return err
	}
	write, err := projectedModelRate(fields, "cache_write_per_million", false)
	if err != nil {
		return err
	}
	*price = modelPricingSource{Currency: currency, InputPerMillion: *input, OutputPerMillion: *output,
		CacheReadPerMillion: read, CacheWritePerMillion: write}
	return nil
}

func projectedModelRate(fields map[string]json.RawMessage, name string, required bool) (*float64, error) {
	raw, present := fields[name]
	if !present && !required {
		return nil, nil
	}
	var amount *float64
	// JSON decoding rejects nonnumeric, overflow, NaN and infinity values.
	if err := json.Unmarshal(raw, &amount); err != nil || amount == nil || *amount < 0 {
		return nil, fmt.Errorf("invalid model pricing field %s", name)
	}
	significand, _, _ := strings.Cut(strings.ToLower(string(raw)), "e")
	if *amount == 0 && strings.ContainsAny(significand, "123456789") {
		return nil, fmt.Errorf("model pricing field %s underflows", name)
	}
	return amount, nil
}
