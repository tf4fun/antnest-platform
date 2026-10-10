package server

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"regexp"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/tf4fun/antnest-platform/services/admin-console/internal/principal"
	"github.com/tf4fun/antnest-platform/services/admin-console/internal/upstream"
)

var browserSessionPublicID = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9_.-]{0,199}$`)

func (h *handler) registerBrowserSessionRoutes() {
	h.mux.HandleFunc("GET /api/admin/directory/users/{user_id}/sessions", h.withPrincipal(h.listOrganizationSessions))
	h.mux.HandleFunc("POST /api/admin/directory/users/{user_id}/sessions/revoke", h.withPrincipal(h.revokeOrganizationSessions))
}

func browserSessionTarget(response http.ResponseWriter, request *http.Request) (string, bool) {
	id := request.PathValue("user_id")
	if !browserSessionPublicID.MatchString(id) {
		writeError(response, http.StatusBadRequest, "invalid_request", "User reference is invalid")
		return "", false
	}
	return id, true
}

func (h *handler) listOrganizationSessions(response http.ResponseWriter, request *http.Request, actor principal.Principal) {
	response.Header().Set("Cache-Control", "no-store")
	userID, ok := browserSessionTarget(response, request)
	if !ok {
		return
	}
	if request.Body != nil {
		body, err := io.ReadAll(io.LimitReader(request.Body, 1))
		if err != nil || len(body) != 0 {
			writeError(response, http.StatusBadRequest, "invalid_request", "Request body is not allowed")
			return
		}
	}
	query, ok := parseListQuery(response, request, "limit", "after_id")
	if !ok {
		return
	}
	limit, err := strconv.Atoi(query.Get("limit"))
	after := query.Get("after_id")
	_, hasAfter := query["after_id"]
	if err != nil || limit < 1 || limit > 100 || strconv.Itoa(limit) != query.Get("limit") ||
		hasAfter && !browserSessionPublicID.MatchString(after) {
		writeInvalidListQuery(response)
		return
	}
	payload := map[string]any{"actor_principal_id": actor.UserID, "user_id": userID, "scope": "organization", "limit": limit}
	if hasAfter {
		payload["after_id"] = after
	}
	h.forwardProjectedJSON(response, request, upstream.Identity, http.MethodPost, "/rpc/identity/list-user-sessions", "", payload,
		func(body []byte) ([]byte, error) { return projectBrowserSessions(body, actor, userID, after, limit) })
}

func (h *handler) revokeOrganizationSessions(response http.ResponseWriter, request *http.Request, actor principal.Principal) {
	response.Header().Set("Cache-Control", "no-store")
	userID, ok := browserSessionTarget(response, request)
	if !ok {
		return
	}
	if request.URL.RawQuery != "" || request.URL.ForceQuery {
		writeInvalidListQuery(response)
		return
	}
	if !decodeEmptyObject(response, request) {
		return
	}
	requestID, ok := commandRequestID(response, request, actor.OrganizationID, "browser-sessions")
	if !ok {
		return
	}
	payload := map[string]string{"request_id": requestID, "actor_principal_id": actor.UserID, "user_id": userID, "scope": "organization", "mode": "all"}
	h.forwardProjectedJSON(response, request, upstream.Identity, http.MethodPost, "/rpc/identity/revoke-user-sessions", "", payload,
		func(body []byte) ([]byte, error) { return projectSessionRevocation(body, userID == actor.UserID) })
}

type browserSessionProjection struct {
	ID               string    `json:"id"`
	OrganizationID   string    `json:"organization_id"`
	OrganizationSlug string    `json:"organization_slug"`
	OrganizationName string    `json:"organization_name"`
	CreatedAt        time.Time `json:"created_at"`
	LastActiveAt     time.Time `json:"last_active_at"`
	IdleExpiresAt    time.Time `json:"idle_expires_at"`
	ExpiresAt        time.Time `json:"expires_at"`
	UserAgentHint    *string   `json:"user_agent_hint"`
	Current          *bool     `json:"current"`
}

func projectBrowserSessions(body []byte, actor principal.Principal, userID, after string, limit int) ([]byte, error) {
	var page struct {
		Sessions    []browserSessionProjection `json:"sessions"`
		NextAfterID string                     `json:"next_after_id,omitempty"`
	}
	if err := json.Unmarshal(body, &page); err != nil {
		return nil, err
	}
	if page.Sessions == nil || len(page.Sessions) > limit {
		return nil, fmt.Errorf("invalid browser session page")
	}
	previous := after
	currentFound := false
	for _, row := range page.Sessions {
		if !browserSessionPublicID.MatchString(row.ID) || row.ID <= previous || row.OrganizationID != actor.OrganizationID ||
			strings.TrimSpace(row.OrganizationSlug) == "" || strings.TrimSpace(row.OrganizationName) == "" ||
			row.CreatedAt.IsZero() || row.LastActiveAt.IsZero() || row.ExpiresAt.IsZero() || row.IdleExpiresAt.IsZero() ||
			row.IdleExpiresAt.After(row.ExpiresAt) || row.CreatedAt.After(row.LastActiveAt) || row.LastActiveAt.After(row.IdleExpiresAt) ||
			row.Current == nil || row.UserAgentHint == nil || utf8.RuneCountInString(*row.UserAgentHint) > 256 {
			return nil, fmt.Errorf("invalid browser session metadata")
		}
		if *row.Current {
			if currentFound || userID != actor.UserID {
				return nil, fmt.Errorf("invalid current browser session")
			}
			currentFound = true
		}
		previous = row.ID
	}
	// Expiry filtering after Identity's scan may leave an empty visible page
	// with a cursor beyond the last visible row. Preserve that scanned window.
	if page.NextAfterID != "" && (!browserSessionPublicID.MatchString(page.NextAfterID) || page.NextAfterID <= after || page.NextAfterID < previous) {
		return nil, fmt.Errorf("invalid browser session cursor")
	}
	return json.Marshal(page)
}

func projectSessionRevocation(body []byte, self bool) ([]byte, error) {
	var result struct {
		RevokedCount   *int  `json:"revoked_count"`
		CurrentRevoked *bool `json:"current_revoked"`
	}
	if err := json.Unmarshal(body, &result); err != nil {
		return nil, err
	}
	if result.RevokedCount == nil || result.CurrentRevoked == nil || *result.RevokedCount < 0 ||
		*result.CurrentRevoked && (!self || *result.RevokedCount == 0) {
		return nil, fmt.Errorf("invalid browser session revocation")
	}
	return json.Marshal(result)
}
