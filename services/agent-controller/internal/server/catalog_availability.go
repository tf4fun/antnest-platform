package server

import (
	"net/http"

	"soft/antnest-platform/services/agent-controller/internal/application"
	"soft/antnest-platform/services/agent-controller/internal/ports"
)

type catalogAvailabilityRequest struct {
	RequestID       string `json:"request_id"`
	OrganizationID  string `json:"organization_id"`
	ExpectedEnabled *bool  `json:"expected_enabled"`
	Enabled         *bool  `json:"enabled"`
}

func (h *handler) setProviderAvailability(response http.ResponseWriter, request *http.Request) {
	h.setCatalogAvailability(response, request, ports.CatalogProvider, request.PathValue("connection_id"))
}

func (h *handler) setModelAvailability(response http.ResponseWriter, request *http.Request) {
	h.setCatalogAvailability(response, request, ports.CatalogModel, request.PathValue("model_profile_id"))
}

func (h *handler) setTemplateAvailability(response http.ResponseWriter, request *http.Request) {
	h.setCatalogAvailability(response, request, ports.CatalogTemplate, request.PathValue("template_id"))
}

func (h *handler) setCatalogAvailability(response http.ResponseWriter, request *http.Request, kind ports.CatalogResourceKind, id string) {
	var payload catalogAvailabilityRequest
	if !decodeJSON(response, request, &payload) {
		return
	}
	if payload.ExpectedEnabled == nil || payload.Enabled == nil {
		writeError(response, http.StatusBadRequest, "invalid_request", "expected_enabled and enabled must be explicit booleans", false)
		return
	}
	result, err := h.catalog.SetCatalogAvailability(request.Context(), application.SetCatalogAvailabilityInput{
		Kind: kind, ResourceID: id, OrganizationID: payload.OrganizationID, RequestID: payload.RequestID,
		ExpectedEnabled: *payload.ExpectedEnabled, Enabled: *payload.Enabled,
	})
	if err != nil {
		writeServiceError(request.Context(), response, err)
		return
	}
	writeJSON(response, http.StatusOK, result)
}
