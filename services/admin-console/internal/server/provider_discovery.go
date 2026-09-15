package server

import (
	"context"
	"encoding/json"
	"net/http"
	"strings"

	"soft/antnest-platform/services/admin-console/internal/principal"
	"soft/antnest-platform/services/admin-console/internal/providerdiscovery"
	"soft/antnest-platform/services/admin-console/internal/upstream"
)

type modelDiscoverySource struct {
	Models []providerdiscovery.Model `json:"models"`
}

type discoveryInput struct {
	ProviderKey string                  `json:"provider_key"`
	BaseURL     string                  `json:"base_url"`
	Credential  providerCredentialInput `json:"credential"`
}

func (h *handler) discoverProviderModels(w http.ResponseWriter, r *http.Request, actor principal.Principal) {
	w.Header().Set("Cache-Control", "no-store")
	result, ok := h.read(w, r, upstream.AgentController, http.MethodGet,
		providerConnectionPath(r)+"/access", organizationScopeQuery(actor.OrganizationID), nil)
	if !ok {
		return
	}
	if !successful(result.status) {
		h.writeProjected(w, r, upstream.AgentController, result, projectPayload[modelDiscoverySource])
		return
	}
	var access struct {
		Connection providerConnectionSource `json:"connection"`
		Credential providerCredentialInput  `json:"credential"`
	}
	if err := json.Unmarshal(result.body, &access); err != nil || access.Connection.ConnectionID != r.PathValue("connection_id") || !access.Connection.Enabled {
		writeError(w, http.StatusBadGateway, "invalid_upstream_response", "Provider access is invalid")
		return
	}
	h.discoverModels(w, r, discoveryInput{ProviderKey: access.Connection.ProviderKey, BaseURL: access.Connection.BaseURL, Credential: access.Credential})
}

func (h *handler) discoverDraftModels(w http.ResponseWriter, r *http.Request, _ principal.Principal) {
	var input discoveryInput
	if !decodeJSON(w, r, &input) {
		return
	}
	h.discoverModels(w, r, input)
}

func (h *handler) discoverModels(w http.ResponseWriter, r *http.Request, input discoveryInput) {
	w.Header().Set("Cache-Control", "no-store")
	if !providerdiscovery.Supports(input.ProviderKey) || input.Credential.Method != "api_key" || strings.TrimSpace(input.Credential.APIKey) == "" || strings.TrimSpace(input.BaseURL) == "" {
		writeError(w, http.StatusBadRequest, "invalid_request", "A supported provider, endpoint and API key are required")
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), h.requestTimeout)
	defer cancel()
	models, err := h.modelLister.ListModels(ctx, providerdiscovery.Connection{ProviderKey: input.ProviderKey, BaseURL: input.BaseURL}, input.Credential.APIKey)
	if err != nil {
		writeFailure(w, http.StatusBadGateway, "provider_discovery_failed", "The provider model list could not be fetched. Check the connection or try again.", err)
		return
	}
	if models == nil {
		models = []providerdiscovery.Model{}
	}
	writeJSON(w, http.StatusOK, modelDiscoverySource{Models: models})
}
