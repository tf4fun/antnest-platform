package identity

import (
	"context"
	"fmt"
	"net/http"
	"net/url"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/tf4fun/antnest-platform/modules/service-authentication/callercontext"
)

// CurrentAccount is the browser projection. Identity's organization display
// fields are intentionally not part of the Gateway account response contract.
type CurrentAccount struct {
	UserID                 string `json:"user_id"`
	OrganizationID         string `json:"organization_id"`
	MembershipID           string `json:"membership_id"`
	Email                  string `json:"email"`
	DisplayName            string `json:"display_name"`
	Source                 string `json:"source"`
	LocalPasswordAvailable bool   `json:"local_password_available"`
}

type PasswordInput struct {
	RequestID       string
	CurrentPassword string
	NewPassword     string
}

type BrowserSession struct {
	ID               string    `json:"id"`
	OrganizationID   string    `json:"organization_id"`
	OrganizationSlug string    `json:"organization_slug"`
	OrganizationName string    `json:"organization_name"`
	CreatedAt        time.Time `json:"created_at"`
	LastActiveAt     time.Time `json:"last_active_at"`
	IdleExpiresAt    time.Time `json:"idle_expires_at"`
	ExpiresAt        time.Time `json:"expires_at"`
	UserAgentHint    string    `json:"user_agent_hint"`
	Current          bool      `json:"current"`
}

type SessionPage struct {
	Sessions    []BrowserSession `json:"sessions"`
	NextAfterID string           `json:"next_after_id,omitempty"`
}

type SessionListInput struct {
	Limit   int
	AfterID string
}

type SessionRevokeInput struct {
	RequestID string
	Mode      string
}

type SessionRevokeResult struct {
	RevokedCount   int  `json:"revoked_count"`
	CurrentRevoked bool `json:"current_revoked"`
}

// SessionRevocation is private process input, never a browser response.
type SessionRevocation struct {
	Sequence       int64     `json:"sequence"`
	TokenID        string    `json:"token_id"`
	UserID         string    `json:"user_id"`
	OrganizationID string    `json:"organization_id"`
	Reason         string    `json:"reason"`
	OccurredAt     time.Time `json:"occurred_at"`
	TraceParent    string    `json:"traceparent,omitempty"`
}

type SessionRevocationPage struct {
	Events       []SessionRevocation `json:"events"`
	NextSequence int64               `json:"next_sequence"`
}

func browserPrincipal(ctx context.Context) (Principal, error) {
	principal, ok := FromContext(ctx)
	if !ok || !principal.Active || strings.TrimSpace(principal.CallerContext) == "" ||
		!callercontext.ValidID(principal.UserID) || !callercontext.ValidID(principal.OrganizationID) ||
		!callercontext.ValidID(principal.MembershipID) || !callercontext.ValidID(principal.SessionID) ||
		!principal.SessionMetadata().Valid() {
		return Principal{}, fmt.Errorf("browser operation requires verified session authority")
	}
	return principal, nil
}

func (client *Client) browserRequest(ctx context.Context, principal Principal, method string, input, output any) error {
	target := client.base.ResolveReference(&url.URL{Path: "/rpc/identity/" + method})
	return client.doRequestWithCaller(ctx, http.MethodPost, target, input, output, principal.CallerContext)
}

func (client *Client) CurrentAccount(ctx context.Context) (CurrentAccount, error) {
	principal, err := browserPrincipal(ctx)
	if err != nil {
		return CurrentAccount{}, err
	}
	var result struct {
		Account *struct {
			CurrentAccount
			LocalPasswordAvailable *bool `json:"local_password_available"`
		} `json:"account"`
	}
	err = client.browserRequest(ctx, principal, "get-current-account", map[string]string{
		"actor_principal_id": principal.UserID, "organization_id": principal.OrganizationID,
	}, &result)
	if err != nil {
		return CurrentAccount{}, err
	}
	if result.Account == nil || result.Account.LocalPasswordAvailable == nil {
		return CurrentAccount{}, fmt.Errorf("identity returned incomplete account")
	}
	account := result.Account.CurrentAccount
	account.LocalPasswordAvailable = *result.Account.LocalPasswordAvailable
	if !ValidPublicID(account.UserID) || !ValidPublicID(account.OrganizationID) || !ValidPublicID(account.MembershipID) ||
		account.UserID != principal.UserID || account.OrganizationID != principal.OrganizationID ||
		account.MembershipID != principal.MembershipID || !hasDisplayText(account.Email) ||
		!hasDisplayText(account.DisplayName) || account.Source != "local" && account.Source != "scim" {
		return CurrentAccount{}, fmt.Errorf("identity returned invalid current account")
	}
	return account, nil
}

