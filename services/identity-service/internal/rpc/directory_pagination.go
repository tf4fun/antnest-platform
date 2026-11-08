package rpc

import (
	"bytes"
	"encoding/json"
	"net/http"

	"github.com/tf4fun/antnest-platform/modules/service-authentication/serviceauth"
	"github.com/tf4fun/antnest-platform/services/identity-service/internal/apierror"
	"github.com/tf4fun/antnest-platform/services/identity-service/internal/directory"
	"github.com/tf4fun/antnest-platform/services/identity-service/internal/domain"
)

type directoryPageRequest struct {
	ActorPrincipalID string          `json:"actor_principal_id"`
	OrganizationID   string          `json:"organization_id"`
	Limit            *int            `json:"limit"`
	Cursor           json.RawMessage `json:"cursor"`
	Filter           json.RawMessage `json:"filter"`
}

func invalidPageInput(response http.ResponseWriter) {
	writeError(response, domain.NewError(apierror.BadRequest, "Request body is invalid", false))
}

func decodePageCursor(response http.ResponseWriter, raw json.RawMessage) (string, bool) {
	if len(raw) == 0 {
		return "", true
	}
	if bytes.Equal(bytes.TrimSpace(raw), []byte("null")) {
		invalidPageInput(response)
		return "", false
	}
	var cursor string
	if err := json.Unmarshal(raw, &cursor); err != nil || cursor == "" {
		invalidPageInput(response)
		return "", false
	}
	return cursor, true
}

func decodePageFilter(response http.ResponseWriter, raw json.RawMessage, target any) bool {
	if len(raw) == 0 {
		return true
	}
	if bytes.Equal(bytes.TrimSpace(raw), []byte("null")) {
		invalidPageInput(response)
		return false
	}
	var fields map[string]json.RawMessage
	if err := json.Unmarshal(raw, &fields); err != nil {
		invalidPageInput(response)
		return false
	}
	for _, value := range fields {
		if bytes.Equal(bytes.TrimSpace(value), []byte("null")) {
			invalidPageInput(response)
			return false
		}
	}
	if err := serviceauth.DecodeObject(raw, target); err != nil {
		invalidPageInput(response)
		return false
	}
	return true
}

func validMemberFilter(filter directory.MemberFilter) bool {
	switch filter.Role {
	case "", domain.OrganizationRoleMember, domain.OrganizationRoleAdmin:
	default:
		return false
	}
	switch filter.Source {
	case "", domain.SourceLocal, domain.SourceSCIM:
	default:
		return false
	}
	return true
}

func validGroupFilter(filter directory.GroupFilter) bool {
	switch filter.Source {
	case "", domain.SourceLocal, domain.SourceSCIM:
	default:
		return false
	}
	return true
}

func (h *Handler) listMembers(response http.ResponseWriter, request *http.Request) {
	var body directoryPageRequest
	if !decodeRequest(response, request, &body) ||
		!requireIDs(response, body.ActorPrincipalID, body.OrganizationID) {
		return
	}
	if body.Limit == nil || *body.Limit < 1 || *body.Limit > 200 {
		invalidPageInput(response)
		return
	}
	cursor, ok := decodePageCursor(response, body.Cursor)
	if !ok {
		return
	}
	var filter directory.MemberFilter
	if !decodePageFilter(response, body.Filter, &filter) {
		return
	}
	if !validMemberFilter(filter) {
		invalidPageInput(response)
		return
	}
	page, err := h.dependencies.Directory.ListMembers(request.Context(), directory.ListMembersInput{
		ActorPrincipalID: body.ActorPrincipalID,
		OrganizationID:   body.OrganizationID,
		Cursor:           cursor,
		Limit:            *body.Limit,
		Filter:           filter,
	})
	writeResult(response, page, err)
}

func (h *Handler) listGroups(response http.ResponseWriter, request *http.Request) {
	var body directoryPageRequest
	if !decodeRequest(response, request, &body) ||
		!requireIDs(response, body.ActorPrincipalID, body.OrganizationID) {
		return
	}
	if body.Limit == nil || *body.Limit < 1 || *body.Limit > 200 {
		invalidPageInput(response)
		return
	}
	cursor, ok := decodePageCursor(response, body.Cursor)
	if !ok {
		return
	}
	var filter directory.GroupFilter
	if !decodePageFilter(response, body.Filter, &filter) {
		return
	}
	if !validGroupFilter(filter) {
		invalidPageInput(response)
		return
	}
	page, err := h.dependencies.Directory.ListGroups(request.Context(), directory.ListGroupsInput{
		ActorPrincipalID: body.ActorPrincipalID,
		OrganizationID:   body.OrganizationID,
		Cursor:           cursor,
		Limit:            *body.Limit,
		Filter:           filter,
	})
	writeResult(response, page, err)
}
