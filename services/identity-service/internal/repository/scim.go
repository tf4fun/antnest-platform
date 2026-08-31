package repository

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"

	"soft/antnest-platform/services/identity-service/internal/domain"
	"soft/antnest-platform/services/identity-service/internal/scim"
)

type SCIMAdapter struct{ store *Store }

func (a *SCIMAdapter) GetPrincipal(
	ctx context.Context,
	userID string,
	organizationID string,
) (domain.Principal, error) {
	return observeRepositoryValue(ctx, "get_scim_principal", func(ctx context.Context) (domain.Principal, error) {
		return a.store.getPrincipal(ctx, a.store.pool, userID, organizationID)
	})
}

func (a *SCIMAdapter) IssueToken(ctx context.Context, command scim.IssueTokenCommand) (scim.Token, error) {
	token := scim.Token{
		ID: command.TokenID, OrganizationID: command.OrganizationID, Name: command.Name,
		Scopes: command.Scopes, CreatedAt: command.CreatedAt,
	}
	err := a.store.inTransaction(ctx, "issue_scim_token", func(tx pgx.Tx) error {
		if _, err := tx.Exec(ctx, `
			INSERT INTO scim_tokens (id, organization_id, token_hash, name, scopes, created_at)
			VALUES ($1, $2, $3, $4, $5, $6)`,
			command.TokenID, command.OrganizationID, command.TokenHash,
			command.Name, command.Scopes, command.CreatedAt,
		); err != nil {
			return fmt.Errorf("insert SCIM token: %w", err)
		}
		return a.store.appendEvent(ctx, tx, event{
			OrganizationID: command.OrganizationID, ActorPrincipalID: command.ActorPrincipalID,
			Type: "scim_token.issued", SubjectType: "scim_token", SubjectID: command.TokenID,
			RequestID: command.RequestID, CreatedAt: command.CreatedAt,
		})
	})
	return token, err
}

func (a *SCIMAdapter) RevokeToken(ctx context.Context, actorUserID, tokenID string, now time.Time) error {
	return a.store.inTransaction(ctx, "revoke_scim_token", func(tx pgx.Tx) error {
		var organizationID string
		var revokedAt *time.Time
		if err := tx.QueryRow(ctx, `
			SELECT organization_id, revoked_at
			FROM scim_tokens
			WHERE id = $1
			FOR UPDATE`, tokenID,
		).Scan(&organizationID, &revokedAt); err != nil {
			return err
		}
		principal, err := a.store.getPrincipal(ctx, tx, actorUserID, organizationID)
		if err != nil {
			return err
		}
		if !principal.CanAdminister(organizationID) {
			return domain.ErrForbidden
		}
		if revokedAt != nil {
			return nil
		}
		if _, err := tx.Exec(ctx, `UPDATE scim_tokens SET revoked_at = $2 WHERE id = $1`, tokenID, now); err != nil {
			return fmt.Errorf("revoke SCIM token: %w", err)
		}
		return a.store.appendEvent(ctx, tx, event{
			OrganizationID: organizationID, ActorPrincipalID: actorUserID,
			Type: "scim_token.revoked", SubjectType: "scim_token", SubjectID: tokenID,
			CreatedAt: now,
		})
	})
}

func (a *SCIMAdapter) ResolveToken(
	ctx context.Context,
	digest string,
	now time.Time,
) (authorization scim.Authorization, resultErr error) {
	ctx, finish := startRepositoryOperation(ctx, "resolve_scim_token")
	defer func() { finish(resultErr) }()
	err := a.store.pool.QueryRow(ctx, `
		UPDATE scim_tokens t
		SET last_used_at = CASE
			WHEN t.last_used_at IS NULL OR t.last_used_at < $2::timestamptz - interval '5 minutes'
				THEN $2::timestamptz
			ELSE t.last_used_at
		END
		FROM organizations o
		WHERE t.token_hash = $1 AND t.revoked_at IS NULL
		  AND o.id = t.organization_id AND o.active
		RETURNING t.id, t.organization_id, t.scopes`, digest, now,
	).Scan(&authorization.TokenID, &authorization.OrganizationID, &authorization.Scopes)
	if err != nil {
		return scim.Authorization{}, normalizeError(err)
	}
	return authorization, nil
}

