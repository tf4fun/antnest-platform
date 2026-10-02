package domain

import (
	"fmt"
	"net/mail"
	"regexp"
	"sort"
	"strings"
	"time"
)

type SystemRole string

const (
	SystemRoleUser  SystemRole = "user"
	SystemRoleAdmin SystemRole = "admin"
)

type OrganizationRole string

const (
	OrganizationRoleMember OrganizationRole = "member"
	OrganizationRoleAdmin  OrganizationRole = "admin"
)

type Source string

const (
	SourceLocal Source = "local"
	SourceSCIM  Source = "scim"
)

type Organization struct {
	ID        string    `json:"id"`
	Slug      string    `json:"slug"`
	Name      string    `json:"name"`
	Active    bool      `json:"active"`
	CreatedAt time.Time `json:"created_at"`
	UpdatedAt time.Time `json:"updated_at"`
}

type User struct {
	ID         string     `json:"id"`
	SystemRole SystemRole `json:"system_role"`
	Active     bool       `json:"active"`
	CreatedAt  time.Time  `json:"created_at"`
	UpdatedAt  time.Time  `json:"updated_at"`
}

type LocalCredential struct {
	UserID       string    `json:"user_id"`
	PasswordHash string    `json:"-"`
	CreatedAt    time.Time `json:"created_at"`
	UpdatedAt    time.Time `json:"updated_at"`
}

type OrganizationMembership struct {
	ID             string           `json:"id"`
	OrganizationID string           `json:"organization_id"`
	UserID         string           `json:"user_id"`
	Email          string           `json:"email"`
	DisplayName    string           `json:"display_name"`
	Role           OrganizationRole `json:"role"`
	Source         Source           `json:"source"`
	Active         bool             `json:"active"`
	SCIMExternalID string           `json:"scim_external_id,omitempty"`
	SCIMUserName   string           `json:"scim_user_name,omitempty"`
	SCIMDeletedAt  *time.Time       `json:"scim_deleted_at,omitempty"`
	CreatedAt      time.Time        `json:"created_at"`
	UpdatedAt      time.Time        `json:"updated_at"`
}

type Group struct {
	ID             string    `json:"id"`
	OrganizationID string    `json:"organization_id"`
	DisplayName    string    `json:"display_name"`
	Source         Source    `json:"source"`
	Active         bool      `json:"active"`
	SCIMExternalID string    `json:"scim_external_id,omitempty"`
	CreatedAt      time.Time `json:"created_at"`
	UpdatedAt      time.Time `json:"updated_at"`
}

type GroupMembership struct {
	ID                       string    `json:"id"`
	GroupID                  string    `json:"group_id"`
	OrganizationMembershipID string    `json:"organization_membership_id"`
	Source                   Source    `json:"source"`
	Active                   bool      `json:"active"`
	CreatedAt                time.Time `json:"created_at"`
	UpdatedAt                time.Time `json:"updated_at"`
}

type Principal struct {
	UserID           string           `json:"user_id"`
	OrganizationID   string           `json:"organization_id"`
	OrganizationSlug string           `json:"organization_slug"`
	OrganizationName string           `json:"organization_name"`
	MembershipID     string           `json:"membership_id"`
	SystemRole       SystemRole       `json:"system_role"`
	OrganizationRole OrganizationRole `json:"organization_role"`
	Active           bool             `json:"active"`
}

func (p Principal) CanAdminister(organizationID string) bool {
	if !p.Active {
		return false
	}
	return p.SystemRole == SystemRoleAdmin ||
		(p.OrganizationID == organizationID && p.OrganizationRole == OrganizationRoleAdmin)
}

const (
	SCIMScopeRead  = "scim:read"
	SCIMScopeWrite = "scim:write"
)

var (
	idPattern   = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9_.-]{0,199}$`)
	slugPattern = regexp.MustCompile(`^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$`)
)

func ValidID(value string) bool {
	return idPattern.MatchString(value)
}

func NormalizeEmail(value string) (string, error) {
	normalized := strings.ToLower(strings.TrimSpace(value))
	if len(normalized) == 0 || len(normalized) > 254 || strings.Count(normalized, "@") != 1 {
		return "", InvalidArgument("email is invalid")
	}
	address, err := mail.ParseAddress(normalized)
	if err != nil || address.Address != normalized {
		return "", InvalidArgument("email is invalid")
	}
	parts := strings.Split(normalized, "@")
	if parts[0] == "" || parts[1] == "" {
		return "", InvalidArgument("email is invalid")
	}
	return normalized, nil
}

func NormalizeSlug(value string) (string, error) {
	normalized := strings.ToLower(strings.TrimSpace(value))
	if !slugPattern.MatchString(normalized) {
		return "", InvalidArgument("organization slug is invalid")
	}
	return normalized, nil
}

func NormalizeDisplayName(value string) (string, error) {
	normalized := strings.TrimSpace(value)
	if len(normalized) == 0 || len(normalized) > 200 {
		return "", InvalidArgument("display name must contain between 1 and 200 bytes")
	}
	return normalized, nil
}

func NextUpdatedAt(now, current time.Time) time.Time {
	now = now.UTC().Truncate(time.Microsecond)
	current = current.UTC().Truncate(time.Microsecond)
	if now.After(current) {
		return now
	}
	return current.Add(time.Microsecond)
}

func NormalizeSCIMUserName(value string) (string, error) {
	normalized := strings.ToLower(strings.TrimSpace(value))
	if len(normalized) == 0 || len(normalized) > 254 {
		return "", InvalidArgument("SCIM userName must contain between 1 and 254 bytes")
	}
	return normalized, nil
}

func NormalizeSCIMScopes(input []string) ([]string, error) {
	seen := make(map[string]struct{}, len(input))
	for _, value := range input {
		scope := strings.TrimSpace(value)
		if scope != SCIMScopeRead && scope != SCIMScopeWrite {
			return nil, InvalidArgument(fmt.Sprintf("unknown SCIM scope %q", scope))
		}
		seen[scope] = struct{}{}
	}
	if len(seen) == 0 {
		return nil, InvalidArgument("at least one SCIM scope is required")
	}
	result := make([]string, 0, len(seen))
	for value := range seen {
		result = append(result, value)
	}
	sort.Strings(result)
	return result, nil
}
