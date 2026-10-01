package server

import (
	"context"
	"errors"
	"net/http"

	"github.com/tf4fun/antnest-platform/services/agent-controller/internal/application"
	"github.com/tf4fun/antnest-platform/services/agent-controller/internal/ports"
	"github.com/tf4fun/antnest-platform/services/agent-controller/internal/telemetry"
)

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
	revision, err := h.configuration.SetAgentAuthorization(request.Context(), input)
	if err != nil {
		writeAgentConfigurationError(request.Context(), response, err)
		return
	}
	writeJSON(response, http.StatusOK, struct {
		Revision int64 `json:"authorization_revision"`
	}{revision})
}

func writeAgentConfigurationError(ctx context.Context, response http.ResponseWriter, err error) {
	var status int
	var payload errorResponse
	switch {
	case errors.Is(err, ports.ErrConcurrentChange):
		status, payload = http.StatusConflict, errorResponse{Code: "configuration_conflict", Message: "Reload the Agent authorization before updating"}
	case errors.Is(err, application.ErrAccessDenied):
		status, payload = http.StatusForbidden, errorResponse{Code: "access_denied", Message: "Agent access is denied"}
	case errors.Is(err, context.DeadlineExceeded), errors.Is(err, context.Canceled):
		status, payload = http.StatusServiceUnavailable, errorResponse{Code: "dependency_unavailable", Message: "dependency is unavailable", Retryable: true}
	default:
		writeServiceError(ctx, response, err)
		return
	}
	telemetry.RecordBoundaryError(ctx, err, "dispatch", payload.Code, payload.Message, status >= 500)
	writeJSON(response, status, payload)
}