func (client *Client) TouchSession(ctx context.Context) (SessionMetadata, error) {
	principal, err := browserPrincipal(ctx)
	if err != nil {
		return SessionMetadata{}, err
	}
	var result SessionMetadata
	err = client.browserRequest(ctx, principal, "touch-browser-session", map[string]string{"actor_principal_id": principal.UserID}, &result)
	if err != nil {
		return SessionMetadata{}, err
	}
	if !result.Valid() || !result.ExpiresAt.Equal(principal.ExpiresAt) {
		return SessionMetadata{}, fmt.Errorf("identity returned invalid activity metadata")
	}
	return result, nil
}

func (client *Client) ChangePassword(ctx context.Context, input PasswordInput) (LoginResult, error) {
	principal, err := browserPrincipal(ctx)
	if err != nil {
		return LoginResult{}, err
	}
	var result struct {
		LoginResult
		Status    string             `json:"status"`
		Principal *principalResponse `json:"principal"`
	}
	err = client.browserRequest(ctx, principal, "change-local-password", map[string]string{
		"request_id": input.RequestID, "actor_principal_id": principal.UserID, "user_id": principal.UserID,
		"current_password": input.CurrentPassword, "new_password": input.NewPassword,
	}, &result)
	if err != nil {
		return LoginResult{}, err
	}
	replacement, err := result.Principal.verified()
	if err != nil {
		return LoginResult{}, err
	}
	if result.Status != "changed" || !replacement.Active || replacement.UserID != principal.UserID ||
		replacement.OrganizationID != principal.OrganizationID || replacement.MembershipID != principal.MembershipID ||
		!callercontext.ValidID(result.TokenID) || result.TokenID == principal.SessionID || result.AccessToken == "" ||
		!result.LoginResult.SessionMetadata().Valid() || !result.ExpiresAt.Equal(principal.ExpiresAt) {
		return LoginResult{}, fmt.Errorf("identity returned invalid password replacement")
	}
	result.LoginResult.Principal = replacement
	return result.LoginResult, nil
}

func (client *Client) ListSessions(ctx context.Context, input SessionListInput) (SessionPage, error) {
	principal, err := browserPrincipal(ctx)
	if err != nil {
		return SessionPage{}, err
	}
	if input.Limit < 1 || input.Limit > 100 || input.AfterID != "" && !ValidPublicID(input.AfterID) {
		return SessionPage{}, fmt.Errorf("invalid session page query")
	}
	var result struct {
		Sessions []struct {
			BrowserSession
			Current       *bool   `json:"current"`
			UserAgentHint *string `json:"user_agent_hint"`
		} `json:"sessions"`
		NextAfterID string `json:"next_after_id"`
	}
	body := map[string]any{"actor_principal_id": principal.UserID, "user_id": principal.UserID, "scope": "self", "limit": input.Limit}
	if input.AfterID != "" {
		body["after_id"] = input.AfterID
	}
	if err := client.browserRequest(ctx, principal, "list-user-sessions", body, &result); err != nil {
		return SessionPage{}, err
	}
	if result.Sessions == nil || len(result.Sessions) > input.Limit {
		return SessionPage{}, fmt.Errorf("identity returned invalid session page")
	}
	page := SessionPage{Sessions: make([]BrowserSession, 0, len(result.Sessions)), NextAfterID: result.NextAfterID}
	previous := input.AfterID
	for _, row := range result.Sessions {
		value := row.BrowserSession
		if !ValidPublicID(value.ID) || value.ID <= previous || !ValidPublicID(value.OrganizationID) ||
			!hasDisplayText(value.OrganizationSlug) || !hasDisplayText(value.OrganizationName) ||
			value.CreatedAt.IsZero() || value.LastActiveAt.IsZero() || value.ExpiresAt.IsZero() || value.IdleExpiresAt.IsZero() ||
			value.IdleExpiresAt.After(value.ExpiresAt) || row.Current == nil || row.UserAgentHint == nil ||
			utf8.RuneCountInString(*row.UserAgentHint) > 256 {
			return SessionPage{}, fmt.Errorf("identity returned invalid public session")
		}
		value.Current, value.UserAgentHint = *row.Current, *row.UserAgentHint
		page.Sessions = append(page.Sessions, value)
		previous = value.ID
	}
	// Identity may filter rows that expire after its scan. The cursor describes
	// the scanned window, so it can advance beyond the last visible row even
	// when every row in this page expired before the final authority check.
	if result.NextAfterID != "" && (!ValidPublicID(result.NextAfterID) || result.NextAfterID <= input.AfterID || result.NextAfterID < previous) {
		return SessionPage{}, fmt.Errorf("identity returned invalid session cursor")
	}
	return page, nil
}

