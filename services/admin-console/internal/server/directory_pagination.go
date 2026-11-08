package server

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/tf4fun/antnest-platform/modules/service-authentication/serviceauth"
	"github.com/tf4fun/antnest-platform/services/admin-console/internal/apierror"
	"github.com/tf4fun/antnest-platform/services/admin-console/internal/principal"
	"github.com/tf4fun/antnest-platform/services/admin-console/internal/upstream"
)

const (
	directoryPageDefaultLimit = 50
	directoryPageMaximumLimit = 200
	directoryPrefixMaxBytes   = 256
	directoryCursorMaxBytes   = 4096
)

type directoryPageInput struct {
	cursor string
	limit  int
	prefix string
	role   string
	active *bool
	source string
}

func directoryPageQuery(response http.ResponseWriter, request *http.Request, members bool) (directoryPageInput, bool) {
	input := directoryPageInput{limit: directoryPageDefaultLimit}
	fail := func() (directoryPageInput, bool) {
		writeError(response, http.StatusBadRequest, apierror.InvalidRequest, "Directory query is invalid")
		return directoryPageInput{}, false
	}
	if request.ContentLength != 0 || len(request.TransferEncoding) > 0 {
		return fail()
	}
	query, err := url.ParseQuery(request.URL.RawQuery)
	if err != nil {
		return fail()
	}
	allowed := map[string]bool{"cursor": true, "limit": true, "q": true, "active": true, "source": true}
	if members {
		allowed["role"] = true
	}
	for key, values := range query {
		if !allowed[key] || len(values) != 1 || !utf8.ValidString(values[0]) {
			return fail()
		}
	}
	if values, ok := query["cursor"]; ok {
		cursor := values[0]
		if cursor == "" || len(cursor) > directoryCursorMaxBytes {
			return fail()
		}
		for _, r := range cursor {
			if r < 0x20 || r == 0x7f {
				return fail()
			}
		}
		input.cursor = cursor
	}
	if values, ok := query["limit"]; ok {
		limit, err := strconv.Atoi(values[0])
		if err != nil || limit < 1 || limit > directoryPageMaximumLimit {
			return fail()
		}
		input.limit = limit
	}
	if values, ok := query["q"]; ok {
		prefix := strings.ToLower(strings.TrimSpace(values[0]))
		if !utf8.ValidString(prefix) || len(prefix) > directoryPrefixMaxBytes {
			return fail()
		}
		input.prefix = prefix
	}
	if members {
		if values, ok := query["role"]; ok {
			switch values[0] {
			case "admin", "member":
				input.role = values[0]
			default:
				return fail()
			}
		}
	}
	if values, ok := query["active"]; ok {
		switch values[0] {
		case "true":
			enabled := true
			input.active = &enabled
		case "false":
			enabled := false
			input.active = &enabled
		default:
			return fail()
		}
	}
	if values, ok := query["source"]; ok {
		switch values[0] {
		case "local", "scim":
			input.source = values[0]
		default:
			return fail()
		}
	}
	return input, true
}

func (h *handler) directoryMembers(response http.ResponseWriter, request *http.Request, actor principal.Principal) {
	response.Header().Set("Cache-Control", "no-store")
	input, ok := directoryPageQuery(response, request, true)
	if !ok {
		return
	}
	payload := map[string]any{
		"actor_principal_id": actor.UserID,
		"organization_id":    actor.OrganizationID,
		"limit":              input.limit,
	}
	if input.cursor != "" {
		payload["cursor"] = input.cursor
	}
	filter := map[string]any{}
	if input.prefix != "" {
		filter["email_prefix"] = input.prefix
	}
	if input.role != "" {
		filter["role"] = input.role
	}
	if input.active != nil {
		filter["active"] = *input.active
	}
	if input.source != "" {
		filter["source"] = input.source
	}
	if len(filter) > 0 {
		payload["filter"] = filter
	}
	h.forwardProjectedJSON(response, request, upstream.Identity, http.MethodPost,
		"/rpc/identity/list-members", "", payload,
		projectDirectoryMemberPage(actor.OrganizationID, input.limit, input.cursor))
}

