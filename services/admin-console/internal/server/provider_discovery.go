package server

import (
	"encoding/json"
	"errors"
	"net/http"
	"strings"

	"github.com/tf4fun/antnest-platform/services/admin-console/internal/principal"
	"github.com/tf4fun/antnest-platform/services/admin-console/internal/upstream"
)

type discoveredModelSource struct {
	ModelID         string              `json:"model_id"`
	DisplayName     string              `json:"display_name"`
	ContextWindow   *int                `json:"context_window,omitempty"`
	MaxOutputTokens *int                `json:"max_output_tokens,omitempty"`
	SupportsImages  *bool               `json:"supports_images,omitempty"`
	Pricing         *modelPricingSource `json:"pricing,omitempty"`
}
type modelDiscoverySource struct {
	Models []discoveredModelSource `json:"models"`
}
type discoveryInput struct {
	ProviderKey string                  `json:"provider_key"`
	BaseURL     string                  `json:"base_url"`
	Credential  providerCredentialInput `json:"credential"`
}

func (h *handler) discoverProviderModels(w http.ResponseWriter, r *http.Request, actor principal.Principal) {
	h.proxyDiscovery(w, r, providerConnectionPath(r)+"/discover-models", map[string]any{"organization_id": actor.OrganizationID})
}

func (h *handler) discoverDraftModels(w http.ResponseWriter, r *http.Request, actor principal.Principal) {
	var input discoveryInput
	if !decodeJSON(w, r, &input) {
		return
	}
	if (input.ProviderKey != "deepseek" && input.ProviderKey != "openrouter" && input.ProviderKey != "openai_compatible") ||
		input.Credential.Method != "api_key" || strings.TrimSpace(input.Credential.Secret) == "" || strings.TrimSpace(input.BaseURL) == "" {
		writeError(w, http.StatusBadRequest, "invalid_request", "A supported provider, endpoint and API key are required")
		return
	}
	h.proxyDiscovery(w, r, "/internal/provider-discovery/draft", map[string]any{
		"organization_id": actor.OrganizationID, "provider_key": input.ProviderKey, "base_url": input.BaseURL, "credential": input.Credential,
	})
}

func (h *handler) proxyDiscovery(w http.ResponseWriter, r *http.Request, path string, input any) {
	body, err := json.Marshal(input)
	if err != nil {
		writeError(w, 500, "encoding_failed", "Request could not be encoded")
		return
	}
	result, ok := h.read(w, r, upstream.AgentController, http.MethodPost, path, "", body)
	if !ok {
		return
	}
	if !successful(result.status) {
		writeDiscoveryFailure(w, result)
		return
	}
	h.writeProjected(w, r, upstream.AgentController, result, projectDiscoveredModels)
}

func projectDiscoveredModels(body []byte) ([]byte, error) {
	var source modelDiscoverySource
	if err := json.Unmarshal(body, &source); err != nil {
		return nil, err
	}
	if source.Models == nil {
		return nil, errors.New("model list is required")
	}
	for _, model := range source.Models {
		if strings.TrimSpace(model.ModelID) == "" || strings.TrimSpace(model.DisplayName) == "" ||
			model.ContextWindow != nil && *model.ContextWindow < 1 || model.MaxOutputTokens != nil && *model.MaxOutputTokens < 1 {
			return nil, errors.New("invalid discovered model metadata")
		}
	}
	return encodeBrowserResponse(source)
}

func writeDiscoveryFailure(w http.ResponseWriter, result bufferedResponse) {
	// Never relay a raw Controller/transport error body. Browser errors retain
	// bounded, service-owned code/message fields and their normal status.
	var envelope struct {
		Code string `json:"code"`
	}
	if json.Unmarshal(result.body, &envelope) == nil {
		if failure, exists := discoveryFailures[envelope.Code]; exists && failure.status == result.status {
			writeError(w, failure.status, envelope.Code, failure.message)
			return
		}
	}
	writeError(w, http.StatusBadGateway, "provider_discovery_failed", "The provider model list could not be fetched. Check the connection or try again.")
}

var discoveryFailures = map[string]struct {
	status  int
	message string
}{
	"provider_endpoint_forbidden":     {422, "Provider endpoint is forbidden"},
	"provider_endpoint_unavailable":   {503, "Provider endpoint is unavailable"},
	"provider_discovery_failed":       {502, "The provider model list could not be fetched. Check the connection or try again."},
	"reference_not_found":             {404, "Provider connection was not found"},
	"reference_disabled":              {409, "Provider connection is disabled"},
	"organization_mismatch":           {403, "Organization differs from verified caller"},
	"actor_mismatch":                  {403, "Actor differs from verified caller"},
	"access_denied":                   {403, "Access is denied"},
	"forbidden":                       {403, "Administrator access is required"},
	"invalid_request":                 {400, "Discovery request is invalid"},
	"caller_context_required":         {401, "Verified caller context is required"},
	"caller_context_invalid":          {401, "Verified caller context is invalid"},
	"identity_dependency_unavailable": {503, "Identity verification is unavailable"},
	"dependency_unavailable":          {503, "A platform service is unavailable"},
}
