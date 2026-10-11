package server

import (
	"context"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"unicode/utf8"

	"github.com/tf4fun/antnest-platform/modules/service-authentication/serviceauth"
	"github.com/tf4fun/antnest-platform/services/edge-gateway/internal/identity"
)

func browserSessionJSON(principal identity.Principal, metadata identity.SessionMetadata) any {
	return struct {
		Principal identity.Principal `json:"principal"`
		identity.SessionMetadata
	}{principal, metadata}
}

func browserUserAgent(request *http.Request) string {
	hint := []rune(strings.ToValidUTF8(request.UserAgent(), ""))
	if len(hint) > 256 {
		hint = hint[:256]
	}
	return string(hint)
}

func (h *handler) authenticateBrowserMutation(response http.ResponseWriter, request *http.Request) bool {
	_, principal, err := h.authenticate(response, request)
	if err != nil {
		return false
	}
	if !h.validCSRF(request, principal.SessionID) {
		writeError(response, http.StatusForbidden, "csrf_failed", "Request could not be verified")
		return false
	}
	return true
}

func requireEmptyBrowserBody(response http.ResponseWriter, request *http.Request, allowQuery bool) bool {
	if !allowQuery && (request.URL.RawQuery != "" || request.URL.ForceQuery) {
		writeError(response, http.StatusBadRequest, "invalid_request", "Query parameters are not allowed")
		return false
	}
	if request.Body != nil {
		value, err := io.ReadAll(io.LimitReader(request.Body, 1))
		if err != nil || len(value) != 0 {
			writeError(response, http.StatusBadRequest, "invalid_request", "Request body is not allowed")
			return false
		}
	}
	return true
}

func decodeBrowserMutation(response http.ResponseWriter, request *http.Request, target any) bool {
	if request.URL.RawQuery != "" || request.URL.ForceQuery {
		writeError(response, http.StatusBadRequest, "invalid_request", "Query parameters are not allowed")
		return false
	}
	if strings.ToLower(strings.TrimSpace(strings.Split(request.Header.Get("Content-Type"), ";")[0])) != "application/json" {
		writeError(response, http.StatusUnsupportedMediaType, "invalid_request", "Content-Type must be application/json")
		return false
	}
	raw, err := io.ReadAll(io.LimitReader(request.Body, maximumLoginBytes+1))
	if err != nil || len(raw) > maximumLoginBytes || serviceauth.DecodeObject(raw, target) != nil {
		writeError(response, http.StatusBadRequest, "invalid_request", "Request body is invalid")
		return false
	}
	return true
}

func (h *handler) getBrowserAccount(response http.ResponseWriter, request *http.Request) error {
	if _, _, err := h.authenticate(response, request); err != nil {
		return err
	}
	if !requireEmptyBrowserBody(response, request, false) {
		return nil
	}
	ctx, cancel := context.WithTimeout(request.Context(), h.requestTimeout)
	defer cancel()
	account, err := h.identity.CurrentAccount(ctx)
	if err != nil {
		return h.writeBrowserIdentityError(response, err, false)
	}
	writeJSON(response, http.StatusOK, map[string]any{"account": account})
	return nil
}

func (h *handler) touchBrowserSession(response http.ResponseWriter, request *http.Request) error {
	if !h.authenticateBrowserMutation(response, request) {
		return nil
	}
	if !decodeBrowserMutation(response, request, &struct{}{}) {
		return nil
	}
	ctx, cancel := context.WithTimeout(request.Context(), h.requestTimeout)
	defer cancel()
	metadata, err := h.identity.TouchSession(ctx)
	if err != nil {
		return h.writeBrowserIdentityError(response, err, false)
	}
	writeJSON(response, http.StatusOK, metadata)
	return nil
}

func (h *handler) changeBrowserPassword(response http.ResponseWriter, request *http.Request) error {
	if !h.authenticateBrowserMutation(response, request) {
		return nil
	}
	var body struct {
		CurrentPassword string `json:"current_password"`
		NewPassword     string `json:"new_password"`
	}
	if !decodeBrowserMutation(response, request, &body) {
		return nil
	}
	if body.CurrentPassword == "" || utf8.RuneCountInString(body.NewPassword) < 12 || len(body.NewPassword) > 1024 {
		writeError(response, http.StatusBadRequest, "invalid_request", "Current password and a new password of at least 12 characters and at most 1024 bytes are required")
		return nil
	}
	ctx, cancel := context.WithTimeout(request.Context(), h.requestTimeout)
	defer cancel()
	result, err := h.identity.ChangePassword(ctx, identity.PasswordInput{RequestID: h.newRequestID(), CurrentPassword: body.CurrentPassword, NewPassword: body.NewPassword})
	if err != nil {
		return h.writeBrowserIdentityError(response, err, true)
	}
	if ctx.Err() != nil || !result.Principal.Active || !h.liveBrowserMetadata(result.SessionMetadata()) {
		return h.writeBrowserIdentityError(response, fmt.Errorf("password replacement expired before response"), false)
	}
	if _, err := h.sessions.Establish(response, result.AccessToken, result.TokenID, result.ExpiresAt); err != nil {
		return h.writeBrowserIdentityError(response, err, false)
	}
	writeJSON(response, http.StatusOK, browserSessionJSON(result.Principal, result.SessionMetadata()))
	return nil
}

