package providerdiscovery

import (
	"encoding/json"
	"math"
)

type remotePricing struct {
	Prompt     json.Number `json:"prompt"`
	Completion json.Number `json:"completion"`
	CacheRead  json.Number `json:"input_cache_read"`
	CacheWrite json.Number `json:"input_cache_write"`
}

func modelPricing(values remotePricing) *Pricing {
	pricing := &Pricing{Currency: "USD",
		InputPerMillion: pricePerMillion(values.Prompt), OutputPerMillion: pricePerMillion(values.Completion),
		CacheReadPerMillion: pricePerMillion(values.CacheRead), CacheWritePerMillion: pricePerMillion(values.CacheWrite),
	}
	if pricing.InputPerMillion == nil || pricing.OutputPerMillion == nil {
		return nil
	}
	return pricing
}

func pricePerMillion(raw json.Number) *float64 {
	value, err := raw.Float64()
	value *= 1_000_000
	if err != nil || value < 0 || math.IsNaN(value) || math.IsInf(value, 0) {
		return nil
	}
	return &value
}
