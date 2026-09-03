package repository

import (
	"context"
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
		if err := a.store.requireOrganizationAdmin(
			ctx,
			tx,
			command.ActorPrincipalID,
			command.OrganizationID,
		); err != nil {
			return err
		}
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
		if err := a.store.requireOrganizationAdmin(ctx, tx, actorUserID, organizationID); err != nil {
			return err
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

func (a *SCIMAdapter) ListTokens(ctx context.Context, organizationID string) ([]scim.Token, error) {
	return observeRepositoryValue(ctx, "list_scim_tokens", func(ctx context.Context) ([]scim.Token, error) {
		rows, err := a.store.pool.Query(ctx, `
			SELECT id, organization_id, name, scopes, created_at, revoked_at
			FROM scim_tokens
			WHERE organization_id = $1
			ORDER BY created_at DESC, id`, organizationID)
		if err != nil {
			return nil, fmt.Errorf("list SCIM tokens: %w", err)
		}
		defer rows.Close()
		tokens := make([]scim.Token, 0)
		for rows.Next() {
			var token scim.Token
			if err := rows.Scan(
				&token.ID, &token.OrganizationID, &token.Name, &token.Scopes,
				&token.CreatedAt, &token.RevokedAt,
			); err != nil {
				return nil, fmt.Errorf("scan SCIM token: %w", err)
			}
			tokens = append(tokens, token)
		}
		if err := rows.Err(); err != nil {
			return nil, fmt.Errorf("iterate SCIM tokens: %w", err)
		}
		return tokens, nil
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
		reprovisioned := false
		if command.Membership.SCIMExternalID != "" {
			user, found, err := a.findDeletedSCIMUserForReprovision(
				ctx,
				tx,
				command.OrganizationID,
				command.Membership.SCIMExternalID,
			)
			if err != nil {
				return err
			}
			if found {
				command.User = user
				command.Membership.UserID = user.ID
				reprovisioned = true
			}
		}
		if !reprovisioned {
			if _, err := tx.Exec(ctx, `
				INSERT INTO users (id, system_role, active, created_at, updated_at)
				VALUES ($1, $2, $3, $4, $5)`,
				command.User.ID, command.User.SystemRole, command.User.Active,
				command.User.CreatedAt, command.User.UpdatedAt,
			); err != nil {
				return fmt.Errorf("insert SCIM user: %w", err)
			}
		}
		if err := insertMembership(ctx, tx, command.Membership); err != nil {
			return err
		}
		if reprovisioned {
			if _, err := tx.Exec(ctx, `
				UPDATE external_identities
				SET membership_id = $3, updated_at = $4
				WHERE organization_id = $1 AND user_id = $2`,
				command.OrganizationID,
				command.User.ID,
				command.Membership.ID,
				command.Membership.CreatedAt,
			); err != nil {
				return fmt.Errorf("repoint OIDC identities after SCIM reprovisioning: %w", err)
			}
		}
		result = scim.UserResource{User: command.User, Membership: command.Membership}
		eventType := "scim_user.created"
		if reprovisioned {
			eventType = "scim_user.reprovisioned"
		}
		return a.store.appendEvent(ctx, tx, event{
			OrganizationID: command.OrganizationID, Type: eventType,
			ActorSCIMTokenID: command.ActorTokenID,
			SubjectType:      "organization_membership", SubjectID: command.Membership.ID,
			CreatedAt: command.Membership.CreatedAt,
		})
	})
	return result, err
}

func (a *SCIMAdapter) GetUser(ctx context.Context, organizationID, resourceID string) (scim.UserResource, error) {
	return observeRepositoryValue(ctx, "get_scim_user", func(ctx context.Context) (scim.UserResource, error) {
		return scanSCIMUser(a.store.pool.QueryRow(ctx, scimUserSelect+`
			WHERE m.organization_id = $1 AND m.id = $2 AND m.source = 'scim'
			  AND m.scim_deleted_at IS NULL`, organizationID, resourceID))
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
			  AND m.scim_deleted_at IS NULL
			FOR UPDATE OF m, u`, command.OrganizationID, command.Membership.ID))
		if err != nil {
			return err
		}
		if !current.Membership.UpdatedAt.Equal(command.ExpectedUpdatedAt) {
			return domain.ErrVersionConflict
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

func (a *SCIMAdapter) DeleteUser(ctx context.Context, command scim.DeleteUserCommand) error {
	return a.store.inTransaction(ctx, "delete_scim_user", func(tx pgx.Tx) error {
		var userID string
		var updatedAt time.Time
		if err := tx.QueryRow(ctx, `
			SELECT user_id, updated_at
			FROM organization_memberships
			WHERE organization_id = $1 AND id = $2 AND source = 'scim'
			  AND scim_deleted_at IS NULL
			FOR UPDATE`, command.OrganizationID, command.MembershipID,
		).Scan(&userID, &updatedAt); err != nil {
			return normalizeError(err)
		}
		deletedAt := domain.NextUpdatedAt(command.DeletedAt, updatedAt)
		if _, err := tx.Exec(ctx, `
			UPDATE groups g
			SET updated_at = GREATEST($3::timestamptz, g.updated_at + interval '1 microsecond')
			WHERE g.organization_id = $1 AND g.source = 'scim'
			  AND EXISTS (
				SELECT 1
				FROM group_memberships gm
				WHERE gm.organization_id = $1 AND gm.group_id = g.id
				  AND gm.organization_membership_id = $2 AND gm.source = 'scim'
			  )`,
			command.OrganizationID, command.MembershipID, deletedAt,
		); err != nil {
			return fmt.Errorf("advance SCIM groups after user deletion: %w", err)
		}
		if _, err := tx.Exec(ctx, `
			DELETE FROM group_memberships
			WHERE organization_id = $1 AND organization_membership_id = $2 AND source = 'scim'`,
			command.OrganizationID, command.MembershipID,
		); err != nil {
			return fmt.Errorf("delete SCIM group memberships: %w", err)
		}
		if _, err := tx.Exec(ctx, `
			UPDATE organization_memberships
			SET active = FALSE, scim_deleted_at = $3, updated_at = $3
			WHERE organization_id = $1 AND id = $2`,
			command.OrganizationID, command.MembershipID, deletedAt,
		); err != nil {
			return fmt.Errorf("tombstone SCIM user: %w", err)
		}
		return a.store.appendEvent(ctx, tx, event{
			OrganizationID: command.OrganizationID, Type: "scim_user.deleted",
			ActorSCIMTokenID: command.ActorTokenID,
			SubjectType:      "organization_membership", SubjectID: command.MembershipID,
			Metadata: map[string]any{"user_id": userID}, CreatedAt: deletedAt,
		})
	})
}

func (a *SCIMAdapter) CreateGroup(ctx context.Context, command scim.CreateGroupCommand) (scim.GroupResource, error) {
	var result scim.GroupResource
	err := a.store.inTransaction(ctx, "create_scim_group", func(tx pgx.Tx) error {
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
		if !current.Group.UpdatedAt.Equal(command.ExpectedUpdatedAt) {
			return domain.ErrVersionConflict
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

func (a *SCIMAdapter) findDeletedSCIMUserForReprovision(
	ctx context.Context,
	tx pgx.Tx,
	organizationID string,
	externalID string,
) (domain.User, bool, error) {
	var user domain.User
	err := tx.QueryRow(ctx, `
		SELECT u.id, u.system_role, u.active, u.created_at, u.updated_at
		FROM organization_memberships m
		JOIN users u ON u.id = m.user_id
		WHERE m.organization_id = $1 AND m.source = 'scim'
		  AND m.scim_external_id = $2 AND m.scim_deleted_at IS NOT NULL
		ORDER BY m.scim_deleted_at DESC, m.id DESC
		LIMIT 1
		FOR UPDATE OF m, u`, organizationID, externalID,
	).Scan(&user.ID, &user.SystemRole, &user.Active, &user.CreatedAt, &user.UpdatedAt)
	if err == pgx.ErrNoRows {
		return domain.User{}, false, nil
	}
	if err != nil {
		return domain.User{}, false, fmt.Errorf("find deleted SCIM user for reprovisioning: %w", err)
	}
	return user, true, nil
}

func replaceSCIMUser(
	ctx context.Context,
	tx pgx.Tx,
	user domain.User,
	membership domain.OrganizationMembership,
) (scim.UserResource, error) {
	result, err := tx.Exec(ctx, `
		UPDATE organization_memberships
		SET email = $3, display_name = $4, active = $5,
		    scim_external_id = NULLIF($6, ''), scim_user_name = $7, updated_at = $8
		WHERE organization_id = $1 AND id = $2 AND source = 'scim'
		  AND scim_deleted_at IS NULL`,
		membership.OrganizationID, membership.ID, membership.Email, membership.DisplayName,
		membership.Active, membership.SCIMExternalID, membership.SCIMUserName, membership.UpdatedAt,
	)
	if err != nil {
		return scim.UserResource{}, fmt.Errorf("replace SCIM membership: %w", err)
	}
	if result.RowsAffected() != 1 {
		return scim.UserResource{}, domain.ErrNotFound
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
			WHERE organization_id = $1 AND source = 'scim' AND id = ANY($2)
			  AND scim_deleted_at IS NULL`,
			group.OrganizationID, memberIDs,
		).Scan(&count); err != nil {
			return fmt.Errorf("validate SCIM group members: %w", err)
		}
		if count != len(memberIDs) {
			return domain.ErrInvalidReference
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
	where := "m.organization_id = $1 AND m.source = 'scim' AND m.scim_deleted_at IS NULL"
	arguments := []any{query.OrganizationID}
	if query.FilterAttribute != "" {
		expression := ""
		switch strings.ToLower(query.FilterAttribute) {
		case "username":
			expression = "m.scim_user_name = lower($2)"
		case "externalid":
			expression = "m.scim_external_id = $2"
		case "emails.value":
			expression = "m.email = lower($2)"
		default:
			return "", nil, domain.NewError("invalid_filter", "Unsupported SCIM User filter", false)
		}
		arguments = append(arguments, query.FilterValue)
		where += " AND " + expression
	}
	arguments = append(arguments, query.StartIndex-1, query.Count)
	return where, arguments, nil
}

func scimGroupFilter(query scim.ListQuery) (string, []any, error) {
	where := "g.organization_id = $1 AND g.source = 'scim'"
	arguments := []any{query.OrganizationID}
	if query.FilterAttribute != "" {
		expression := ""
		switch strings.ToLower(query.FilterAttribute) {
		case "displayname":
			expression = "lower(g.display_name) = lower($2)"
		case "externalid":
			expression = "g.scim_external_id = $2"
		default:
			return "", nil, domain.NewError("invalid_filter", "Unsupported SCIM Group filter", false)
		}
		arguments = append(arguments, query.FilterValue)
		where += " AND " + expression
	}
	arguments = append(arguments, query.StartIndex-1, query.Count)
	return where, arguments, nil
}

const scimUserSelect = `
	SELECT u.id, u.system_role, u.active, u.created_at, u.updated_at,
	       m.id, m.organization_id, m.user_id, m.email, m.display_name, m.role, m.source, m.active,
	       COALESCE(m.scim_external_id, ''), COALESCE(m.scim_user_name, ''), m.scim_deleted_at,
	       m.created_at, m.updated_at
	FROM organization_memberships m
	JOIN users u ON u.id = m.user_id`

func scanSCIMUser(row rowScanner) (scim.UserResource, error) {
	var member struct {
		User       domain.User
		Membership domain.OrganizationMembership
	}
	err := row.Scan(
		&member.User.ID, &member.User.SystemRole, &member.User.Active,
		&member.User.CreatedAt, &member.User.UpdatedAt,
		&member.Membership.ID, &member.Membership.OrganizationID, &member.Membership.UserID,
		&member.Membership.Email, &member.Membership.DisplayName,
		&member.Membership.Role, &member.Membership.Source, &member.Membership.Active,
		&member.Membership.SCIMExternalID, &member.Membership.SCIMUserName,
		&member.Membership.SCIMDeletedAt,
		&member.Membership.CreatedAt, &member.Membership.UpdatedAt,
	)
	if err != nil {
		return scim.UserResource{}, normalizeError(err)
	}
	return scim.UserResource{User: member.User, Membership: member.Membership}, nil
}
