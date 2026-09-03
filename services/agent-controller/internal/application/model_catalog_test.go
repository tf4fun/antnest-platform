package application

import (
	"testing"

	"soft/antnest-platform/services/agent-controller/internal/domain"
)

func TestBuiltinModelCatalogPublishesOnlySupportedOpenAICompatibleProviders(t *testing.T) {
	catalog := builtinModelCatalog()
	if catalog.Revision == "" {
		t.Fatal("catalog revision is empty")
	}
	if len(catalog.Providers) != 3 {
		t.Fatalf("providers = %d, want 3", len(catalog.Providers))
	}

	deepSeek := catalog.Providers[0]
	if deepSeek.ProviderKey != "deepseek" || deepSeek.Custom || deepSeek.BaseURL != "https://api.deepseek.com" {
		t.Fatalf("DeepSeek preset = %+v", deepSeek)
	}
	if len(deepSeek.Models) != 3 || deepSeek.Models[2].ModelID != "deepseek-v4-flash-vision-exp" ||
		!deepSeek.Models[2].SupportsImages {
		t.Fatalf("DeepSeek models = %+v", deepSeek.Models)
	}

	custom := catalog.Providers[2]
	if custom.ProviderKey != "openai-compatible" || !custom.Custom || custom.BaseURL != "" || len(custom.Models) != 0 {
		t.Fatalf("custom preset = %+v", custom)
	}
}

func TestCanonicalModelSpecUsesAuthorityMetadataForKnownModels(t *testing.T) {
	temperature := 0.4
	got := canonicalModelSpec(domain.ModelSpec{
		BaseURL:         "https://api.deepseek.com/",
		Model:           "deepseek-v4-pro",
		ContextWindow:   2048,
		MaxOutputTokens: 32,
		Temperature:     &temperature,
		SupportsImages:  true,
	})

	if got.BaseURL != "https://api.deepseek.com" || got.Model != "deepseek-v4-pro" ||
		got.ContextWindow != 1_000_000 || got.MaxOutputTokens != 384_000 || got.SupportsImages {
		t.Fatalf("canonical known model = %+v", got)
	}
	if got.Temperature == nil || *got.Temperature != temperature {
		t.Fatalf("temperature was not preserved: %+v", got.Temperature)
	}
}

func TestCanonicalModelSpecLeavesCustomCapabilitiesUnderAdministratorControl(t *testing.T) {
	want := domain.ModelSpec{
		BaseURL:         "https://models.example.com/v1",
		Model:           "company-model",
		ContextWindow:   96_000,
		MaxOutputTokens: 12_000,
		SupportsImages:  true,
	}
	got := canonicalModelSpec(want)
	if got != want {
		t.Fatalf("canonical custom model = %+v, want %+v", got, want)
	}
}
