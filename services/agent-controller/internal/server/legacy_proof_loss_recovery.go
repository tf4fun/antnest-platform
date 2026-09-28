package server

import (
	"net/http"
	"strings"

	"soft/antnest-platform/services/agent-controller/internal/application"
	"soft/antnest-platform/services/agent-controller/internal/ports"
)

type legacyProofLossRecoveryRequest struct {
	OrganizationID           string `json:"organization_id"`
	ActorPrincipalID         string `json:"actor_principal_id"`
	FailedMigrationRequestID string `json:"failed_migration_request_id"`
}

type legacyProofLossRecoveryResponse struct {
	RequestID                string `json:"request_id"`
	AgentID                  string `json:"agent_id"`
	FailedMigrationRequestID string `json:"failed_migration_request_id"`
	State                    string `json:"state"`
	Phase                    string `json:"phase"`
	TargetRuntimeRevision    string `json:"target_runtime_revision"`
	ChildRequestID           string `json:"child_request_id"`
	DisabledRuntimeRevision  string `json:"disabled_runtime_revision,omitempty"`
	ErrorCode                string `json:"error_code,omitempty"`
	ManualReason             string `json:"manual_reason,omitempty"`
}

func legacyProofLossRecoveryPayload(record ports.LegacyProofLossRecoveryRecord) legacyProofLossRecoveryResponse {
	return legacyProofLossRecoveryResponse{RequestID: record.RequestID, AgentID: record.AgentID, FailedMigrationRequestID: record.FailedMigrationRequestID,
		State: record.State, Phase: record.Phase, TargetRuntimeRevision: record.TargetRuntimeRevision, ChildRequestID: record.ChildRequestID,
		DisabledRuntimeRevision: record.DisabledRuntimeRevision, ErrorCode: record.ErrorCode, ManualReason: record.ManualReason}
}

func (h *handler) recoverLegacyProofLoss(response http.ResponseWriter, request *http.Request) {
	if h.proofLossRecovery == nil {
		writeError(response, http.StatusServiceUnavailable, "dependency_unavailable", "legacy proof-loss recovery is unavailable", true)
		return
	}
	requestID := strings.TrimSpace(request.Header.Get("Idempotency-Key"))
	if requestID == "" {
		writeError(response, http.StatusBadRequest, "invalid_request", "Idempotency-Key is required", false)
		return
	}
	var payload legacyProofLossRecoveryRequest
	if !decodeJSON(response, request, &payload) {
		return
	}
	record, err := h.proofLossRecovery.RecoverLegacyProofLoss(request.Context(), application.LegacyProofLossRecoveryInput{
		RequestID: requestID, AgentID: request.PathValue("agent_id"), OrganizationID: payload.OrganizationID,
		ActorPrincipalID: payload.ActorPrincipalID, FailedMigrationRequestID: payload.FailedMigrationRequestID})
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
	writeJSON(response, status, legacyProofLossRecoveryPayload(record))
}