func (h *handler) directoryGroups(response http.ResponseWriter, request *http.Request, actor principal.Principal) {
	response.Header().Set("Cache-Control", "no-store")
	input, ok := directoryPageQuery(response, request, false)
	if !ok {
		return
	}
	payload := map[string]any{
		"actor_principal_id": actor.UserID,
		"organization_id":    actor.OrganizationID,
		"limit":              input.limit,
	}
	if input.cursor != "" {
		payload["cursor"] = input.cursor
	}
	filter := map[string]any{}
	if input.prefix != "" {
		filter["display_name_prefix"] = input.prefix
	}
	if input.active != nil {
		filter["active"] = *input.active
	}
	if input.source != "" {
		filter["source"] = input.source
	}
	if len(filter) > 0 {
		payload["filter"] = filter
	}
	h.forwardProjectedJSON(response, request, upstream.Identity, http.MethodPost,
		"/rpc/identity/list-groups", "", payload,
		projectDirectoryGroupPage(actor.OrganizationID, input.limit, input.cursor))
}

func decodePageEnvelope(raw []byte) (map[string]json.RawMessage, error) {
	var fields map[string]json.RawMessage
	if err := serviceauth.DecodeObject(raw, &fields); err != nil {
		return nil, fmt.Errorf("page envelope: %w", err)
	}
	return fields, nil
}

func decodePageCursorValue(raw json.RawMessage, inputCursor string) (*string, error) {
	var cursor *string
	if err := json.Unmarshal(raw, &cursor); err != nil {
		return nil, fmt.Errorf("next_cursor is invalid")
	}
	if cursor == nil {
		return nil, nil
	}
	if *cursor == "" || len(*cursor) > directoryCursorMaxBytes {
		return nil, fmt.Errorf("next_cursor is invalid")
	}
	for _, r := range *cursor {
		if r < 0x20 || r == 0x7f {
			return nil, fmt.Errorf("next_cursor contains control characters")
		}
	}
	if inputCursor != "" && *cursor == inputCursor {
		return nil, fmt.Errorf("next_cursor repeats the request cursor")
	}
	return cursor, nil
}

func requiredString(fields map[string]json.RawMessage, name string) (string, error) {
	value, present := fields[name]
	if !present {
		return "", fmt.Errorf("%s is missing", name)
	}
	var decoded string
	if err := json.Unmarshal(value, &decoded); err != nil || decoded == "" {
		return "", fmt.Errorf("%s is invalid", name)
	}
	return decoded, nil
}

func requiredBool(fields map[string]json.RawMessage, name string) (bool, error) {
	value, present := fields[name]
	if !present {
		return false, fmt.Errorf("%s is missing", name)
	}
	var decoded *bool
	if err := json.Unmarshal(value, &decoded); err != nil || decoded == nil {
		return false, fmt.Errorf("%s is invalid", name)
	}
	return *decoded, nil
}

func requiredTimestamp(fields map[string]json.RawMessage, name string) (string, error) {
	value, err := requiredString(fields, name)
	if err != nil {
		return "", err
	}
	if _, err := time.Parse(time.RFC3339, value); err != nil {
		return "", fmt.Errorf("%s is invalid", name)
	}
	return value, nil
}

type upstreamDirectoryUser struct {
	ID         string `json:"id"`
	SystemRole string `json:"system_role"`
	Active     bool   `json:"active"`
	CreatedAt  string `json:"created_at"`
	UpdatedAt  string `json:"updated_at"`
}

type upstreamDirectoryMembership struct {
	ID          string `json:"id"`
	UserID      string `json:"user_id"`
	Email       string `json:"email"`
	DisplayName string `json:"display_name"`
	Role        string `json:"role"`
	Source      string `json:"source"`
	Active      bool   `json:"active"`
	CreatedAt   string `json:"created_at"`
	UpdatedAt   string `json:"updated_at"`
}

type upstreamDirectoryGroup struct {
	DisplayName string `json:"display_name"`
	Source      string `json:"source"`
	Active      bool   `json:"active"`
	CreatedAt   string `json:"created_at"`
	UpdatedAt   string `json:"updated_at"`
}

