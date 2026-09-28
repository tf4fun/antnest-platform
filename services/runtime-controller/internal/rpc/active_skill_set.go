package rpc

import (
	"context"
	"net/http"

	"soft/antnest-platform/services/runtime-controller/internal/control"
)

type ActiveSkillSetVerifier interface {
	VerifyActiveSkillSet(context.Context, string, control.ActiveSkillSetVerificationRequest) (control.ActiveSkillSetVerificationReceipt, error)
}

func (h *Handler) SetActiveSkillVerifier(verifier ActiveSkillSetVerifier) {
	h.activeSkillVerifier = verifier
}

func (h *Handler) verifyActiveSkillSet(response http.ResponseWriter, request *http.Request) {
	if h.activeSkillVerifier == nil {
		writeSkillPreparationUnavailable(response)
		return
	}
	if _, ok := requireIdempotencyKey(response, request); !ok {
		return
	}
	var input control.ActiveSkillSetVerificationRequest
	if err := decodeJSON(response, request, &input); err != nil {
		writeError(response, err)
		return
	}
	receipt, err := h.activeSkillVerifier.VerifyActiveSkillSet(request.Context(), request.PathValue("agent_id"), input)
	if err != nil {
		writeError(response, err)
		return
	}
	writeJSON(response, http.StatusOK, receipt)
}