func (a *SCIMAdapter) CreateUser(ctx context.Context, command scim.CreateUserCommand) (scim.UserResource, error) {
	var result scim.UserResource
	err := a.store.inTransaction(ctx, "create_scim_user", func(tx pgx.Tx) error {
		existing, err := a.findSCIMUserForCreate(ctx, tx, command)
		if err == nil {
			command.User.ID = existing.User.ID
			command.User.CreatedAt = existing.User.CreatedAt
			command.User.Active = existing.User.Active
			command.Membership.ID = existing.Membership.ID
			command.Membership.UserID = existing.User.ID
			command.Membership.CreatedAt = existing.Membership.CreatedAt
			result, err = replaceSCIMUser(ctx, tx, command.User, command.Membership)
			if err != nil {
				return err
			}
			return a.store.appendEvent(ctx, tx, event{
				OrganizationID: command.OrganizationID, Type: "scim_user.reconciled",
				ActorSCIMTokenID: command.ActorTokenID,
				SubjectType:      "organization_membership", SubjectID: command.Membership.ID,
				CreatedAt: command.User.UpdatedAt,
			})
		}
		if !errors.Is(err, domain.ErrNotFound) {
			return err
		}
		if _, err := tx.Exec(ctx, `
			INSERT INTO users (
				id, email, display_name, system_role, source, active, created_at, updated_at
			) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
			command.User.ID, command.User.Email, command.User.DisplayName, command.User.SystemRole,
			command.User.Source, command.User.Active, command.User.CreatedAt, command.User.UpdatedAt,
		); err != nil {
			return fmt.Errorf("insert SCIM user: %w", err)
		}
		if err := insertMembership(ctx, tx, command.Membership); err != nil {
			return err
		}
		result = scim.UserResource{User: command.User, Membership: command.Membership}
		return a.store.appendEvent(ctx, tx, event{
			OrganizationID: command.OrganizationID, Type: "scim_user.created",
			ActorSCIMTokenID: command.ActorTokenID,
			SubjectType:      "organization_membership", SubjectID: command.Membership.ID,
			CreatedAt: command.User.CreatedAt,
		})
	})
	return result, err
}

func (a *SCIMAdapter) GetUser(ctx context.Context, organizationID, resourceID string) (scim.UserResource, error) {
	return observeRepositoryValue(ctx, "get_scim_user", func(ctx context.Context) (scim.UserResource, error) {
		return scanSCIMUser(a.store.pool.QueryRow(ctx, scimUserSelect+`
			WHERE m.organization_id = $1 AND m.id = $2 AND m.source = 'scim'`, organizationID, resourceID))
	})
}

func (a *SCIMAdapter) ListUsers(ctx context.Context, query scim.ListQuery) (scim.UserPage, error) {
	return observeRepositoryValue(ctx, "list_scim_users", func(ctx context.Context) (scim.UserPage, error) {
		return a.listUsers(ctx, query)
	})
}

func (a *SCIMAdapter) listUsers(ctx context.Context, query scim.ListQuery) (scim.UserPage, error) {
	where, arguments, err := scimUserFilter(query)
	if err != nil {
		return scim.UserPage{}, err
	}
	var total int
	if err := a.store.pool.QueryRow(ctx, `
		SELECT count(*)
		FROM organization_memberships m
		JOIN users u ON u.id = m.user_id
		WHERE `+where, arguments[:len(arguments)-2]...).Scan(&total); err != nil {
		return scim.UserPage{}, fmt.Errorf("count SCIM users: %w", err)
	}
	rows, err := a.store.pool.Query(ctx, scimUserSelect+`
		WHERE `+where+`
		ORDER BY m.id
		OFFSET $`+fmt.Sprint(len(arguments)-1)+` LIMIT $`+fmt.Sprint(len(arguments)), arguments...)
	if err != nil {
		return scim.UserPage{}, fmt.Errorf("list SCIM users: %w", err)
	}
	defer rows.Close()
	items := make([]scim.UserResource, 0)
	for rows.Next() {
		item, err := scanSCIMUser(rows)
		if err != nil {
			return scim.UserPage{}, fmt.Errorf("scan SCIM user: %w", err)
		}
		items = append(items, item)
	}
	if err := rows.Err(); err != nil {
		return scim.UserPage{}, fmt.Errorf("iterate SCIM users: %w", err)
	}
	return scim.UserPage{Items: items, TotalResults: total}, nil
}

func (a *SCIMAdapter) ReplaceUser(ctx context.Context, command scim.ReplaceUserCommand) (scim.UserResource, error) {
	var result scim.UserResource
	err := a.store.inTransaction(ctx, "replace_scim_user", func(tx pgx.Tx) error {
		current, err := scanSCIMUser(tx.QueryRow(ctx, scimUserSelect+`
			WHERE m.organization_id = $1 AND m.id = $2 AND m.source = 'scim'
			FOR UPDATE OF m, u`, command.OrganizationID, command.Membership.ID))
		if err != nil {
			return err
		}
		command.User.ID, command.User.CreatedAt = current.User.ID, current.User.CreatedAt
		command.Membership.ID = current.Membership.ID
		command.Membership.UserID = current.User.ID
		command.Membership.CreatedAt = current.Membership.CreatedAt
		result, err = replaceSCIMUser(ctx, tx, command.User, command.Membership)
		if err != nil {
			return err
		}
		return a.store.appendEvent(ctx, tx, event{
			OrganizationID: command.OrganizationID, Type: "scim_user.replaced",
			ActorSCIMTokenID: command.ActorTokenID,
			SubjectType:      "organization_membership", SubjectID: command.Membership.ID,
			CreatedAt: command.User.UpdatedAt,
		})
	})
	return result, err
}

func (a *SCIMAdapter) CreateGroup(ctx context.Context, command scim.CreateGroupCommand) (scim.GroupResource, error) {
	var result scim.GroupResource
	err := a.store.inTransaction(ctx, "create_scim_group", func(tx pgx.Tx) error {
		if command.Group.SCIMExternalID != "" {
			existing, err := a.getSCIMGroupForUpdate(
				ctx,
				tx,
				command.OrganizationID,
				"external",
				command.Group.SCIMExternalID,
			)
			if err == nil {
				command.Group.ID = existing.Group.ID
				command.Group.CreatedAt = existing.Group.CreatedAt
				result, err = a.replaceSCIMGroup(ctx, tx, command.Group, command.MemberIDs)
				if err != nil {
					return err
				}
				return a.store.appendEvent(ctx, tx, event{
					OrganizationID: command.OrganizationID, Type: "scim_group.reconciled",
					ActorSCIMTokenID: command.ActorTokenID,
					SubjectType:      "group", SubjectID: command.Group.ID, CreatedAt: command.Group.UpdatedAt,
				})
			}
			if !errors.Is(err, domain.ErrNotFound) {
				return err
			}
		}
		if _, err := tx.Exec(ctx, `
			INSERT INTO groups (
				id, organization_id, display_name, source, active, scim_external_id, created_at, updated_at
			) VALUES ($1, $2, $3, $4, $5, NULLIF($6, ''), $7, $8)`,
			command.Group.ID, command.Group.OrganizationID, command.Group.DisplayName,
			command.Group.Source, command.Group.Active, command.Group.SCIMExternalID,
			command.Group.CreatedAt, command.Group.UpdatedAt,
		); err != nil {
			return fmt.Errorf("insert SCIM group: %w", err)
		}
		if err := a.replaceSCIMGroupMemberships(ctx, tx, command.Group, command.MemberIDs); err != nil {
			return err
		}
		result = scim.GroupResource{Group: command.Group, MemberIDs: command.MemberIDs}
		return a.store.appendEvent(ctx, tx, event{
			OrganizationID: command.OrganizationID, Type: "scim_group.created",
			ActorSCIMTokenID: command.ActorTokenID,
			SubjectType:      "group", SubjectID: command.Group.ID, CreatedAt: command.Group.CreatedAt,
		})
	})
	return result, err
}

func (a *SCIMAdapter) GetGroup(ctx context.Context, organizationID, resourceID string) (scim.GroupResource, error) {
	return observeRepositoryValue(ctx, "get_scim_group", func(ctx context.Context) (scim.GroupResource, error) {
		return a.getSCIMGroup(ctx, a.store.pool, organizationID, "id", resourceID)
	})
}

func (a *SCIMAdapter) ListGroups(ctx context.Context, query scim.ListQuery) (scim.GroupPage, error) {
	return observeRepositoryValue(ctx, "list_scim_groups", func(ctx context.Context) (scim.GroupPage, error) {
		return a.listGroups(ctx, query)
	})
}

func (a *SCIMAdapter) listGroups(ctx context.Context, query scim.ListQuery) (scim.GroupPage, error) {
	where, arguments, err := scimGroupFilter(query)
	if err != nil {
		return scim.GroupPage{}, err
	}
	var total int
	if err := a.store.pool.QueryRow(ctx, `SELECT count(*) FROM groups g WHERE `+where, arguments[:len(arguments)-2]...).Scan(&total); err != nil {
		return scim.GroupPage{}, fmt.Errorf("count SCIM groups: %w", err)
	}
	rows, err := a.store.pool.Query(ctx, `
		SELECT g.id, g.organization_id, g.display_name, g.source, g.active,
		       COALESCE(g.scim_external_id, ''), g.created_at, g.updated_at
		FROM groups g
		WHERE `+where+`
		ORDER BY g.id
		OFFSET $`+fmt.Sprint(len(arguments)-1)+` LIMIT $`+fmt.Sprint(len(arguments)), arguments...)
	if err != nil {
		return scim.GroupPage{}, fmt.Errorf("list SCIM groups: %w", err)
	}
	defer rows.Close()
	items := make([]scim.GroupResource, 0)
	for rows.Next() {
		var group domain.Group
		if err := scanGroup(rows, &group); err != nil {
			return scim.GroupPage{}, fmt.Errorf("scan SCIM group: %w", err)
		}
		memberIDs, err := a.groupMemberIDs(ctx, a.store.pool, group.OrganizationID, group.ID)
		if err != nil {
			return scim.GroupPage{}, err
		}
		items = append(items, scim.GroupResource{Group: group, MemberIDs: memberIDs})
	}
	if err := rows.Err(); err != nil {
		return scim.GroupPage{}, fmt.Errorf("iterate SCIM groups: %w", err)
	}
	return scim.GroupPage{Items: items, TotalResults: total}, nil
}

func (a *SCIMAdapter) ReplaceGroup(ctx context.Context, command scim.ReplaceGroupCommand) (scim.GroupResource, error) {
	var result scim.GroupResource
	err := a.store.inTransaction(ctx, "replace_scim_group", func(tx pgx.Tx) error {
		current, err := a.getSCIMGroupForUpdate(ctx, tx, command.OrganizationID, "id", command.Group.ID)
		if err != nil {
			return err
		}
		command.Group.ID, command.Group.CreatedAt = current.Group.ID, current.Group.CreatedAt
		result, err = a.replaceSCIMGroup(ctx, tx, command.Group, command.MemberIDs)
		if err != nil {
			return err
		}
		return a.store.appendEvent(ctx, tx, event{
			OrganizationID: command.OrganizationID, Type: "scim_group.replaced",
			ActorSCIMTokenID: command.ActorTokenID,
			SubjectType:      "group", SubjectID: command.Group.ID, CreatedAt: command.Group.UpdatedAt,
		})
	})
	return result, err
}

func (a *SCIMAdapter) DeleteGroup(ctx context.Context, command scim.DeleteGroupCommand) error {
	return a.store.inTransaction(ctx, "delete_scim_group", func(tx pgx.Tx) error {
		result, err := tx.Exec(ctx, `
			DELETE FROM groups
			WHERE organization_id = $1 AND id = $2 AND source = 'scim'`,
			command.OrganizationID, command.GroupID,
		)
		if err != nil {
			return fmt.Errorf("delete SCIM group: %w", err)
		}
		if result.RowsAffected() != 1 {
			return domain.ErrNotFound
		}
		return a.store.appendEvent(ctx, tx, event{
			OrganizationID: command.OrganizationID, Type: "scim_group.deleted",
			ActorSCIMTokenID: command.ActorTokenID,
			SubjectType:      "group", SubjectID: command.GroupID, CreatedAt: command.DeletedAt,
		})
	})
}

func (a *SCIMAdapter) findSCIMUserForCreate(
	ctx context.Context,
	tx pgx.Tx,
	command scim.CreateUserCommand,
) (scim.UserResource, error) {
	if command.Membership.SCIMExternalID != "" {
		resource, err := scanSCIMUser(tx.QueryRow(ctx, scimUserSelect+`
			WHERE m.organization_id = $1 AND m.scim_external_id = $2 AND m.source = 'scim'
			FOR UPDATE OF m, u`, command.OrganizationID, command.Membership.SCIMExternalID))
		if err == nil || !errors.Is(err, domain.ErrNotFound) {
			return resource, err
		}
	}
	resource, err := scanSCIMUser(tx.QueryRow(ctx, scimUserSelect+`
		WHERE m.organization_id = $1 AND m.scim_user_name = $2 AND m.source = 'scim'
		FOR UPDATE OF m, u`, command.OrganizationID, command.Membership.SCIMUserName))
	if err == nil || !errors.Is(err, domain.ErrNotFound) {
		return resource, err
	}
	var source domain.Source
	err = tx.QueryRow(ctx, `SELECT source FROM users WHERE email = $1`, command.User.Email).Scan(&source)
	if err == nil {
		return scim.UserResource{}, domain.ErrConflict
	}
	if err != pgx.ErrNoRows {
		return scim.UserResource{}, fmt.Errorf("check SCIM email ownership: %w", err)
	}
	return scim.UserResource{}, domain.ErrNotFound
}

func replaceSCIMUser(
	ctx context.Context,
	tx pgx.Tx,
	user domain.User,
	membership domain.OrganizationMembership,
) (scim.UserResource, error) {
	if _, err := tx.Exec(ctx, `
		UPDATE users
		SET email = $2, display_name = $3, updated_at = $4
		WHERE id = $1 AND source = 'scim'`,
		user.ID, user.Email, user.DisplayName, user.UpdatedAt,
	); err != nil {
		return scim.UserResource{}, fmt.Errorf("replace SCIM user: %w", err)
	}
	if _, err := tx.Exec(ctx, `
		UPDATE organization_memberships
		SET active = $3, scim_external_id = NULLIF($4, ''), scim_user_name = $5, updated_at = $6
		WHERE organization_id = $1 AND id = $2 AND source = 'scim'`,
		membership.OrganizationID, membership.ID, membership.Active,
		membership.SCIMExternalID, membership.SCIMUserName, membership.UpdatedAt,
	); err != nil {
		return scim.UserResource{}, fmt.Errorf("replace SCIM membership: %w", err)
	}
	return scim.UserResource{User: user, Membership: membership}, nil
}

func (a *SCIMAdapter) replaceSCIMGroup(
	ctx context.Context,
	tx pgx.Tx,
	group domain.Group,
	memberIDs []string,
) (scim.GroupResource, error) {
	result, err := tx.Exec(ctx, `
		UPDATE groups
		SET display_name = $3, active = $4, scim_external_id = NULLIF($5, ''), updated_at = $6
		WHERE organization_id = $1 AND id = $2 AND source = 'scim'`,
		group.OrganizationID, group.ID, group.DisplayName, group.Active,
		group.SCIMExternalID, group.UpdatedAt,
	)
	if err != nil {
		return scim.GroupResource{}, fmt.Errorf("replace SCIM group: %w", err)
	}
	if result.RowsAffected() != 1 {
		return scim.GroupResource{}, domain.ErrNotFound
	}
	if err := a.replaceSCIMGroupMemberships(ctx, tx, group, memberIDs); err != nil {
		return scim.GroupResource{}, err
	}
	return scim.GroupResource{Group: group, MemberIDs: memberIDs}, nil
}

func (a *SCIMAdapter) replaceSCIMGroupMemberships(
	ctx context.Context,
	tx pgx.Tx,
	group domain.Group,
	memberIDs []string,
) error {
	if len(memberIDs) > 0 {
		var count int
		if err := tx.QueryRow(ctx, `
			SELECT count(*)
			FROM organization_memberships
			WHERE organization_id = $1 AND source = 'scim' AND id = ANY($2)`,
			group.OrganizationID, memberIDs,
		).Scan(&count); err != nil {
			return fmt.Errorf("validate SCIM group members: %w", err)
		}
		if count != len(memberIDs) {
			return domain.ErrNotFound
		}
	}
	if _, err := tx.Exec(ctx, `
		DELETE FROM group_memberships
		WHERE organization_id = $1 AND group_id = $2 AND source = 'scim'`,
		group.OrganizationID, group.ID,
	); err != nil {
		return fmt.Errorf("replace SCIM group memberships: %w", err)
	}
	for _, memberID := range memberIDs {
		if _, err := tx.Exec(ctx, `
			INSERT INTO group_memberships (
				id, organization_id, group_id, organization_membership_id,
				source, active, created_at, updated_at
			) VALUES ($1, $2, $3, $4, 'scim', TRUE, $5, $5)`,
			a.store.newID(), group.OrganizationID, group.ID, memberID, group.UpdatedAt,
		); err != nil {
			return fmt.Errorf("insert SCIM group membership: %w", err)
		}
	}
	return nil
}

type queryRower interface {
	QueryRow(context.Context, string, ...any) pgx.Row
	Query(context.Context, string, ...any) (pgx.Rows, error)
}

func (a *SCIMAdapter) getSCIMGroup(
	ctx context.Context,
	queryer queryRower,
	organizationID string,
	lookup string,
	value string,
) (scim.GroupResource, error) {
	return a.loadSCIMGroup(ctx, queryer, organizationID, lookup, value, "")
}

func (a *SCIMAdapter) getSCIMGroupForUpdate(
	ctx context.Context,
	tx pgx.Tx,
	organizationID string,
	lookup string,
	value string,
) (scim.GroupResource, error) {
	return a.loadSCIMGroup(ctx, tx, organizationID, lookup, value, " FOR UPDATE OF g")
}

func (a *SCIMAdapter) loadSCIMGroup(
	ctx context.Context,
	queryer queryRower,
	organizationID string,
	lookup string,
	value string,
	lockClause string,
) (scim.GroupResource, error) {
	condition := "g.id = $2"
	if lookup == "external" {
		condition = "g.scim_external_id = $2"
	}
	var group domain.Group
	err := scanGroup(queryer.QueryRow(ctx, `
		SELECT g.id, g.organization_id, g.display_name, g.source, g.active,
		       COALESCE(g.scim_external_id, ''), g.created_at, g.updated_at
		FROM groups g
		WHERE g.organization_id = $1 AND `+condition+` AND g.source = 'scim'`+lockClause,
		organizationID, value,
	), &group)
	if err != nil {
		return scim.GroupResource{}, normalizeError(err)
	}
	members, err := a.groupMemberIDs(ctx, queryer, organizationID, group.ID)
	if err != nil {
		return scim.GroupResource{}, err
	}
	return scim.GroupResource{Group: group, MemberIDs: members}, nil
}

func (a *SCIMAdapter) groupMemberIDs(
	ctx context.Context,
	queryer interface {
		Query(context.Context, string, ...any) (pgx.Rows, error)
	},
	organizationID string,
	groupID string,
) ([]string, error) {
	rows, err := queryer.Query(ctx, `
		SELECT organization_membership_id
		FROM group_memberships
		WHERE organization_id = $1 AND group_id = $2 AND source = 'scim' AND active
		ORDER BY organization_membership_id`, organizationID, groupID)
	if err != nil {
		return nil, fmt.Errorf("list SCIM group members: %w", err)
	}
	defer rows.Close()
	result := make([]string, 0)
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			return nil, fmt.Errorf("scan SCIM group member: %w", err)
		}
		result = append(result, id)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("iterate SCIM group members: %w", err)
	}
	return result, nil
}

func scimUserFilter(query scim.ListQuery) (string, []any, error) {
	where := "m.organization_id = $1 AND m.source = 'scim'"
	arguments := []any{query.OrganizationID}
	if query.FilterAttribute != "" {
		column := ""
		switch strings.ToLower(query.FilterAttribute) {
		case "username":
			column = "m.scim_user_name"
		case "externalid":
			column = "m.scim_external_id"
		default:
			return "", nil, domain.NewError("invalid_filter", "Unsupported SCIM User filter", false)
		}
		arguments = append(arguments, query.FilterValue)
		where += " AND " + column + " = $2"
	}
	arguments = append(arguments, query.StartIndex-1, query.Count)
	return where, arguments, nil
}

func scimGroupFilter(query scim.ListQuery) (string, []any, error) {
	where := "g.organization_id = $1 AND g.source = 'scim'"
	arguments := []any{query.OrganizationID}
	if query.FilterAttribute != "" {
		column := ""
		switch strings.ToLower(query.FilterAttribute) {
		case "displayname":
			column = "g.display_name"
		case "externalid":
			column = "g.scim_external_id"
		default:
			return "", nil, domain.NewError("invalid_filter", "Unsupported SCIM Group filter", false)
		}
		arguments = append(arguments, query.FilterValue)
		where += " AND " + column + " = $2"
	}
	arguments = append(arguments, query.StartIndex-1, query.Count)
	return where, arguments, nil
}

const scimUserSelect = `
	SELECT u.id, u.email, u.display_name, u.system_role, u.source, u.active, u.created_at, u.updated_at,
	       m.id, m.organization_id, m.user_id, m.role, m.source, m.active,
	       COALESCE(m.scim_external_id, ''), COALESCE(m.scim_user_name, ''), m.created_at, m.updated_at
	FROM organization_memberships m
	JOIN users u ON u.id = m.user_id`

func scanSCIMUser(row rowScanner) (scim.UserResource, error) {
	var member struct {
		User       domain.User
		Membership domain.OrganizationMembership
	}
	err := row.Scan(
		&member.User.ID, &member.User.Email, &member.User.DisplayName, &member.User.SystemRole,
		&member.User.Source, &member.User.Active, &member.User.CreatedAt, &member.User.UpdatedAt,
		&member.Membership.ID, &member.Membership.OrganizationID, &member.Membership.UserID,
		&member.Membership.Role, &member.Membership.Source, &member.Membership.Active,
		&member.Membership.SCIMExternalID, &member.Membership.SCIMUserName,
		&member.Membership.CreatedAt, &member.Membership.UpdatedAt,
	)
	if err != nil {
		return scim.UserResource{}, normalizeError(err)
	}
	return scim.UserResource{User: member.User, Membership: member.Membership}, nil
}
