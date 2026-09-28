package server

import (
	"net/http"
	"strings"

	"soft/antnest-platform/services/agent-controller/internal/application"
	"soft/antnest-platform/services/agent-controller/internal/ports"
)

type legacySourceRecoveryRequest struct {
	OrganizationID   string `json:"organization_id"`
	ActorPrincipalID string `json:"actor_principal_id"`
}

type legacySourceRecoveryResponse struct {
	RequestID                  string `json:"request_id"`
	AgentID                    string `json:"agent_id"`
	State                      string `json:"state"`
	Phase                      string `json:"phase"`
	SourceRuntimeRevision      string `json:"source_runtime_revision"`
	ObservedRuntimeExecutionID string `json:"observed_runtime_execution_id"`
	ChildRequestID             string `json:"child_request_id,omitempty"`
	DisabledRuntimeRevision    string `json:"disabled_runtime_revision,omitempty"`
	ErrorCode                  string `json:"error_code,omitempty"`
	ManualReason               string `json:"manual_reason,omitempty"`
}

func legacySourceRecoveryPayload(record ports.LegacySourceRecoveryRecord) legacySourceRecoveryResponse {
	return legacySourceRecoveryResponse{RequestID: record.RequestID, AgentID: record.AgentID, State: record.State, Phase: record.Phase,
		SourceRuntimeRevision: record.SourceRuntimeRevision, ObservedRuntimeExecutionID: record.ObservedRuntimeExecutionID,
		ChildRequestID: record.ChildRequestID, DisabledRuntimeRevision: record.DisabledRuntimeRevision,
		ErrorCode: record.ErrorCode, ManualReason: record.ManualReason}
}

func (h *handler) recoverLegacySource(response http.ResponseWriter, request *http.Request) {
	if h.sourceRecovery == nil {
		writeError(response, http.StatusServiceUnavailable, "dependency_unavailable", "legacy source recovery is unavailable", true)
		return
	}
	requestID := strings.TrimSpace(request.Header.Get("Idempotency-Key"))
	if requestID == "" {
		writeError(response, http.StatusBadRequest, "invalid_request", "Idempotency-Key is required", false)
		return
	}
	var payload legacySourceRecoveryRequest
	if !decodeJSON(response, request, &payload) {
		return
	}
	record, err := h.sourceRecovery.RecoverLegacySource(request.Context(), application.LegacySourceRecoveryInput{
		RequestID: requestID, AgentID: request.PathValue("agent_id"), OrganizationID: payload.OrganizationID, ActorPrincipalID: payload.ActorPrincipalID})
	if err != nil {
		writeServiceError(request.Context(), response, err)
		return
	}
	status := http.StatusAccepted
	if record.State == "completed" {
		status = http.StatusOK
	}
	if record.State == "manual_recovery_required" {
		status = http.StatusConflict
	}
	writeJSON(response, status, legacySourceRecoveryPayload(record))
}
