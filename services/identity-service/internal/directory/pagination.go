package directory

import (
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"strings"
	"unicode/utf8"

	"github.com/tf4fun/antnest-platform/modules/service-authentication/serviceauth"
	"github.com/tf4fun/antnest-platform/services/identity-service/internal/domain"
)

const (
	memberPageKind     = "members"
	groupPageKind      = "groups"
	cursorVersion      = 1
	maximumPageLimit   = 200
	maximumPrefixBytes = 256
	maximumCursorBytes = 4096
)

type MemberFilter struct {
	EmailPrefix string                  `json:"email_prefix,omitempty"`
	Role        domain.OrganizationRole `json:"role,omitempty"`
	Active      *bool                   `json:"active,omitempty"`
	Source      domain.Source           `json:"source,omitempty"`
}

type GroupFilter struct {
	DisplayNamePrefix string        `json:"display_name_prefix,omitempty"`
	Active            *bool         `json:"active,omitempty"`
	Source            domain.Source `json:"source,omitempty"`
}

type ListMembersInput struct {
	ActorPrincipalID string       `json:"actor_principal_id"`
	OrganizationID   string       `json:"organization_id"`
	Cursor           string       `json:"cursor,omitempty"`
	Limit            int          `json:"limit"`
	Filter           MemberFilter `json:"filter,omitempty"`
}

type ListGroupsInput struct {
	ActorPrincipalID string      `json:"actor_principal_id"`
	OrganizationID   string      `json:"organization_id"`
	Cursor           string      `json:"cursor,omitempty"`
	Limit            int         `json:"limit"`
	Filter           GroupFilter `json:"filter,omitempty"`
}

type MembersQuery struct {
	OrganizationID string
	Limit          int
	AfterEmail     string
	AfterID        string
	Filter         MemberFilter
}

type GroupsQuery struct {
	OrganizationID string
	Limit          int
	AfterName      string
	AfterID        string
	Filter         GroupFilter
}

type MemberPage struct {
	Items      []Member `json:"items"`
	NextCursor *string  `json:"next_cursor"`
}

type GroupPage struct {
	Items      []domain.Group `json:"items"`
	NextCursor *string        `json:"next_cursor"`
}

type pageCursor struct {
	Version        int    `json:"version"`
	Kind           string `json:"kind"`
	OrganizationID string `json:"organization_id"`
	Filter         string `json:"filter"`
	Key            string `json:"key"`
	ID             string `json:"id"`
}

func filterDigest(filter any) string {
	canonical, err := json.Marshal(filter)
	if err != nil {
		return ""
	}
	sum := sha256.Sum256(canonical)
	return hex.EncodeToString(sum[:])
}

func encodePageCursor(kind, organizationID, digest, key, id string) string {
	body, err := json.Marshal(pageCursor{
		Version: cursorVersion, Kind: kind, OrganizationID: organizationID,
		Filter: digest, Key: key, ID: id,
	})
	if err != nil {
		return ""
	}
	return base64.RawURLEncoding.EncodeToString(body)
}

func decodePageCursor(encoded, kind, organizationID, digest string) (string, string, error) {
	if encoded == "" {
		return "", "", nil
	}
	if len(encoded) > maximumCursorBytes {
		return "", "", domain.InvalidArgument("cursor is invalid")
	}
	raw, err := base64.RawURLEncoding.Strict().DecodeString(encoded)
	if err != nil || base64.RawURLEncoding.EncodeToString(raw) != encoded {
		return "", "", domain.InvalidArgument("cursor is invalid")
	}
	var cursor pageCursor
	if err := serviceauth.DecodeObject(raw, &cursor); err != nil {
		return "", "", domain.InvalidArgument("cursor is invalid")
	}
	if cursor.Version != cursorVersion || cursor.Kind != kind ||
		cursor.OrganizationID != organizationID || cursor.Filter != digest ||
		cursor.Key == "" || cursor.ID == "" {
		return "", "", domain.InvalidArgument("cursor is invalid")
	}
	return cursor.Key, cursor.ID, nil
}

func validPageLimit(limit int) error {
	if limit < 1 || limit > maximumPageLimit {
		return domain.InvalidArgument("limit must be between 1 and 200")
	}
	return nil
}

func normalizePrefix(value string) (string, error) {
	if !utf8.ValidString(value) {
		return "", domain.InvalidArgument("prefix filter is invalid")
	}
	normalized := strings.ToLower(strings.TrimSpace(value))
	if len(normalized) > maximumPrefixBytes {
		return "", domain.InvalidArgument("prefix filter is invalid")
	}
	return normalized, nil
}

