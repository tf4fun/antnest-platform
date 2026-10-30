package server

import (
	"context"
	"fmt"
	"net/http"
	"strings"

	"github.com/tf4fun/antnest-platform/services/agent-controller/internal/application"
)

type lifecycleReliabilityService interface {
	CancelLifecycleOperation(context.Context, application.CancelLifecycleOperationInput) (application.OperationView, error)
	ClearLifecycleQuarantine(context.Context, application.ClearLifecycleQuarantineInput) (application.AgentView, error)
}

func (h *handler) lifecycleReliability() (lifecycleReliabilityService, error) {
	service, ok := h.lifecycle.(lifecycleReliabilityService)
	if !ok {
		return nil, fmt.Errorf("%w: lifecycle reliability", application.ErrDependencyUnavailable)
	}
	return service, nil
}

type cancelLifecycleOperationRequest struct {
	OrganizationID     string `json:"organization_id"`
	ActorPrincipalID   string `json:"actor_principal_id"`
	OperationRequestID string `json:"operation_request_id"`
}

func (h *handler) cancelLifecycleOperation(response http.ResponseWriter, request *http.Request) {
	service, err := h.lifecycleReliability()
	if err != nil {
		writeServiceError(request.Context(), response, err)
		return
	}
	var payload cancelLifecycleOperationRequest
	if !decodeJSON(response, request, &payload) {
		return
	}
	if strings.TrimSpace(payload.OrganizationID) == "" || strings.TrimSpace(payload.ActorPrincipalID) == "" ||
		strings.TrimSpace(payload.OperationRequestID) == "" {
		writeError(response, http.StatusBadRequest, "invalid_request", "organization, actor and operation request are required", false)
		return
	}
	result, err := service.CancelLifecycleOperation(request.Context(), application.CancelLifecycleOperationInput{
		OrganizationID: payload.OrganizationID, ActorPrincipalID: payload.ActorPrincipalID,
		AgentID: request.PathValue("agent_id"), OperationRequestID: payload.OperationRequestID,
	})
	if err != nil {
		writeServiceError(request.Context(), response, err)
		return
	}
	writeJSON(response, http.StatusAccepted, operationPayload(result))
}

type clearLifecycleQuarantineRequest struct {
	OrganizationID            string `json:"organization_id"`
	ActorPrincipalID          string `json:"actor_principal_id"`
	ExpectedAggregateSequence int64  `json:"expected_aggregate_sequence"`
}

func (h *handler) clearLifecycleQuarantine(response http.ResponseWriter, request *http.Request) {
	service, err := h.lifecycleReliability()
	if err != nil {
		writeServiceError(request.Context(), response, err)
		return
	}
	var payload clearLifecycleQuarantineRequest
	if !decodeJSON(response, request, &payload) {
		return
	}
	if strings.TrimSpace(payload.OrganizationID) == "" || strings.TrimSpace(payload.ActorPrincipalID) == "" {
		writeError(response, http.StatusBadRequest, "invalid_request", "organization and actor are required", false)
		return
	}
	agent, err := service.ClearLifecycleQuarantine(request.Context(), application.ClearLifecycleQuarantineInput{
		OrganizationID: payload.OrganizationID, ActorPrincipalID: payload.ActorPrincipalID,
		AgentID: request.PathValue("agent_id"), ExpectedAggregateSequence: payload.ExpectedAggregateSequence,
	})
	if err != nil {
		writeServiceError(request.Context(), response, err)
		return
	}
	writeJSON(response, http.StatusOK, agentPayload(agent))
}
