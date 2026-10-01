package server

import (
	"net/http"

	"github.com/tf4fun/antnest-platform/services/admin-console/internal/principal"
)

// Defaults are copied into an administrator's draft, never applied to stored configuration.
func (h *handler) modelCatalog(response http.ResponseWriter, _ *http.Request, _ principal.Principal) {
	writeJSON(response, http.StatusOK, builtinModelCatalog())
}

func builtinModelCatalog() modelCatalogSource {
	return modelCatalogSource{
		Revision: "2026-09-15-console",
		Providers: []modelProviderPresetSource{{
			ProviderKey: "deepseek", DisplayName: "DeepSeek",
			Description: "DeepSeek API", BaseURL: "https://api.deepseek.com",
			Models: []modelCatalogEntrySource{
				deepSeekPreset("deepseek-v4-flash", "DeepSeek V4 Flash", false, 0.44, 1.32, 0.014),
				deepSeekPreset("deepseek-v4-pro", "DeepSeek V4 Pro", false, 1.32, 3.96, 0.044),
				deepSeekPreset("deepseek-v4-flash-vision-exp", "DeepSeek V4 Flash Vision", true, 0.44, 1.32, 0.014),
			},
		}, {
			ProviderKey: "openrouter", DisplayName: "OpenRouter",
			Description: "OpenRouter API", BaseURL: "https://openrouter.ai/api/v1",
			Models: []modelCatalogEntrySource{
				openRouterPreset("openai/gpt-4o-mini", "GPT-4o mini", 128_000, 16_384, true, 0.15, 0.6, 0.075),
				openRouterPreset("qwen/qwen3-coder", "Qwen3 Coder", 262_144, 65_536, false, 0.3, 1, 0.1),
			},
		}},
	}
}

func openRouterPreset(id, name string, context, outputTokens int, images bool, input, output, cacheRead float64) modelCatalogEntrySource {
	return modelCatalogEntrySource{
		ModelID: id, DisplayName: name, ContextWindow: context, MaxOutputTokens: outputTokens, SupportsImages: images,
		Pricing: modelPricingSource{Currency: "USD", InputPerMillion: input, OutputPerMillion: output, CacheReadPerMillion: &cacheRead},
	}
}

// Snapshot values and source links are documented in docs/model-pricing.md.
func deepSeekPreset(id, name string, images bool, input, output, cacheRead float64) modelCatalogEntrySource {
	return modelCatalogEntrySource{
		ModelID: id, DisplayName: name,
		ContextWindow: 1_000_000, MaxOutputTokens: 384_000, SupportsImages: images,
		Pricing: modelPricingSource{Currency: "USD", InputPerMillion: input, OutputPerMillion: output, CacheReadPerMillion: &cacheRead},
	}
}
