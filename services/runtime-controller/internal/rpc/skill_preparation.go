package rpc

import (
	"errors"
	"net/http"

	"soft/antnest-platform/services/runtime-controller/internal/control"
	"soft/antnest-platform/services/runtime-controller/internal/skillset"
)

func (h *Handler) prepareSkillSet(response http.ResponseWriter, request *http.Request) {
	if h.skillPreparation == nil {
		writeSkillPreparationUnavailable(response)
		return
	}
	requestID, ok := requireIdempotencyKey(response, request)
	if !ok {
		return
	}
	var input skillset.PrepareRequest
	if err := decodeJSON(response, request, &input); err != nil {
		writeError(response, err)
		return
	}
	receipt, err := h.skillPreparation.Prepare(request.Context(), requestID, request.PathValue("agent_id"), input)
	if err != nil {
		writeSkillPreparationError(response, err)
		return
	}
	writeJSON(response, http.StatusAccepted, receipt)
}

func (h *Handler) getSkillPreparation(response http.ResponseWriter, request *http.Request) {
	if h.skillPreparation == nil {
		writeSkillPreparationUnavailable(response)
		return
	}
	organizationID := request.URL.Query().Get("organization_id")
	if organizationID == "" {
		writeError(response, control.ErrInvalidRequest)
		return
	}
	receipt, err := h.skillPreparation.Get(request.Context(), organizationID, request.PathValue("agent_id"), request.PathValue("request_id"))
	if err != nil {
		writeSkillPreparationError(response, err)
		return
	}
	writeJSON(response, http.StatusOK, receipt)
}

type skillReleaseRequest struct {
	OrganizationID   string `json:"organization_id"`
	OwnerOperationID string `json:"owner_operation_id"`
}

func (h *Handler) releaseSkillPreparation(response http.ResponseWriter, request *http.Request) {
	if h.skillPreparation == nil {
		writeSkillPreparationUnavailable(response)
		return
	}
	if _, ok := requireIdempotencyKey(response, request); !ok {
		return
	}
	var input skillReleaseRequest
	if err := decodeJSON(response, request, &input); err != nil {
		writeError(response, err)
		return
	}
	if input.OrganizationID == "" || input.OwnerOperationID == "" {
		writeError(response, control.ErrInvalidRequest)
		return
	}
	err := h.skillPreparation.Release(request.Context(), input.OrganizationID, request.PathValue("agent_id"), request.PathValue("request_id"), input.OwnerOperationID)
	if err != nil {
		writeSkillPreparationError(response, err)
		return
	}
	response.WriteHeader(http.StatusNoContent)
}

func writeSkillPreparationUnavailable(response http.ResponseWriter) {
	writeJSON(response, http.StatusServiceUnavailable, errorResponse{Code: "skill_preparation_unavailable", Message: "Skill preparation is unavailable", Retryable: true})
}

func writeSkillPreparationError(response http.ResponseWriter, err error) {
	if errors.Is(err, control.ErrNotFound) {
		writeJSON(response, http.StatusNotFound, errorResponse{Code: "preparation_not_found", Message: "Skill preparation was not found", Retryable: false})
		return
	}
	writeError(response, err)
}
