package rpc

import (
	"encoding/json"
	"net/http"

	"github.com/tf4fun/antnest-platform/services/identity-service/internal/browsersessions"
	"github.com/tf4fun/antnest-platform/services/identity-service/internal/domain"
)

func (h *Handler) touchBrowserSession(response http.ResponseWriter, request *http.Request) {
	var body struct {
		ActorPrincipalID string `json:"actor_principal_id"`
	}
	if !decodeRequest(response, request, &body) || !requireIDs(response, body.ActorPrincipalID) {
		return
	}
	result, err := h.dependencies.BrowserSessions.Touch(request.Context(), body.ActorPrincipalID)
	writeResult(response, result, err)
}

func (h *Handler) listUserSessions(response http.ResponseWriter, request *http.Request) {
	var body struct {
		ActorPrincipalID string          `json:"actor_principal_id"`
		UserID           string          `json:"user_id"`
		Scope            string          `json:"scope"`
		Limit            *int            `json:"limit"`
		AfterID          json.RawMessage `json:"after_id"`
	}
	if !decodeRequest(response, request, &body) || !requireIDs(response, body.ActorPrincipalID, body.UserID) || !require(response, body.Scope) {
		return
	}
	if body.Limit == nil {
		writeError(response, domain.InvalidArgument("limit is required"))
		return
	}
	var afterID string
	if body.AfterID != nil && (json.Unmarshal(body.AfterID, &afterID) != nil || !domain.ValidID(afterID)) {
		writeError(response, domain.InvalidArgument("after_id must be a public reference"))
		return
	}
	page, err := h.dependencies.BrowserSessions.List(request.Context(), browsersessions.ListInput{ActorPrincipalID: body.ActorPrincipalID, UserID: body.UserID, Scope: body.Scope, Limit: *body.Limit, AfterID: afterID})
	writeResult(response, page, err)
}

func (h *Handler) revokeUserSessions(response http.ResponseWriter, request *http.Request) {
	var body struct {
		RequestID        string `json:"request_id"`
		ActorPrincipalID string `json:"actor_principal_id"`
		UserID           string `json:"user_id"`
		Scope            string `json:"scope"`
		Mode             string `json:"mode"`
	}
	if !decodeRequest(response, request, &body) || !requireIDs(response, body.RequestID, body.ActorPrincipalID, body.UserID) || !require(response, body.Scope, body.Mode) {
		return
	}
	result, err := h.dependencies.BrowserSessions.Revoke(request.Context(), browsersessions.RevokeInput{RequestID: body.RequestID, ActorPrincipalID: body.ActorPrincipalID, UserID: body.UserID, Scope: body.Scope, Mode: body.Mode})
	writeResult(response, result, err)
}

func (h *Handler) listSessionRevocations(response http.ResponseWriter, request *http.Request) {
	var body struct {
		AfterSequence *int64 `json:"after_sequence"`
		Limit         *int   `json:"limit"`
	}
	if !decodeRequest(response, request, &body) {
		return
	}
	if body.AfterSequence == nil || body.Limit == nil {
		writeError(response, domain.InvalidArgument("after_sequence and limit are required"))
		return
	}
	page, err := h.dependencies.BrowserSessions.ListRevocations(request.Context(), browsersessions.RevocationQuery{AfterSequence: *body.AfterSequence, Limit: *body.Limit})
	writeResult(response, page, err)
}
