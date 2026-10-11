package identity

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"regexp"
	"strings"
	"time"
	"unicode"

	"github.com/tf4fun/antnest-platform/modules/service-authentication/serviceauth"
)

// ExternalIdentityDetails is the public binding or immutable notice snapshot.
// Self inventory can contain organizations other than the active session's.
type ExternalIdentityDetails struct {
	ID                  string    `json:"id"`
	ProviderID          string    `json:"provider_id"`
	ProviderName        string    `json:"provider_name"`
	ProviderDisplayName string    `json:"provider_display_name"`
	OrganizationID      string    `json:"organization_id"`
	OrganizationSlug    string    `json:"organization_slug"`
	OrganizationName    string    `json:"organization_name"`
	MembershipID        string    `json:"membership_id"`
	Subject             string    `json:"subject"`
	Method              string    `json:"method"`
	CreatedAt           time.Time `json:"created_at"`
}

type ExternalIdentity struct {
	ExternalIdentityDetails
	ProviderEnabled bool       `json:"provider_enabled"`
	BoundAt         time.Time  `json:"bound_at"`
	RevokedAt       *time.Time `json:"revoked_at"`
}

type ExternalIdentityNotice struct {
	ExternalIdentityDetails
	BindingID string `json:"binding_id"`
}

type ExternalIdentityPage struct {
	Bindings          []ExternalIdentity       `json:"bindings"`
	Notices           []ExternalIdentityNotice `json:"notices"`
	NextAfterID       string                   `json:"next_after_id,omitempty"`
	NextNoticeAfterID string                   `json:"next_notice_after_id,omitempty"`
}

type ExternalIdentityListInput struct {
	Limit                  int
	AfterID, NoticeAfterID string
}

type ExternalIdentityUnbindInput struct {
	RequestID, BindingID string
	AllowLockout         bool
}

type ExternalIdentityAcknowledgeInput struct {
	RequestID string
	NoticeIDs []string
}

type ExternalIdentityAcknowledgeResult struct {
	AcknowledgedCount int `json:"acknowledged_count"`
}

// Wire fields preserve required Boolean presence and raw subject/null values.
// Dates are strings here because the strict object decoder recursively checks
// struct fields and deliberately does not invoke time.Time's custom decoder.
type externalIdentityDetailsWire struct {
	ExternalIdentityDetails
	Subject   json.RawMessage `json:"subject"`
	CreatedAt string          `json:"created_at"`
}

type externalIdentityBindingWire struct {
	externalIdentityDetailsWire
	ProviderEnabled *bool           `json:"provider_enabled"`
	BoundAt         string          `json:"bound_at"`
	RevokedAt       json.RawMessage `json:"revoked_at"`
}

type externalIdentityNoticeWire struct {
	externalIdentityDetailsWire
	BindingID string `json:"binding_id"`
}

func (wire externalIdentityDetailsWire) verified() (ExternalIdentityDetails, error) {
	value := wire.ExternalIdentityDetails
	if !ValidPublicID(value.ID) || !ValidPublicID(value.ProviderID) || !ValidPublicID(value.OrganizationID) || !ValidPublicID(value.MembershipID) ||
		!externalIdentityDisplayText(value.ProviderName) || !externalIdentityDisplayText(value.ProviderDisplayName) || !externalIdentityDisplayText(value.OrganizationSlug) || !externalIdentityDisplayText(value.OrganizationName) ||
		(value.Method != "auto" && value.Method != "admin" && value.Method != "scim") {
		return ExternalIdentityDetails{}, fmt.Errorf("invalid external identity details")
	}
	var err error
	if value.Subject, err = parseExternalIdentitySubject(wire.Subject); err != nil {
		return ExternalIdentityDetails{}, err
	}
	if value.CreatedAt, err = externalIdentityTimestamp(wire.CreatedAt); err != nil {
		return ExternalIdentityDetails{}, err
	}
	return value, nil
}

func externalIdentityDisplayText(value string) bool {
	// Match the response schema's ECMAScript \S: NEL is not whitespace there,
	// while U+FEFF is. Do not normalize the text that Identity supplied.
	return strings.TrimFunc(value, func(r rune) bool {
		return r == '\uFEFF' || r != '\u0085' && unicode.IsSpace(r)
	}) != ""
}

