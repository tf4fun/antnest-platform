package domain

import (
	"fmt"
	"math"
)

// ModelPricing is an optional, immutable model-revision value. Required rates
// use pointers so an omitted JSON number cannot silently become a free rate.
type ModelPricing struct {
	Currency             string   `json:"currency"`
	InputPerMillion      *float64 `json:"input_per_million"`
	OutputPerMillion     *float64 `json:"output_per_million"`
	CacheReadPerMillion  *float64 `json:"cache_read_per_million,omitempty"`
	CacheWritePerMillion *float64 `json:"cache_write_per_million,omitempty"`
}

func (pricing *ModelPricing) Validate() error {
	if pricing == nil {
		return nil
	}
	if pricing.Currency != "USD" || pricing.InputPerMillion == nil || pricing.OutputPerMillion == nil {
		return fmt.Errorf("pricing requires USD currency and both input_per_million and output_per_million")
	}
	for _, value := range []*float64{pricing.InputPerMillion, pricing.OutputPerMillion, pricing.CacheReadPerMillion, pricing.CacheWritePerMillion} {
		if value != nil && (*value < 0 || math.IsNaN(*value) || math.IsInf(*value, 0)) {
			return fmt.Errorf("pricing rates must be finite nonnegative numbers")
		}
	}
	return nil
}

func (pricing *ModelPricing) clone() *ModelPricing {
	if pricing == nil {
		return nil
	}
	return &ModelPricing{
		Currency:             pricing.Currency,
		InputPerMillion:      cloneFloat(pricing.InputPerMillion),
		OutputPerMillion:     cloneFloat(pricing.OutputPerMillion),
		CacheReadPerMillion:  cloneFloat(pricing.CacheReadPerMillion),
		CacheWritePerMillion: cloneFloat(pricing.CacheWritePerMillion),
	}
}

func cloneFloat(value *float64) *float64 {
	if value == nil {
		return nil
	}
	clone := *value
	return &clone
}
