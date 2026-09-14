package principal

import (
	"context"
	"fmt"
	"net/http"
	"strings"
)

const (
	HeaderUserID           = "X-Antnest-User-ID"
	HeaderOrganizationID   = "X-Antnest-Organization-ID"
	HeaderMembershipID     = "X-Antnest-Membership-ID"
	HeaderSystemRole       = "X-Antnest-System-Role"
	HeaderOrganizationRole = "X-Antnest-Organization-Role"
)

type Principal struct {
	UserID           string `json:"user_id"`
	OrganizationID   string `json:"organization_id"`
	MembershipID     string `json:"membership_id"`
	SystemRole       string `json:"system_role"`
	OrganizationRole string `json:"organization_role"`
}

func FromHeaders(header http.Header) (Principal, error) {
	principal := Principal{}
	fields := []struct {
		name   string
		target *string
	}{
		{name: HeaderUserID, target: &principal.UserID},
		{name: HeaderOrganizationID, target: &principal.OrganizationID},
		{name: HeaderMembershipID, target: &principal.MembershipID},
		{name: HeaderSystemRole, target: &principal.SystemRole},
		{name: HeaderOrganizationRole, target: &principal.OrganizationRole},
	}
	for _, field := range fields {
		values := header.Values(field.name)
		if len(values) != 1 || !valid(values[0]) {
			return Principal{}, fmt.Errorf("trusted principal header %s is missing or invalid", field.name)
		}
		*field.target = values[0]
	}
	if (principal.SystemRole != "admin" && principal.SystemRole != "user") ||
		(principal.OrganizationRole != "admin" && principal.OrganizationRole != "member") {
		return Principal{}, fmt.Errorf("trusted principal role is invalid")
	}
	return principal, nil
}

type contextKey struct{}

func WithContext(ctx context.Context, actor Principal) context.Context {
	return context.WithValue(ctx, contextKey{}, actor)
}

func FromContext(ctx context.Context) (Principal, bool) {
	actor, ok := ctx.Value(contextKey{}).(Principal)
	return actor, ok
}

func (principal Principal) Headers() (http.Header, error) {
	header := make(http.Header)
	header.Set(HeaderUserID, principal.UserID)
	header.Set(HeaderOrganizationID, principal.OrganizationID)
	header.Set(HeaderMembershipID, principal.MembershipID)
	header.Set(HeaderSystemRole, principal.SystemRole)
	header.Set(HeaderOrganizationRole, principal.OrganizationRole)
	if _, err := FromHeaders(header); err != nil {
		return nil, err
	}
	return header, nil
}

func (principal Principal) Administrator() bool {
	return principal.SystemRole == "admin" || principal.OrganizationRole == "admin"
}

func (principal Principal) SystemAdministrator() bool {
	return principal.SystemRole == "admin"
}

func valid(value string) bool {
	if value == "" || len(value) > 200 || strings.TrimSpace(value) != value {
		return false
	}
	for _, character := range value {
		if character < 0x20 || character > 0x7e || character == ',' {
			return false
		}
	}
	return true
}
