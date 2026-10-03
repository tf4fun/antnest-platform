package ports

import (
	"context"
	"errors"
)

var (
	ErrProviderEndpointForbidden   = errors.New("provider_endpoint_forbidden")
	ErrProviderEndpointUnavailable = errors.New("provider_endpoint_unavailable")
	ErrProviderDiscoveryFailed     = errors.New("provider_discovery_failed")
)

type ProviderEndpointValidator interface {
	ValidateEndpoint(context.Context, string) error
}

type ProviderDiscoveryConnection struct {
	ProviderKey string
	BaseURL     string
}

type DiscoveredModel struct {
	ModelID         string             `json:"model_id"`
	DisplayName     string             `json:"display_name"`
	ContextWindow   *int               `json:"context_window,omitempty"`
	MaxOutputTokens *int               `json:"max_output_tokens,omitempty"`
	SupportsImages  *bool              `json:"supports_images,omitempty"`
	Pricing         *DiscoveredPricing `json:"pricing,omitempty"`
}

type DiscoveredPricing struct {
	Currency             string   `json:"currency"`
	InputPerMillion      *float64 `json:"input_per_million"`
	OutputPerMillion     *float64 `json:"output_per_million"`
	CacheReadPerMillion  *float64 `json:"cache_read_per_million,omitempty"`
	CacheWritePerMillion *float64 `json:"cache_write_per_million,omitempty"`
}

type ProviderModelLister interface {
	ListModels(context.Context, ProviderDiscoveryConnection, string) ([]DiscoveredModel, error)
}
