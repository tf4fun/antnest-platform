package server

import (
	"net/http"
	"testing"
)

func TestBuiltinCatalogIsConsoleOwned(t *testing.T) {
	backend := newBackendStub()
	response := requestAdmin(t, newTestHandler(t, backend), http.MethodGet, "/api/admin/model-catalog", "")
	if len(backend.calls) != 0 {
		t.Fatalf("builtin defaults requested a downstream service: %+v", backend.calls)
	}
	if response.Code != http.StatusOK {
		t.Fatalf("status=%d body=%s", response.Code, response.Body.String())
	}
	var catalog modelCatalogSource
	decodeBytes(t, response.Body.Bytes(), &catalog)
	if catalog.Revision == "" || len(catalog.Providers) != 2 || catalog.Providers[0].ProviderKey != "deepseek" {
		t.Fatalf("expected DeepSeek and OpenRouter defaults: %+v", catalog)
	}
	router := catalog.Providers[1]
	if router.ProviderKey != "openrouter" || router.BaseURL != "https://openrouter.ai/api/v1" || len(router.Models) != 2 || router.Models[0].ModelID != "openai/gpt-4o-mini" {
		t.Fatalf("incomplete OpenRouter preset: %+v", router)
	}
	provider := catalog.Providers[0]
	if provider.Custom || provider.BaseURL != "https://api.deepseek.com" || len(provider.Models) == 0 {
		t.Fatalf("incomplete provider preset: %+v", provider)
	}
	for _, model := range provider.Models {
		if model.ModelID == "" || model.ContextWindow < 1024 || model.MaxOutputTokens < 1 || model.Pricing.Currency != "USD" {
			t.Fatalf("incomplete model preset: %+v", model)
		}
	}
}

func TestBuiltinCatalogReturnsIndependentDefaults(t *testing.T) {
	first := builtinModelCatalog()
	first.Providers[0].Models[0].ContextWindow = 2048
	first.Providers[0].Models[2].SupportsImages = false
	*first.Providers[0].Models[0].Pricing.CacheReadPerMillion = 99
	next := builtinModelCatalog()
	if next.Providers[0].Models[0].ContextWindow != 1_000_000 ||
		!next.Providers[0].Models[2].SupportsImages ||
		*next.Providers[0].Models[0].Pricing.CacheReadPerMillion != 0.014 {
		t.Fatal("a response changed subsequent defaults")
	}
}
