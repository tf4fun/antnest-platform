package server

import (
	"net/http"
	"strings"

	"soft/antnest-platform/services/agent-controller/internal/application"
)

func (h *handler) getLegacySkillMigration(response http.ResponseWriter, request *http.Request) {
	if h.legacySkills == nil {
		writeError(response, http.StatusServiceUnavailable, "dependency_unavailable", "legacy Skill migration is unavailable", true)
		return
	}
	organizationID, ok := requiredOrganizationQuery(response, request)
	if !ok {
		return
	}
	review, err := h.legacySkills.GetLegacySkillMigration(request.Context(), organizationID, request.PathValue("agent_id"))
	if err != nil {
		writeServiceError(request.Context(), response, err)
		return
	}
	writeJSON(response, http.StatusOK, review)
}

func (h *handler) recordLegacySkillChoice(response http.ResponseWriter, request *http.Request) {
	if h.legacySkills == nil {
		writeError(response, http.StatusServiceUnavailable, "dependency_unavailable", "legacy Skill migration is unavailable", true)
		return
	}
	requestID := strings.TrimSpace(request.Header.Get("Idempotency-Key"))
	if requestID == "" {
		writeError(response, http.StatusBadRequest, "invalid_request", "Idempotency-Key is required", false)
		return
	}
	var input application.RecordLegacySkillChoiceInput
	if !decodeJSON(response, request, &input) {
		return
	}
	input.RequestID = requestID
	input.AgentID = request.PathValue("agent_id")
	choice, err := h.legacySkills.RecordLegacySkillChoice(request.Context(), input)
	if err != nil {
		writeServiceError(request.Context(), response, err)
		return
	}
	writeJSON(response, http.StatusCreated, choice)
}

func (h *handler) startLegacySkillMigration(response http.ResponseWriter, request *http.Request) {
	requestID := strings.TrimSpace(request.Header.Get("Idempotency-Key"))
	if requestID == "" {
		writeError(response, http.StatusBadRequest, "invalid_request", "Idempotency-Key is required", false)
		return
	}
	var input application.LegacySkillMigrationOperationInput
	if !decodeJSON(response, request, &input) {
		return
	}
	input.RequestID = requestID
	input.AgentID = request.PathValue("agent_id")
	result, err := h.lifecycle.MigrateLegacySkills(request.Context(), input)
	observeLifecycleResult(request.Context(), result.Operation)
	if err != nil {
		writeServiceError(request.Context(), response, err)
		return
	}
	writeJSON(response, http.StatusAccepted, operationPayload(result.Operation))
}