func (h *handler) listBrowserSessions(response http.ResponseWriter, request *http.Request) error {
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
		if key != "limit" && key != "after_id" || len(values) != 1 || values[0] == "" {
			writeError(response, http.StatusBadRequest, "invalid_request", "Session query is invalid")
			return nil
		}
	}
	limit, err := strconv.Atoi(query.Get("limit"))
	after := query.Get("after_id")
	if err != nil || limit < 1 || limit > 100 || strings.IndexFunc(query.Get("limit"), func(r rune) bool { return r < '0' || r > '9' }) >= 0 || after != "" && !identity.ValidPublicID(after) {
		writeError(response, http.StatusBadRequest, "invalid_request", "Session page is invalid")
		return nil
	}
	ctx, cancel := context.WithTimeout(request.Context(), h.requestTimeout)
	defer cancel()
	result, err := h.identity.ListSessions(ctx, identity.SessionListInput{Limit: limit, AfterID: after})
	if err != nil {
		return h.writeBrowserIdentityError(response, err, false)
	}
	writeJSON(response, http.StatusOK, result)
	return nil
}

func (h *handler) revokeBrowserSessions(response http.ResponseWriter, request *http.Request) error {
	if !h.authenticateBrowserMutation(response, request) {
		return nil
	}
	var body struct {
		Mode string `json:"mode"`
	}
	if !decodeBrowserMutation(response, request, &body) {
		return nil
	}
	if body.Mode != "all" && body.Mode != "others" {
		writeError(response, http.StatusBadRequest, "invalid_request", "Session revocation mode is invalid")
		return nil
	}
	ctx, cancel := context.WithTimeout(request.Context(), h.requestTimeout)
	defer cancel()
	result, err := h.identity.RevokeSessions(ctx, identity.SessionRevokeInput{RequestID: h.newRequestID(), Mode: body.Mode})
	if err != nil {
		return h.writeBrowserIdentityError(response, err, false)
	}
	// Even revoking the current SID is not a cookie-writing transition. A late
	// response must not clear cookies belonging to a subsequent login.
	writeJSON(response, http.StatusOK, result)
	return nil
}

func (h *handler) liveBrowserMetadata(metadata identity.SessionMetadata) bool {
	now := h.now()
	return metadata.Valid() && metadata.ExpiresAt.After(now) && metadata.IdleExpiresAt.After(now)
}

// Admission uses the time after Identity responds. A successful RPC cannot
// authorize work after its request budget or either browser deadline elapsed.
func (h *handler) browserAdmissionError(ctx context.Context, principal identity.Principal, err error) error {
	if ctx.Err() != nil {
		return ctx.Err()
	}
	if err != nil || !principal.Active {
		return err
	}
	if !principal.SessionMetadata().Valid() {
		return fmt.Errorf("identity omitted valid browser deadlines")
	}
	if !h.liveBrowserMetadata(principal.SessionMetadata()) {
		return &identity.RemoteError{StatusCode: http.StatusUnauthorized, Code: "unauthenticated"}
	}
	return nil
}

func (h *handler) writeBrowserIdentityError(response http.ResponseWriter, err error, password bool) error {
	switch {
	case identity.IsCode(err, "unauthenticated"), identity.IsCode(err, "inactive_principal"), identity.IsCode(err, "caller_context_invalid"), identity.IsCode(err, "caller_context_required"):
		writeError(response, http.StatusUnauthorized, "unauthenticated", "Session is invalid or expired")
	case identity.IsCode(err, "forbidden"):
		writeError(response, http.StatusForbidden, "forbidden", "Operation is not allowed")
	case password && identity.IsCode(err, "invalid_current_password"):
		writeError(response, http.StatusBadRequest, "invalid_current_password", "Current password is incorrect")
	case identity.IsCode(err, "invalid_argument"), identity.IsCode(err, "bad_request"):
		writeError(response, http.StatusBadRequest, "invalid_request", "Request could not be accepted")
	default:
		writeError(response, http.StatusServiceUnavailable, "identity_unavailable", "Identity Service is unavailable")
	}
	return err
}