func projectDirectoryMemberPage(organizationID string, limit int, inputCursor string) payloadProjector {
	return func(raw []byte) ([]byte, error) {
		fields, err := decodePageEnvelope(raw)
		if err != nil {
			return nil, err
		}
		nextRaw, present := fields["next_cursor"]
		if !present {
			return nil, fmt.Errorf("next_cursor is missing")
		}
		next, err := decodePageCursorValue(nextRaw, inputCursor)
		if err != nil {
			return nil, err
		}
		itemsRaw, present := fields["items"]
		if !present {
			return nil, fmt.Errorf("items is missing")
		}
		var items []json.RawMessage
		if err := json.Unmarshal(itemsRaw, &items); err != nil || items == nil {
			return nil, fmt.Errorf("items is invalid")
		}
		if len(items) > limit || len(items) > directoryPageMaximumLimit {
			return nil, fmt.Errorf("items exceeds the page bound")
		}
		if len(items) == 0 && next != nil {
			return nil, fmt.Errorf("empty page must terminate the cursor")
		}
		projected := make([]map[string]any, 0, len(items))
		for index, itemRaw := range items {
			var item map[string]json.RawMessage
			if err := serviceauth.DecodeObject(itemRaw, &item); err != nil {
				return nil, fmt.Errorf("items[%d]: %w", index, err)
			}
			userRaw, present := item["user"]
			if !present {
				return nil, fmt.Errorf("items[%d].user is missing", index)
			}
			var user map[string]json.RawMessage
			if err := serviceauth.DecodeObject(userRaw, &user); err != nil {
				return nil, fmt.Errorf("items[%d].user: %w", index, err)
			}
			membershipRaw, present := item["membership"]
			if !present {
				return nil, fmt.Errorf("items[%d].membership is missing", index)
			}
			var membership map[string]json.RawMessage
			if err := serviceauth.DecodeObject(membershipRaw, &membership); err != nil {
				return nil, fmt.Errorf("items[%d].membership: %w", index, err)
			}
			userID, err := requiredString(user, "id")
			if err != nil {
				return nil, fmt.Errorf("items[%d].user: %w", index, err)
			}
			systemRole, err := requiredString(user, "system_role")
			if err != nil {
				return nil, fmt.Errorf("items[%d].user: %w", index, err)
			}
			if systemRole != "user" && systemRole != "admin" {
				return nil, fmt.Errorf("items[%d].user system_role is invalid", index)
			}
			userActive, err := requiredBool(user, "active")
			if err != nil {
				return nil, fmt.Errorf("items[%d].user: %w", index, err)
			}
			userCreated, err := requiredTimestamp(user, "created_at")
			if err != nil {
				return nil, fmt.Errorf("items[%d].user: %w", index, err)
			}
			userUpdated, err := requiredTimestamp(user, "updated_at")
			if err != nil {
				return nil, fmt.Errorf("items[%d].user: %w", index, err)
			}
			membershipOrg, err := requiredString(membership, "organization_id")
			if err != nil {
				return nil, fmt.Errorf("items[%d].membership: %w", index, err)
			}
			if membershipOrg != organizationID {
				return nil, fmt.Errorf("items[%d].membership is outside the caller organization", index)
			}
			membershipID, err := requiredString(membership, "id")
			if err != nil {
				return nil, fmt.Errorf("items[%d].membership: %w", index, err)
			}
			membershipUser, err := requiredString(membership, "user_id")
			if err != nil {
				return nil, fmt.Errorf("items[%d].membership: %w", index, err)
			}
			if membershipUser != userID {
				return nil, fmt.Errorf("items[%d] user does not match its membership", index)
			}
			email, err := requiredString(membership, "email")
			if err != nil {
				return nil, fmt.Errorf("items[%d].membership: %w", index, err)
			}
			at := strings.IndexByte(email, '@')
			if at < 1 || at != strings.LastIndexByte(email, '@') || at == len(email)-1 ||
				strings.ContainsAny(email, " \t\r\n") {
				return nil, fmt.Errorf("items[%d].membership email is invalid", index)
			}
			displayName, err := requiredString(membership, "display_name")
			if err != nil {
				return nil, fmt.Errorf("items[%d].membership: %w", index, err)
			}
			role, err := requiredString(membership, "role")
			if err != nil {
				return nil, fmt.Errorf("items[%d].membership: %w", index, err)
			}
			if role != "admin" && role != "member" {
				return nil, fmt.Errorf("items[%d].membership role is invalid", index)
			}
			source, err := requiredString(membership, "source")
			if err != nil {
				return nil, fmt.Errorf("items[%d].membership: %w", index, err)
			}
			if source != "local" && source != "scim" {
				return nil, fmt.Errorf("items[%d].membership source is invalid", index)
			}
			memberActive, err := requiredBool(membership, "active")
			if err != nil {
				return nil, fmt.Errorf("items[%d].membership: %w", index, err)
			}
			memberCreated, err := requiredTimestamp(membership, "created_at")
			if err != nil {
				return nil, fmt.Errorf("items[%d].membership: %w", index, err)
			}
			memberUpdated, err := requiredTimestamp(membership, "updated_at")
			if err != nil {
				return nil, fmt.Errorf("items[%d].membership: %w", index, err)
			}
			projected = append(projected, map[string]any{
				"user": upstreamDirectoryUser{
					ID: userID, SystemRole: systemRole, Active: userActive,
					CreatedAt: userCreated, UpdatedAt: userUpdated,
				},
				"membership": upstreamDirectoryMembership{
					ID: membershipID, UserID: membershipUser, Email: email,
					DisplayName: displayName, Role: role, Source: source,
					Active: memberActive, CreatedAt: memberCreated, UpdatedAt: memberUpdated,
				},
			})
		}
		return json.Marshal(map[string]any{"items": projected, "next_cursor": next})
	}
}

