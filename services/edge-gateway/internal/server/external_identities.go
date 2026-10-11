package server

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/url"
	"strconv"

	"github.com/tf4fun/antnest-platform/services/edge-gateway/internal/identity"
)

func (h *handler) listBrowserExternalIdentities(response http.ResponseWriter, request *http.Request) error {
	if _, _, err := h.authenticate(response, request); err != nil {
		return err
	}
	if !requireEmptyBrowserBody(response, request, true) {
		return nil
	}
	query, err := url.ParseQuery(request.URL.RawQuery)
	if err != nil || len(query["limit"]) != 1 {
		writeError(response, http.StatusBadRequest, "invalid_request", "A single limit is required")
		return nil
	}
	for key, values := range query {
		if (key != "limit" && key != "after_id" && key != "notice_after_id") || len(values) != 1 || key != "limit" && !identity.ValidPublicID(values[0]) {
			writeError(response, http.StatusBadRequest, "invalid_request", "Query parameters are invalid")
			return nil
		}
	}
	limit, err := strconv.Atoi(query.Get("limit"))
	if err != nil || limit < 1 || limit > 100 || strconv.Itoa(limit) != query.Get("limit") {
		writeError(response, http.StatusBadRequest, "invalid_request", "Limit must be an integer from 1 to 100")
		return nil
	}
	ctx, cancel := context.WithTimeout(request.Context(), h.requestTimeout)
	defer cancel()
	page, err := h.identity.ListExternalIdentities(ctx, identity.ExternalIdentityListInput{Limit: limit, AfterID: query.Get("after_id"), NoticeAfterID: query.Get("notice_after_id")})
	if err != nil {
		return h.writeExternalIdentityError(response, err)
	}
	writeJSON(response, http.StatusOK, page)
	return nil
}

func (h *handler) unbindBrowserExternalIdentity(response http.ResponseWriter, request *http.Request) error {
	if !h.authenticateBrowserMutation(response, request) {
		return nil
	}
	var body struct {
		AllowLockout json.RawMessage `json:"allow_lockout"`
	}
	if !decodeBrowserMutation(response, request, &body) {
		return nil
	}
	input := identity.ExternalIdentityUnbindInput{RequestID: h.newRequestID(), BindingID: request.PathValue("binding_id")}
	if !identity.ValidPublicID(input.BindingID) || body.AllowLockout != nil && (bytes.Equal(bytes.TrimSpace(body.AllowLockout), []byte("null")) || json.Unmarshal(body.AllowLockout, &input.AllowLockout) != nil) {
		writeError(response, http.StatusBadRequest, "invalid_request", "Binding reference or lockout choice is invalid")
		return nil
	}
	ctx, cancel := context.WithTimeout(request.Context(), h.requestTimeout)
	defer cancel()
	result, err := h.identity.UnbindExternalIdentity(ctx, input)
	if err != nil {
		return h.writeExternalIdentityError(response, err)
	}
	// A committed unbind may revoke this very session. Return its result without
	// another authorization check or Cookie mutation; the next request reauthenticates.
	writeJSON(response, http.StatusOK, result)
	return nil
}

func (h *handler) acknowledgeBrowserExternalIdentityNotices(response http.ResponseWriter, request *http.Request) error {
	if !h.authenticateBrowserMutation(response, request) {
		return nil
	}
	var body struct {
		NoticeIDs []string `json:"notice_ids"`
	}
	if !decodeBrowserMutation(response, request, &body) {
		return nil
	}
	if !identity.ValidExternalIdentityNoticeIDs(body.NoticeIDs) {
		writeError(response, http.StatusBadRequest, "invalid_request", "One to 100 unique notice references are required")
		return nil
	}
	ctx, cancel := context.WithTimeout(request.Context(), h.requestTimeout)
	defer cancel()
	result, err := h.identity.AcknowledgeExternalIdentityNotices(ctx, identity.ExternalIdentityAcknowledgeInput{RequestID: h.newRequestID(), NoticeIDs: body.NoticeIDs})
	if err != nil {
		return h.writeExternalIdentityError(response, err)
	}
	writeJSON(response, http.StatusOK, result)
	return nil
}

func (h *handler) writeExternalIdentityError(response http.ResponseWriter, err error) error {
	switch {
	case identity.IsCode(err, "not_found"):
		writeError(response, http.StatusNotFound, "not_found", "External identity or notice was not found")
	case identity.IsCode(err, "external_identity_last_method"):
		writeError(response, http.StatusConflict, "external_identity_last_method", "This is the Membership's last available login method")
	default:
		return h.writeBrowserIdentityError(response, err, false)
	}
	return err
}
