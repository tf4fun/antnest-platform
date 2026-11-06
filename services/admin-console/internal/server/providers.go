package server

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"

	"github.com/tf4fun/antnest-platform/services/admin-console/internal/apierror"
	"github.com/tf4fun/antnest-platform/services/admin-console/internal/principal"
	"github.com/tf4fun/antnest-platform/services/admin-console/internal/upstream"
)

type providerCredentialInput struct {
	Method string `json:"method"`
	Secret string `json:"api_key"`
}

type providerModelInput struct {
	DisplayName string          `json:"display_name"`
	Model       json.RawMessage `json:"model"`
}

type createProviderInput struct {
	ProviderKey string                  `json:"provider_key"`
	DisplayName string                  `json:"display_name"`
	BaseURL     string                  `json:"base_url"`
	Credential  providerCredentialInput `json:"credential"`
	Models      []providerModelInput    `json:"models"`
}

type providerConnectionSource struct {
	ConnectionID       string `json:"connection_id"`
	ProviderKey        string `json:"provider_key"`
	DisplayName        string `json:"display_name"`
	BaseURL            string `json:"base_url"`
	CredentialMethod   string `json:"credential_method"`
	CredentialVersion  string `json:"credential_version"`
	CredentialRevision int64  `json:"credential_revision"`
	Enabled            bool   `json:"enabled"`
	CreatedAt          string `json:"created_at"`
	UpdatedAt          string `json:"updated_at"`
}

type providerConnectionListSource struct {
	Items       []providerConnectionSource `json:"items"`
	NextAfterID *string                    `json:"next_cursor"`
}

func (h *handler) registerProviderRoutes() {
	h.mux.HandleFunc("GET /api/admin/provider-connections", h.withPrincipal(h.listProviderConnections))
	h.mux.HandleFunc("POST /api/admin/provider-connections", h.withPrincipal(h.createProviderConnection))
	h.mux.HandleFunc("GET /api/admin/provider-connections/{connection_id}", h.withPrincipal(h.getProviderConnection))
	h.mux.HandleFunc("GET /api/admin/provider-connections/{connection_id}/models/discovery", h.withPrincipal(h.discoverProviderModels))
	h.mux.HandleFunc("POST /api/admin/provider-models/discovery", h.withPrincipal(h.discoverDraftModels))
	h.mux.HandleFunc("POST /api/admin/provider-connections/{connection_id}/credentials", h.withPrincipal(h.rotateProviderCredential))
}

func (h *handler) listProviderConnections(w http.ResponseWriter, r *http.Request, actor principal.Principal) {
	query, ok := catalogListQuery(w, r, actor.OrganizationID)
	if !ok {
		return
	}
	h.forwardProjected(w, r, upstream.AgentController, http.MethodGet,
		"/internal/provider-connections", query, nil, func(body []byte) ([]byte, error) {
			canonical, err := canonicalPage(body, "items", "next_after_id", false)
			if err != nil {
				return nil, err
			}
			var page providerConnectionListSource
			if err := json.Unmarshal(canonical, &page); err != nil || page.Items == nil {
				return nil, fmt.Errorf("invalid provider inventory")
			}
			return encodeBrowserResponse(page)
		})
}

func (h *handler) getProviderConnection(w http.ResponseWriter, r *http.Request, actor principal.Principal) {
	h.forwardProjected(w, r, upstream.AgentController, http.MethodGet,
		providerConnectionPath(r), organizationScopeQuery(actor.OrganizationID), nil, projectPayload[providerConnectionSource])
}

func (h *handler) createProviderConnection(w http.ResponseWriter, r *http.Request, actor principal.Principal) {
	var input createProviderInput
	if !decodeJSON(w, r, &input) {
		return
	}
	if !required(input.ProviderKey, input.DisplayName, input.BaseURL, input.Credential.Method, input.Credential.Secret) || input.Models == nil {
		writeError(w, http.StatusBadRequest, apierror.InvalidRequest, "Provider connection fields and a models array are required")
		return
	}
	requestID, ok := commandRequestID(w, r, actor.OrganizationID, "provider-connect")
	if !ok {
		return
	}
	models := make([]map[string]any, 0, len(input.Models))
	for index, model := range input.Models {
		if err := validateModelContextMetadata(model.Model); err != nil {
			writeError(w, http.StatusBadRequest, apierror.InvalidRequest, "Invalid Model context metadata")
			return
		}
		models = append(models, map[string]any{"profile_key": fmt.Sprintf("%s-%d", requestID, index),
			"display_name": model.DisplayName, "model": model.Model})
	}
	h.forwardProjectedJSON(w, r, upstream.AgentController, http.MethodPost, "/internal/provider-connections", "", map[string]any{
		"request_id": requestID, "organization_id": actor.OrganizationID,
		"provider_key": input.ProviderKey, "display_name": input.DisplayName, "base_url": input.BaseURL,
		"credential": input.Credential, "models": models,
	}, projectPayload[providerConnectionSource])
}

type rotateProviderCredentialInput struct {
	ExpectedVersion string                  `json:"expected_version"`
	Credential      providerCredentialInput `json:"credential"`
}

func (h *handler) rotateProviderCredential(w http.ResponseWriter, r *http.Request, actor principal.Principal) {
	var input rotateProviderCredentialInput
	if !decodeJSON(w, r, &input) {
		return
	}
	if !required(input.ExpectedVersion, input.Credential.Method, input.Credential.Secret) {
		writeError(w, http.StatusBadRequest, apierror.InvalidRequest, "Credential and its expected version are required")
		return
	}
	requestID, ok := commandRequestID(w, r, actor.OrganizationID, "provider-credential")
	if !ok {
		return
	}
	h.forwardProjectedJSON(w, r, upstream.AgentController, http.MethodPost, providerConnectionPath(r)+"/credentials", "", map[string]any{
		"request_id": requestID, "organization_id": actor.OrganizationID,
		"expected_version": input.ExpectedVersion, "credential": input.Credential,
	}, projectPayload[providerConnectionSource])
}

func providerConnectionPath(r *http.Request) string {
	return "/internal/provider-connections/" + url.PathEscape(r.PathValue("connection_id"))
}
