package principal

import (
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
	return principal, nil
}

func (principal Principal) Administrator() bool {
	return principal.SystemRole == "admin" || principal.OrganizationRole == "admin"
}

func valid(value string) bool {
	if value == "" || len(value) > 200 || strings.TrimSpace(value) != value {
		return false
	}
	for _, character := range value {
		if character < 0x21 || character > 0x7e {
			return false
		}
	}
	return true
}
