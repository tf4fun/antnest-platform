package server

import (
	"context"
	"net/http"

	"github.com/tf4fun/antnest-platform/services/agent-controller/internal/application"
)

type ProviderService interface {
	ResolveProviderAccess(context.Context, string, string) (application.ProviderAccess, error)
	CreateProviderConnection(context.Context, application.CreateProviderConnectionInput) (application.ProviderConnectionView, error)
	RotateProviderCredential(context.Context, application.RotateProviderCredentialInput) (application.ProviderConnectionView, error)
	GetProviderConnection(context.Context, string, string) (application.ProviderConnectionView, error)
	ListProviderConnections(context.Context, application.ListCatalogInput) (application.ProviderConnectionPage, error)
}

func (h *handler) resolveProviderAccess(response http.ResponseWriter, request *http.Request) {
	organizationID, ok := requiredOrganizationQuery(response, request)
	if !ok {
		return
	}
	view, err := h.catalog.ResolveProviderAccess(request.Context(), organizationID, request.PathValue("connection_id"))
	if err != nil {
		writeServiceError(request.Context(), response, err)
		return
	}
	response.Header().Set("Cache-Control", "no-store")
	writeJSON(response, http.StatusOK, view)
}

type createProviderConnectionRequest struct {
	RequestID      string                              `json:"request_id"`
	OrganizationID string                              `json:"organization_id"`
	ProviderKey    string                              `json:"provider_key"`
	DisplayName    string                              `json:"display_name"`
	BaseURL        string                              `json:"base_url"`
	Credential     application.ProviderCredentialInput `json:"credential"`
	Models         []application.ProviderModelInput    `json:"models"`
}

type rotateProviderCredentialRequest struct {
	RequestID       string                              `json:"request_id"`
	OrganizationID  string                              `json:"organization_id"`
	ExpectedVersion string                              `json:"expected_version"`
	Credential      application.ProviderCredentialInput `json:"credential"`
}

func (h *handler) createProviderConnection(response http.ResponseWriter, request *http.Request) {
	var payload createProviderConnectionRequest
	if !decodeJSON(response, request, &payload) {
		return
	}
	view, err := h.catalog.CreateProviderConnection(request.Context(), application.CreateProviderConnectionInput{
		RequestID: payload.RequestID, OrganizationID: payload.OrganizationID, ProviderKey: payload.ProviderKey,
		DisplayName: payload.DisplayName, BaseURL: payload.BaseURL, Credential: payload.Credential, Models: payload.Models,
	})
	if err != nil {
		writeServiceError(request.Context(), response, err)
		return
	}
	writeJSON(response, http.StatusCreated, view)
}

func (h *handler) rotateProviderCredential(response http.ResponseWriter, request *http.Request) {
	var payload rotateProviderCredentialRequest
	if !decodeJSON(response, request, &payload) {
		return
	}
	view, err := h.catalog.RotateProviderCredential(request.Context(), application.RotateProviderCredentialInput{
		RequestID: payload.RequestID, OrganizationID: payload.OrganizationID,
		ConnectionID: request.PathValue("connection_id"), ExpectedVersion: payload.ExpectedVersion, Credential: payload.Credential,
	})
	if err != nil {
		writeServiceError(request.Context(), response, err)
		return
	}
	writeJSON(response, http.StatusCreated, view)
}

func (h *handler) getProviderConnection(response http.ResponseWriter, request *http.Request) {
	organizationID, ok := requiredOrganizationQuery(response, request)
	if !ok {
		return
	}
	view, err := h.catalog.GetProviderConnection(request.Context(), organizationID, request.PathValue("connection_id"))
	if err != nil {
		writeServiceError(request.Context(), response, err)
		return
	}
	writeJSON(response, http.StatusOK, view)
}

func (h *handler) listProviderConnections(response http.ResponseWriter, request *http.Request) {
	input, ok := catalogListInput(response, request)
	if !ok {
		return
	}
	page, err := h.catalog.ListProviderConnections(request.Context(), input)
	if err != nil {
		writeServiceError(request.Context(), response, err)
		return
	}
	writeJSON(response, http.StatusOK, page)
}
