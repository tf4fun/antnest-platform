package providerdiscovery

import "context"

type Connection struct {
	ProviderKey string
	BaseURL     string
}

type Model struct {
	ModelID         string   `json:"model_id"`
	DisplayName     string   `json:"display_name"`
	ContextWindow   *int     `json:"context_window,omitempty"`
	MaxOutputTokens *int     `json:"max_output_tokens,omitempty"`
	SupportsImages  *bool    `json:"supports_images,omitempty"`
	Pricing         *Pricing `json:"pricing,omitempty"`
}

type Pricing struct {
	Currency             string   `json:"currency"`
	InputPerMillion      *float64 `json:"input_per_million"`
	OutputPerMillion     *float64 `json:"output_per_million"`
	CacheReadPerMillion  *float64 `json:"cache_read_per_million,omitempty"`
	CacheWritePerMillion *float64 `json:"cache_write_per_million,omitempty"`
}

type Lister interface {
	ListModels(context.Context, Connection, string) ([]Model, error)
}

func Supports(providerKey string) bool {
	switch providerKey {
	case "deepseek", "openrouter", "openai_compatible":
		return true
	default:
		return false
	}
}