func projectDirectoryGroupPage(organizationID string, limit int, inputCursor string) payloadProjector {
	return func(raw []byte) ([]byte, error) {
		fields, err := decodePageEnvelope(raw)
		if err != nil {
			return nil, err
		}
		nextRaw, present := fields["next_cursor"]
		if !present {
			return nil, fmt.Errorf("next_cursor is missing")
		}
		next, err := decodePageCursorValue(nextRaw, inputCursor)
		if err != nil {
			return nil, err
		}
		itemsRaw, present := fields["items"]
		if !present {
			return nil, fmt.Errorf("items is missing")
		}
		var items []json.RawMessage
		if err := json.Unmarshal(itemsRaw, &items); err != nil || items == nil {
			return nil, fmt.Errorf("items is invalid")
		}
		if len(items) > limit || len(items) > directoryPageMaximumLimit {
			return nil, fmt.Errorf("items exceeds the page bound")
		}
		if len(items) == 0 && next != nil {
			return nil, fmt.Errorf("empty page must terminate the cursor")
		}
		projected := make([]upstreamDirectoryGroup, 0, len(items))
		for index, itemRaw := range items {
			var item map[string]json.RawMessage
			if err := serviceauth.DecodeObject(itemRaw, &item); err != nil {
				return nil, fmt.Errorf("items[%d]: %w", index, err)
			}
			if _, err := requiredString(item, "id"); err != nil {
				return nil, fmt.Errorf("items[%d]: %w", index, err)
			}
			groupOrg, err := requiredString(item, "organization_id")
			if err != nil {
				return nil, fmt.Errorf("items[%d]: %w", index, err)
			}
			if groupOrg != organizationID {
				return nil, fmt.Errorf("items[%d] is outside the caller organization", index)
			}
			displayName, err := requiredString(item, "display_name")
			if err != nil {
				return nil, fmt.Errorf("items[%d]: %w", index, err)
			}
			source, err := requiredString(item, "source")
			if err != nil {
				return nil, fmt.Errorf("items[%d]: %w", index, err)
			}
			if source != "local" && source != "scim" {
				return nil, fmt.Errorf("items[%d] source is invalid", index)
			}
			active, err := requiredBool(item, "active")
			if err != nil {
				return nil, fmt.Errorf("items[%d]: %w", index, err)
			}
			created, err := requiredTimestamp(item, "created_at")
			if err != nil {
				return nil, fmt.Errorf("items[%d]: %w", index, err)
			}
			updated, err := requiredTimestamp(item, "updated_at")
			if err != nil {
				return nil, fmt.Errorf("items[%d]: %w", index, err)
			}
			projected = append(projected, upstreamDirectoryGroup{
				DisplayName: displayName, Source: source, Active: active,
				CreatedAt: created, UpdatedAt: updated,
			})
		}
		return json.Marshal(map[string]any{"items": projected, "next_cursor": next})
	}
}
