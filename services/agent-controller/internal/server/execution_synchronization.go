package server

import "net/http"

func (h *handler) getExecutionSynchronization(response http.ResponseWriter, request *http.Request) {
	response.Header().Set("Cache-Control", "no-store")
	query, ok := strictQuery(response, request, map[string]struct{}{"organization_id": {}})
	if !ok {
		return
	}
	view, err := h.configuration.GetExecutionSynchronization(request.Context(), query.Get("organization_id"))
	if err != nil {
		writeAgentConfigurationError(request.Context(), response, err)
		return
	}
	writeJSON(response, http.StatusOK, view)
}
