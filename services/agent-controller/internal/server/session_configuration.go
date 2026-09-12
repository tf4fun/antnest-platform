package server

import (
	"net/http"

	"soft/antnest-platform/services/agent-controller/internal/application"
)

func (h *handler) getSessionConfiguration(response http.ResponseWriter, request *http.Request) {
	response.Header().Set("Cache-Control", "no-store")
	var input application.SessionConfigurationInput
	if !decodeJSON(response, request, &input) {
		return
	}
	result, err := h.runs.GetSessionConfiguration(request.Context(), input)
	if err != nil {
		writeRunError(request.Context(), response, err)
		return
	}
	writeJSON(response, http.StatusOK, result)
}

func (h *handler) setAgentAuthorization(response http.ResponseWriter, request *http.Request) {
	response.Header().Set("Cache-Control", "no-store")
	var input application.SetAgentAuthorizationInput
	if !decodeJSON(response, request, &input) {
		return
	}
	if input.Authorization.ToolRules == nil {
		writeError(response, http.StatusBadRequest, "invalid_request", "authorization.tool_rules must be an array", false)
		return
	}
	revision, err := h.runs.SetAgentAuthorization(request.Context(), input)
	if err != nil {
		writeRunError(request.Context(), response, err)
		return
	}
	writeJSON(response, http.StatusOK, struct {
		Revision int64 `json:"authorization_revision"`
	}{revision})
}
