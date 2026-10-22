package server

import (
	"context"
	"net/http"

	"github.com/tf4fun/antnest-platform/modules/service-authentication/serviceauth"
	"github.com/tf4fun/antnest-platform/services/agent-controller/internal/application"
)

type runtimeBarrierManualRecoveryService interface {
	RecoverRuntimeBarrier(context.Context, application.RuntimeBarrierManualRecoveryInput) (application.RebuildAgentResult, error)
}

func (h *handler) recoverRuntimeBarrier(response http.ResponseWriter, request *http.Request, payload rebuildAgentRequest) {
	// This is reached only through the existing administrator-authenticated
	// Rebuild route, including when the original recovery is replayed.
	var recovery struct {
		BarrierID               string `json:"barrier_id"`
		ExpectedRuntimeRevision string `json:"expected_runtime_revision"`
	}
	if err := serviceauth.DecodeObject(payload.Recovery, &recovery); err != nil {
		writeError(response, http.StatusBadRequest, "invalid_request", "recovery request is invalid", false)
		return
	}
	input := application.RuntimeBarrierManualRecoveryInput{
		Command: application.RebuildAgentInput{
			RequestID: payload.RequestID, OrganizationID: payload.OrganizationID,
			ActorPrincipalID: payload.ActorPrincipalID, AgentID: request.PathValue("agent_id"),
			TemplateID: payload.TemplateID, TemplateRevision: payload.TemplateRevision,
		},
		BarrierID: recovery.BarrierID, ExpectedRuntimeRevision: recovery.ExpectedRuntimeRevision,
	}
	if err := input.Validate(); err != nil {
		writeServiceError(request.Context(), response, err)
		return
	}
	service, ok := h.lifecycle.(runtimeBarrierManualRecoveryService)
	if !ok {
		writeServiceError(request.Context(), response, application.ErrDependencyUnavailable)
		return
	}
	result, err := service.RecoverRuntimeBarrier(request.Context(), input)
	observeLifecycleResult(request.Context(), result.Operation)
	if err != nil {
		writeServiceError(request.Context(), response, err)
		return
	}
	writeJSON(response, http.StatusAccepted, operationPayload(result.Operation))
}