var externalIdentityTimestampPattern = regexp.MustCompile(`^[0-9]{4}-[0-9]{2}-[0-9]{2}[Tt][0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]+)?([Zz]|[+-]([01][0-9]|2[0-3]):[0-5][0-9])$`)

func externalIdentityTimestamp(value string) (time.Time, error) {
	// Go's parser also accepts comma fractions, single-digit hours and invalid
	// offset components. Check the RFC3339 grammar before its calendar validation.
	if !externalIdentityTimestampPattern.MatchString(value) {
		return time.Time{}, fmt.Errorf("invalid external identity timestamp")
	}
	parsed, err := time.Parse(time.RFC3339Nano, strings.ToUpper(value))
	if err != nil || parsed.IsZero() {
		return time.Time{}, fmt.Errorf("invalid external identity timestamp")
	}
	return parsed, nil
}

func externalIdentityCursor(raw json.RawMessage, after, last string) (string, error) {
	if raw == nil {
		return "", nil
	}
	var cursor string
	if json.Unmarshal(raw, &cursor) != nil || !ValidPublicID(cursor) || cursor <= after || cursor < last {
		return "", fmt.Errorf("invalid external identity cursor")
	}
	return cursor, nil
}

func (client *Client) externalIdentityRequest(ctx context.Context, principal Principal, method string, body, result any) error {
	var raw json.RawMessage
	if err := client.browserRequest(ctx, principal, method, body, &raw); err != nil {
		return err
	}
	if err := serviceauth.DecodeObject(raw, result); err != nil {
		return fmt.Errorf("invalid external identity response: %w", err)
	}
	return nil
}

func (client *Client) ListExternalIdentities(ctx context.Context, input ExternalIdentityListInput) (ExternalIdentityPage, error) {
	principal, err := browserPrincipal(ctx)
	if err != nil {
		return ExternalIdentityPage{}, err
	}
	if input.Limit < 1 || input.Limit > 100 || input.AfterID != "" && !ValidPublicID(input.AfterID) || input.NoticeAfterID != "" && !ValidPublicID(input.NoticeAfterID) {
		return ExternalIdentityPage{}, fmt.Errorf("invalid external identity pagination")
	}
	body := map[string]any{"actor_principal_id": principal.UserID, "scope": "self", "limit": input.Limit}
	if input.AfterID != "" {
		body["after_id"] = input.AfterID
	}
	if input.NoticeAfterID != "" {
		body["notice_after_id"] = input.NoticeAfterID
	}
	var wire struct {
		Bindings          []externalIdentityBindingWire `json:"bindings"`
		Notices           []externalIdentityNoticeWire  `json:"notices"`
		NextAfterID       json.RawMessage               `json:"next_after_id"`
		NextNoticeAfterID json.RawMessage               `json:"next_notice_after_id"`
	}
	if err := client.externalIdentityRequest(ctx, principal, "list-external-identities", body, &wire); err != nil {
		return ExternalIdentityPage{}, err
	}
	if wire.Bindings == nil || wire.Notices == nil || len(wire.Bindings) > input.Limit || len(wire.Notices) > input.Limit {
		return ExternalIdentityPage{}, fmt.Errorf("invalid external identity page")
	}
	result := ExternalIdentityPage{Bindings: make([]ExternalIdentity, 0, len(wire.Bindings)), Notices: make([]ExternalIdentityNotice, 0, len(wire.Notices))}
	previous := input.AfterID
	for _, item := range wire.Bindings {
		details, err := item.verified()
		if err != nil {
			return ExternalIdentityPage{}, err
		}
		if details.ID <= previous || item.ProviderEnabled == nil || item.RevokedAt == nil {
			return ExternalIdentityPage{}, fmt.Errorf("invalid external identity binding")
		}
		boundAt, err := externalIdentityTimestamp(item.BoundAt)
		if err != nil {
			return ExternalIdentityPage{}, err
		}
		value := ExternalIdentity{ExternalIdentityDetails: details, ProviderEnabled: *item.ProviderEnabled, BoundAt: boundAt}
		if !bytes.Equal(bytes.TrimSpace(item.RevokedAt), []byte("null")) {
			var timestamp string
			if json.Unmarshal(item.RevokedAt, &timestamp) != nil {
				return ExternalIdentityPage{}, fmt.Errorf("invalid external identity revocation")
			}
			revokedAt, err := externalIdentityTimestamp(timestamp)
			if err != nil {
				return ExternalIdentityPage{}, err
			}
			value.RevokedAt = &revokedAt
		}
		result.Bindings = append(result.Bindings, value)
		previous = details.ID
	}
	if result.NextAfterID, err = externalIdentityCursor(wire.NextAfterID, input.AfterID, previous); err != nil {
		return ExternalIdentityPage{}, err
	}
	previous = input.NoticeAfterID
	for _, item := range wire.Notices {
		details, err := item.verified()
		if err != nil {
			return ExternalIdentityPage{}, err
		}
		if details.ID <= previous || !ValidPublicID(item.BindingID) {
			return ExternalIdentityPage{}, fmt.Errorf("invalid external identity notice")
		}
		result.Notices = append(result.Notices, ExternalIdentityNotice{ExternalIdentityDetails: details, BindingID: item.BindingID})
		previous = details.ID
	}
	if result.NextNoticeAfterID, err = externalIdentityCursor(wire.NextNoticeAfterID, input.NoticeAfterID, previous); err != nil {
		return ExternalIdentityPage{}, err
	}
	return result, nil
}