func (client *Client) RevokeSessions(ctx context.Context, input SessionRevokeInput) (SessionRevokeResult, error) {
	principal, err := browserPrincipal(ctx)
	if err != nil {
		return SessionRevokeResult{}, err
	}
	if input.Mode != "all" && input.Mode != "others" {
		return SessionRevokeResult{}, fmt.Errorf("invalid session revocation mode")
	}
	var result struct {
		RevokedCount   *int  `json:"revoked_count"`
		CurrentRevoked *bool `json:"current_revoked"`
	}
	err = client.browserRequest(ctx, principal, "revoke-user-sessions", map[string]string{
		"request_id": input.RequestID, "actor_principal_id": principal.UserID, "user_id": principal.UserID, "scope": "self", "mode": input.Mode,
	}, &result)
	if err != nil {
		return SessionRevokeResult{}, err
	}
	if result.RevokedCount == nil || result.CurrentRevoked == nil || *result.RevokedCount < 0 ||
		*result.CurrentRevoked && (*result.RevokedCount == 0 || input.Mode == "others") {
		return SessionRevokeResult{}, fmt.Errorf("identity returned invalid session revocation")
	}
	return SessionRevokeResult{RevokedCount: *result.RevokedCount, CurrentRevoked: *result.CurrentRevoked}, nil
}

func (client *Client) ListSessionRevocations(ctx context.Context, after int64, limit int) (SessionRevocationPage, error) {
	if after < 0 || limit < 1 || limit > 500 {
		return SessionRevocationPage{}, fmt.Errorf("invalid session feed query")
	}
	var result struct {
		Events       []SessionRevocation `json:"events"`
		NextSequence *int64              `json:"next_sequence"`
	}
	// This workload operation deliberately does not forward a browser CCT.
	err := client.doJSON(ctx, http.MethodPost, "/rpc/identity/list-session-revocations", map[string]any{"after_sequence": after, "limit": limit}, &result)
	if err != nil {
		return SessionRevocationPage{}, err
	}
	if result.Events == nil || len(result.Events) > limit || result.NextSequence == nil {
		return SessionRevocationPage{}, fmt.Errorf("identity returned invalid session feed")
	}
	previous := after
	for _, event := range result.Events {
		if event.Sequence <= previous || !callercontext.ValidID(event.TokenID) || !callercontext.ValidID(event.UserID) ||
			!callercontext.ValidID(event.OrganizationID) || event.OccurredAt.IsZero() || !validSessionRevocationReason(event.Reason) {
			return SessionRevocationPage{}, fmt.Errorf("identity returned invalid session event")
		}
		previous = event.Sequence
	}
	if *result.NextSequence != previous {
		return SessionRevocationPage{}, fmt.Errorf("identity returned invalid session feed cursor")
	}
	return SessionRevocationPage{Events: result.Events, NextSequence: previous}, nil
}

func validSessionRevocationReason(reason string) bool {
	switch reason {
	case "session_revoked", "password_changed", "role_changed", "user_deactivated", "membership_deactivated", "membership_deleted":
		return true
	default:
		return false
	}
}
