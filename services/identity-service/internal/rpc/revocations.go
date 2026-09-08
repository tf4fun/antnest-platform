package rpc

import (
	"net/http"

	"soft/antnest-platform/services/identity-service/internal/directory"
	"soft/antnest-platform/services/identity-service/internal/domain"
)

func (h *Handler) resolveOwnerAuthorization(response http.ResponseWriter, request *http.Request) {
	var body resolvePrincipalRequest
	if !decodeRequest(response, request, &body) || !requireIDs(response, body.UserID, body.OrganizationID) {
		return
	}
	state, err := h.dependencies.Directory.ResolveOwnerAuthorization(request.Context(), body.UserID, body.OrganizationID)
	writeResult(response, map[string]any{"authorization": state}, err)
}

func (h *Handler) listPrincipalRevocations(response http.ResponseWriter, request *http.Request) {
	var body struct {
		AfterSequence *int64 `json:"after_sequence"`
		Limit         *int   `json:"limit"`
	}
	if !decodeRequest(response, request, &body) {
		return
	}
	if body.AfterSequence == nil || body.Limit == nil {
		writeError(response, domain.NewError("bad_request", "after_sequence and limit are required", false))
		return
	}
	page, err := h.dependencies.Directory.ListPrincipalRevocations(request.Context(), directory.RevocationQuery{
		AfterSequence: *body.AfterSequence, Limit: *body.Limit,
	})
	writeResult(response, page, err)
}