func (client *Client) UnbindExternalIdentity(ctx context.Context, input ExternalIdentityUnbindInput) (SessionRevokeResult, error) {
	principal, err := browserPrincipal(ctx)
	if err != nil {
		return SessionRevokeResult{}, err
	}
	if !ValidPublicID(input.RequestID) || !ValidPublicID(input.BindingID) {
		return SessionRevokeResult{}, fmt.Errorf("invalid external identity unbind")
	}
	var result struct {
		RevokedCount   *int  `json:"revoked_count"`
		CurrentRevoked *bool `json:"current_revoked"`
	}
	err = client.externalIdentityRequest(ctx, principal, "unbind-external-identity", map[string]any{
		"request_id": input.RequestID, "actor_principal_id": principal.UserID, "scope": "self", "binding_id": input.BindingID, "allow_lockout": input.AllowLockout,
	}, &result)
	if err != nil {
		return SessionRevokeResult{}, err
	}
	if result.RevokedCount == nil || result.CurrentRevoked == nil || *result.RevokedCount < 0 || *result.CurrentRevoked && *result.RevokedCount == 0 {
		return SessionRevokeResult{}, fmt.Errorf("invalid external identity revocation result")
	}
	return SessionRevokeResult{RevokedCount: *result.RevokedCount, CurrentRevoked: *result.CurrentRevoked}, nil
}

// ValidExternalIdentityNoticeIDs validates a bounded, explicit acknowledgment set.
func ValidExternalIdentityNoticeIDs(ids []string) bool {
	if len(ids) < 1 || len(ids) > 100 {
		return false
	}
	seen := make(map[string]bool, len(ids))
	for _, id := range ids {
		if !ValidPublicID(id) || seen[id] {
			return false
		}
		seen[id] = true
	}
	return true
}

func (client *Client) AcknowledgeExternalIdentityNotices(ctx context.Context, input ExternalIdentityAcknowledgeInput) (ExternalIdentityAcknowledgeResult, error) {
	principal, err := browserPrincipal(ctx)
	if err != nil {
		return ExternalIdentityAcknowledgeResult{}, err
	}
	if !ValidPublicID(input.RequestID) || !ValidExternalIdentityNoticeIDs(input.NoticeIDs) {
		return ExternalIdentityAcknowledgeResult{}, fmt.Errorf("invalid external identity acknowledgment")
	}
	var result struct {
		AcknowledgedCount *int `json:"acknowledged_count"`
	}
	err = client.externalIdentityRequest(ctx, principal, "acknowledge-external-identity-notices", map[string]any{
		"request_id": input.RequestID, "actor_principal_id": principal.UserID, "notice_ids": input.NoticeIDs,
	}, &result)
	if err != nil {
		return ExternalIdentityAcknowledgeResult{}, err
	}
	if result.AcknowledgedCount == nil || *result.AcknowledgedCount < 0 || *result.AcknowledgedCount > len(input.NoticeIDs) {
		return ExternalIdentityAcknowledgeResult{}, fmt.Errorf("invalid external identity acknowledgment result")
	}
	return ExternalIdentityAcknowledgeResult{AcknowledgedCount: *result.AcknowledgedCount}, nil
}
