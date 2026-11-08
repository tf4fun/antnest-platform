package repository

import (
	"context"
	"fmt"
	"strings"

	"github.com/tf4fun/antnest-platform/services/identity-service/internal/directory"
	"github.com/tf4fun/antnest-platform/services/identity-service/internal/domain"
)

func escapeLikePrefix(prefix string) string {
	var escaped strings.Builder
	for _, r := range prefix {
		if r == '\\' || r == '%' || r == '_' {
			escaped.WriteByte('\\')
		}
		escaped.WriteRune(r)
	}
	return escaped.String()
}

func (a *DirectoryAdapter) ListMembers(ctx context.Context, query directory.MembersQuery) ([]directory.Member, error) {
	prefix := ""
	if query.Filter.EmailPrefix != "" {
		prefix = escapeLikePrefix(query.Filter.EmailPrefix) + "%"
	}
	role := ""
	if query.Filter.Role != "" {
		role = string(query.Filter.Role)
	}
	source := ""
	if query.Filter.Source != "" {
		source = string(query.Filter.Source)
	}
	rows, err := a.store.pool.Query(ctx, `
		SELECT u.id, u.system_role, u.active, u.created_at, u.updated_at,
		       m.id, m.organization_id, m.user_id, m.email, m.display_name, m.role, m.source, m.active,
		       COALESCE(m.scim_external_id, ''), COALESCE(m.scim_user_name, ''), m.created_at, m.updated_at
		FROM organization_memberships m
		JOIN users u ON u.id = m.user_id
		WHERE m.organization_id = $1 AND m.scim_deleted_at IS NULL
		  AND ($2 = '' OR (m.email, m.id) > ($2, $3))
		  AND ($4 = '' OR m.email LIKE $4 ESCAPE '\')
		  AND ($5 = '' OR m.role = $5)
		  AND ($6::boolean IS NULL OR (u.active AND m.active) = $6)
		  AND ($7 = '' OR m.source = $7)
		ORDER BY m.email, m.id
		LIMIT $8`,
		query.OrganizationID, query.AfterEmail, query.AfterID, prefix, role,
		query.Filter.Active, source, query.Limit+1,
	)
	if err != nil {
		return nil, fmt.Errorf("list directory members: %w", err)
	}
	defer rows.Close()
	result := make([]directory.Member, 0)
	for rows.Next() {
		var member directory.Member
		if err := scanMember(rows, &member); err != nil {
			return nil, fmt.Errorf("scan directory member: %w", err)
		}
		result = append(result, member)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("iterate directory members: %w", err)
	}
	return result, nil
}

func (a *DirectoryAdapter) ListGroups(ctx context.Context, query directory.GroupsQuery) ([]domain.Group, error) {
	prefix := ""
	if query.Filter.DisplayNamePrefix != "" {
		prefix = escapeLikePrefix(strings.ToLower(query.Filter.DisplayNamePrefix)) + "%"
	}
	source := ""
	if query.Filter.Source != "" {
		source = string(query.Filter.Source)
	}
	rows, err := a.store.pool.Query(ctx, `
		SELECT id, organization_id, display_name, source, active,
		       COALESCE(scim_external_id, ''), created_at, updated_at
		FROM groups
		WHERE organization_id = $1
		  AND ($2 = '' OR (display_name, id) > ($2, $3))
		  AND ($4 = '' OR lower(display_name) LIKE $4 ESCAPE '\')
		  AND ($5::boolean IS NULL OR active = $5)
		  AND ($6 = '' OR source = $6)
		ORDER BY display_name, id
		LIMIT $7`,
		query.OrganizationID, query.AfterName, query.AfterID, prefix,
		query.Filter.Active, source, query.Limit+1,
	)
	if err != nil {
		return nil, fmt.Errorf("list directory groups: %w", err)
	}
	defer rows.Close()
	result := make([]domain.Group, 0)
	for rows.Next() {
		var group domain.Group
		if err := scanGroup(rows, &group); err != nil {
			return nil, fmt.Errorf("scan directory group: %w", err)
		}
		result = append(result, group)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("iterate directory groups: %w", err)
	}
	return result, nil
}
