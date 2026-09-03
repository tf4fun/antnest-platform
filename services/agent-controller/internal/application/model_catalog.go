package application

import (
	"context"
	"strings"

	"soft/antnest-platform/services/agent-controller/internal/domain"
)

const modelCatalogRevision = "2026-09-03"

type ModelCatalogView struct {
	Revision  string                    `json:"revision"`
	Providers []ModelProviderPresetView `json:"providers"`
}

type ModelProviderPresetView struct {
	ProviderKey string                  `json:"provider_key"`
	DisplayName string                  `json:"display_name"`
	Description string                  `json:"description"`
	BaseURL     string                  `json:"base_url"`
	Custom      bool                    `json:"custom"`
	Models      []ModelCatalogEntryView `json:"models"`
}

type ModelCatalogEntryView struct {
	ModelID         string `json:"model_id"`
	DisplayName     string `json:"display_name"`
	ContextWindow   int    `json:"context_window"`
	MaxOutputTokens int    `json:"max_output_tokens"`
	SupportsImages  bool   `json:"supports_images"`
}

// ModelCatalog returns the model metadata supported by the current
// OpenAI-compatible execution adapter. It is configuration authority, not a
// discovery result from credentials owned by an organization.
func (service *CatalogService) ModelCatalog(context.Context) ModelCatalogView {
	return builtinModelCatalog()
}

func builtinModelCatalog() ModelCatalogView {
	return ModelCatalogView{
		Revision: modelCatalogRevision,
		Providers: []ModelProviderPresetView{
			{
				ProviderKey: "deepseek",
				DisplayName: "DeepSeek",
				Description: "DeepSeek's official OpenAI-compatible API",
				BaseURL:     "https://api.deepseek.com",
				Models: []ModelCatalogEntryView{
					newModelCatalogEntry("deepseek-v4-flash", "DeepSeek V4 Flash", 1_000_000, 384_000, false),
					newModelCatalogEntry("deepseek-v4-pro", "DeepSeek V4 Pro", 1_000_000, 384_000, false),
					newModelCatalogEntry("deepseek-v4-flash-vision-exp", "DeepSeek V4 Flash Vision", 1_000_000, 384_000, true),
				},
			},
			{
				ProviderKey: "openai",
				DisplayName: "OpenAI",
				Description: "OpenAI Chat Completions API",
				BaseURL:     "https://api.openai.com/v1",
				Models: []ModelCatalogEntryView{
					newModelCatalogEntry("gpt-4.1", "GPT-4.1", 1_047_576, 32_768, true),
					newModelCatalogEntry("gpt-4.1-mini", "GPT-4.1 mini", 1_047_576, 32_768, true),
					newModelCatalogEntry("gpt-4.1-nano", "GPT-4.1 nano", 1_047_576, 32_768, true),
					newModelCatalogEntry("gpt-4o", "GPT-4o", 128_000, 16_384, true),
					newModelCatalogEntry("gpt-4o-mini", "GPT-4o mini", 128_000, 16_384, true),
				},
			},
			{
				ProviderKey: "openai-compatible",
				DisplayName: "Custom API",
				Description: "Ollama, an internal gateway, or another OpenAI-compatible endpoint",
				Custom:      true,
				Models:      []ModelCatalogEntryView{},
			},
		},
	}
}

func newModelCatalogEntry(
	modelID string,
	displayName string,
	contextWindow int,
	maxOutputTokens int,
	supportsImages bool,
) ModelCatalogEntryView {
	return ModelCatalogEntryView{
		ModelID: modelID, DisplayName: displayName,
		ContextWindow: contextWindow, MaxOutputTokens: maxOutputTokens,
		SupportsImages: supportsImages,
	}
}

func canonicalModelSpec(input domain.ModelSpec) domain.ModelSpec {
	for _, provider := range builtinModelCatalog().Providers {
		if provider.Custom || !knownProviderEndpoint(provider, input.BaseURL) {
			continue
		}
		for _, model := range provider.Models {
			if model.ModelID != strings.TrimSpace(input.Model) {
				continue
			}
			return domain.ModelSpec{
				BaseURL: provider.BaseURL, Model: model.ModelID,
				ContextWindow: model.ContextWindow, MaxOutputTokens: model.MaxOutputTokens,
				Temperature: input.Temperature, SupportsImages: model.SupportsImages,
			}
		}
	}
	return input
}

func knownProviderEndpoint(provider ModelProviderPresetView, candidate string) bool {
	normalized := strings.TrimRight(strings.TrimSpace(candidate), "/")
	if normalized == provider.BaseURL {
		return true
	}
	return provider.ProviderKey == "deepseek" && normalized == provider.BaseURL+"/v1"
}