func normalizeMemberFilter(filter MemberFilter) (MemberFilter, error) {
	prefix, err := normalizePrefix(filter.EmailPrefix)
	if err != nil {
		return MemberFilter{}, err
	}
	switch filter.Role {
	case "", domain.OrganizationRoleMember, domain.OrganizationRoleAdmin:
	default:
		return MemberFilter{}, domain.InvalidArgument("role filter is invalid")
	}
	switch filter.Source {
	case "", domain.SourceLocal, domain.SourceSCIM:
	default:
		return MemberFilter{}, domain.InvalidArgument("source filter is invalid")
	}
	filter.EmailPrefix = prefix
	return filter, nil
}

func normalizeGroupFilter(filter GroupFilter) (GroupFilter, error) {
	prefix, err := normalizePrefix(filter.DisplayNamePrefix)
	if err != nil {
		return GroupFilter{}, err
	}
	switch filter.Source {
	case "", domain.SourceLocal, domain.SourceSCIM:
	default:
		return GroupFilter{}, domain.InvalidArgument("source filter is invalid")
	}
	filter.DisplayNamePrefix = prefix
	return filter, nil
}

func (s *Service) requireDirectoryAuthority(ctx context.Context, actorPrincipalID, organizationID string) error {
	principal, err := s.repository.GetPrincipal(ctx, actorPrincipalID, organizationID)
	if err != nil {
		return fmt.Errorf("resolve directory actor: %w", err)
	}
	if !principal.CanAdminister(organizationID) {
		return domain.ErrForbidden
	}
	return nil
}

func (s *Service) ListMembers(ctx context.Context, input ListMembersInput) (MemberPage, error) {
	if err := s.requireDirectoryAuthority(ctx, input.ActorPrincipalID, input.OrganizationID); err != nil {
		return MemberPage{}, err
	}
	if err := validPageLimit(input.Limit); err != nil {
		return MemberPage{}, err
	}
	filter, err := normalizeMemberFilter(input.Filter)
	if err != nil {
		return MemberPage{}, err
	}
	digest := filterDigest(filter)
	key, id, err := decodePageCursor(input.Cursor, memberPageKind, input.OrganizationID, digest)
	if err != nil {
		return MemberPage{}, err
	}
	query := MembersQuery{
		OrganizationID: input.OrganizationID, Limit: input.Limit,
		AfterEmail: key, AfterID: id, Filter: filter,
	}
	rows, err := s.repository.ListMembers(ctx, query)
	if err != nil {
		return MemberPage{}, err
	}
	items := rows
	if len(items) > input.Limit {
		items = items[:input.Limit]
	}
	if items == nil {
		items = []Member{}
	}
	page := MemberPage{Items: items}
	if len(rows) > input.Limit && len(items) > 0 {
		last := items[len(items)-1]
		token := encodePageCursor(memberPageKind, input.OrganizationID, digest, last.Membership.Email, last.Membership.ID)
		page.NextCursor = &token
	}
	return page, nil
}

func (s *Service) ListGroups(ctx context.Context, input ListGroupsInput) (GroupPage, error) {
	if err := s.requireDirectoryAuthority(ctx, input.ActorPrincipalID, input.OrganizationID); err != nil {
		return GroupPage{}, err
	}
	if err := validPageLimit(input.Limit); err != nil {
		return GroupPage{}, err
	}
	filter, err := normalizeGroupFilter(input.Filter)
	if err != nil {
		return GroupPage{}, err
	}
	digest := filterDigest(filter)
	key, id, err := decodePageCursor(input.Cursor, groupPageKind, input.OrganizationID, digest)
	if err != nil {
		return GroupPage{}, err
	}
	query := GroupsQuery{
		OrganizationID: input.OrganizationID, Limit: input.Limit,
		AfterName: key, AfterID: id, Filter: filter,
	}
	rows, err := s.repository.ListGroups(ctx, query)
	if err != nil {
		return GroupPage{}, err
	}
	items := rows
	if len(items) > input.Limit {
		items = items[:input.Limit]
	}
	if items == nil {
		items = []domain.Group{}
	}
	page := GroupPage{Items: items}
	if len(rows) > input.Limit && len(items) > 0 {
		last := items[len(items)-1]
		token := encodePageCursor(groupPageKind, input.OrganizationID, digest, last.DisplayName, last.ID)
		page.NextCursor = &token
	}
	return page, nil
}
