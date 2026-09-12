package repository

import (
	"context"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"

	"soft/antnest-platform/services/identity-service/internal/directory"
	"soft/antnest-platform/services/identity-service/internal/domain"
)

type DirectoryAdapter struct{ store *Store }

const systemAdminLifecycleLock int64 = 0x414E544E455354

func (a *DirectoryAdapter) GetOrganization(
	ctx context.Context,
	organizationID string,
) (domain.Organization, error) {
	var organization domain.Organization
	err := a.store.pool.QueryRow(ctx, `
			SELECT id, slug, name, active, created_at, updated_at
			FROM organizations
			WHERE id = $1`, organizationID,
	).Scan(
		&organization.ID,
		&organization.Slug,
		&organization.Name,
		&organization.Active,
		&organization.CreatedAt,
		&organization.UpdatedAt,
	)
	if err != nil {
		return domain.Organization{}, normalizeError(err)
	}
	return organization, nil
}

func (a *DirectoryAdapter) GetPrincipal(
	ctx context.Context,
	userID string,
	organizationID string,
) (domain.Principal, error) {
	return a.store.getPrincipal(ctx, a.store.pool, userID, organizationID)
}

func (a *DirectoryAdapter) ResolveOrganizationPrincipal(
	ctx context.Context,
	userID string,
	organizationID string,
) (domain.Principal, error) {
	return a.store.resolveOrganizationPrincipal(ctx, userID, organizationID)
}

func (a *DirectoryAdapter) CreateOrganization(
	ctx context.Context,
	command directory.CreateOrganizationCommand,
) (domain.Organization, error) {
	organization := command.Organization
	err := a.store.inTransaction(ctx, func(tx *databaseTransaction) error {
		if err := a.store.requireSystemAdmin(ctx, tx, command.ActorPrincipalID); err != nil {
			return err
		}
		if _, err := tx.Exec(ctx, `
			INSERT INTO organizations (id, slug, name, active, created_at, updated_at)
			VALUES ($1, $2, $3, $4, $5, $6)`,
			organization.ID, organization.Slug, organization.Name, organization.Active,
			organization.CreatedAt, organization.UpdatedAt,
		); err != nil {
			return fmt.Errorf("insert organization: %w", err)
		}
		if err := insertMembership(ctx, tx, command.Membership); err != nil {
			return err
		}
		return a.store.appendEvent(ctx, tx, event{
			OrganizationID: organization.ID, ActorPrincipalID: command.ActorPrincipalID,
			Type: "organization.created", SubjectType: "organization", SubjectID: organization.ID,
			RequestID: command.RequestID, CreatedAt: organization.CreatedAt,
		})
	})
	return organization, err
}

func (a *DirectoryAdapter) CreateLocalUser(
	ctx context.Context,
	command directory.CreateLocalUserCommand,
) (directory.CreateLocalUserResult, error) {
	err := a.store.inTransaction(ctx, func(tx *databaseTransaction) error {
		if err := a.store.requireOrganizationAdmin(
			ctx,
			tx,
			command.ActorPrincipalID,
			command.Membership.OrganizationID,
		); err != nil {
			return err
		}
		if _, err := tx.Exec(ctx, `
			INSERT INTO users (id, system_role, active, created_at, updated_at)
			VALUES ($1, $2, $3, $4, $5)`,
			command.User.ID, command.User.SystemRole, command.User.Active,
			command.User.CreatedAt, command.User.UpdatedAt,
		); err != nil {
			return fmt.Errorf("insert local user: %w", err)
		}
		if _, err := tx.Exec(ctx, `
			INSERT INTO local_credentials (user_id, password_hash, created_at, updated_at)
			VALUES ($1, $2, $3, $4)`,
			command.Credential.UserID, command.Credential.PasswordHash,
			command.Credential.CreatedAt, command.Credential.UpdatedAt,
		); err != nil {
			return fmt.Errorf("insert local credential: %w", err)
		}
		if err := insertMembership(ctx, tx, command.Membership); err != nil {
			return err
		}
		return a.store.appendEvent(ctx, tx, event{
			OrganizationID:   command.Membership.OrganizationID,
			ActorPrincipalID: command.ActorPrincipalID,
			Type:             "local_user.created", SubjectType: "user", SubjectID: command.User.ID,
			RequestID: command.RequestID, CreatedAt: command.User.CreatedAt,
		})
	})
	return directory.CreateLocalUserResult{User: command.User, Membership: command.Membership}, err
}

func (a *DirectoryAdapter) AddOrganizationMembership(
	ctx context.Context,
	command directory.AddOrganizationMembershipCommand,
) (domain.OrganizationMembership, error) {
	membership := command.Membership
	err := a.store.inTransaction(ctx, func(tx *databaseTransaction) error {
		if err := a.store.requireOrganizationAdmin(
			ctx,
			tx,
			command.ActorPrincipalID,
			membership.OrganizationID,
		); err != nil {
			return err
		}
		var userActive bool
		if err := tx.QueryRow(ctx, `SELECT active FROM users WHERE id = $1 FOR UPDATE`, membership.UserID).
			Scan(&userActive); err != nil {
			return err
		}
		if !userActive {
			return domain.ErrInactive
		}
		var existing domain.OrganizationMembership
		err := tx.QueryRow(ctx, `
			SELECT id, organization_id, user_id, email, display_name, role, source, active,
			       COALESCE(scim_external_id, ''), COALESCE(scim_user_name, ''), created_at, updated_at
			FROM organization_memberships
			WHERE organization_id = $1 AND user_id = $2 AND scim_deleted_at IS NULL
			FOR UPDATE`, membership.OrganizationID, membership.UserID,
		).Scan(
			&existing.ID, &existing.OrganizationID, &existing.UserID,
			&existing.Email, &existing.DisplayName, &existing.Role,
			&existing.Source, &existing.Active, &existing.SCIMExternalID, &existing.SCIMUserName,
			&existing.CreatedAt, &existing.UpdatedAt,
		)
		if err == nil {
			if existing.Source != domain.SourceLocal || existing.Role != membership.Role ||
				existing.Email != membership.Email || existing.DisplayName != membership.DisplayName || !existing.Active {
				return domain.ErrConflict
			}
			membership = existing
			return nil
		}
		if err != pgx.ErrNoRows {
			return err
		}
		if err := insertMembership(ctx, tx, membership); err != nil {
			return err
		}
		return a.store.appendEvent(ctx, tx, event{
			OrganizationID: membership.OrganizationID, ActorPrincipalID: command.ActorPrincipalID,
			Type: "organization_membership.created", SubjectType: "organization_membership",
			SubjectID: membership.ID, RequestID: command.RequestID, CreatedAt: membership.CreatedAt,
		})
	})
	return membership, err
}

func (a *DirectoryAdapter) GetLocalCredential(
	ctx context.Context,
	userID string,
) (domain.LocalCredential, error) {
	var credential domain.LocalCredential
	err := a.store.pool.QueryRow(ctx, `
			SELECT user_id, password_hash, created_at, updated_at
			FROM local_credentials
			WHERE user_id = $1`, userID,
	).Scan(
		&credential.UserID,
		&credential.PasswordHash,
		&credential.CreatedAt,
		&credential.UpdatedAt,
	)
	if err != nil {
		return domain.LocalCredential{}, normalizeError(err)
	}
	return credential, nil
}

func (a *DirectoryAdapter) ChangeLocalPassword(
	ctx context.Context,
	command directory.ChangeLocalPasswordCommand,
) error {
	return a.store.inTransaction(ctx, func(tx *databaseTransaction) error {
		if command.ActorPrincipalID != command.UserID {
			return domain.ErrForbidden
		}
		var active bool
		if err := tx.QueryRow(ctx, `SELECT active FROM users WHERE id = $1 FOR SHARE`, command.UserID).
			Scan(&active); err != nil {
			return err
		}
		if !active {
			return domain.ErrForbidden
		}
		result, err := tx.Exec(ctx, `
			UPDATE local_credentials
			SET password_hash = $3, updated_at = $4
			WHERE user_id = $1 AND password_hash = $2`,
			command.UserID,
			command.ExpectedPasswordHash,
			command.PasswordHash,
			command.UpdatedAt,
		)
		if err != nil {
			return fmt.Errorf("change local password: %w", err)
		}
		if result.RowsAffected() != 1 {
			return domain.ErrConflict
		}
		return a.store.appendEvent(ctx, tx, event{
			ActorPrincipalID: command.ActorPrincipalID,
			Type:             "local_credential.changed",
			SubjectType:      "user",
			SubjectID:        command.UserID,
			RequestID:        command.RequestID,
			CreatedAt:        command.UpdatedAt,
		})
	})
}

func (a *DirectoryAdapter) GetMembership(
	ctx context.Context,
	organizationID string,
	membershipID string,
) (domain.OrganizationMembership, error) {
	var membership domain.OrganizationMembership
	err := a.store.pool.QueryRow(ctx, `
			SELECT id, organization_id, user_id, email, display_name, role, source, active,
			       COALESCE(scim_external_id, ''), COALESCE(scim_user_name, ''), scim_deleted_at,
			       created_at, updated_at
			FROM organization_memberships
			WHERE organization_id = $1 AND id = $2 AND scim_deleted_at IS NULL`,
		organizationID,
		membershipID,
	).Scan(
		&membership.ID,
		&membership.OrganizationID,
		&membership.UserID,
		&membership.Email,
		&membership.DisplayName,
		&membership.Role,
		&membership.Source,
		&membership.Active,
		&membership.SCIMExternalID,
		&membership.SCIMUserName,
		&membership.SCIMDeletedAt,
		&membership.CreatedAt,
		&membership.UpdatedAt,
	)
	if err != nil {
		return domain.OrganizationMembership{}, normalizeError(err)
	}
	return membership, nil
}

func (a *DirectoryAdapter) UpdateMembership(
	ctx context.Context,
	command directory.UpdateMembershipCommand,
) (domain.OrganizationMembership, error) {
	membership := command.Membership
	err := a.store.inTransaction(ctx, func(tx *databaseTransaction) error {
		if err := a.store.requireOrganizationAdmin(
			ctx,
			tx,
			command.ActorPrincipalID,
			membership.OrganizationID,
		); err != nil {
			return err
		}
		var lockedOrganizationID string
		if err := tx.QueryRow(ctx, `
			SELECT id
			FROM organizations
			WHERE id = $1
			FOR UPDATE`, membership.OrganizationID).Scan(&lockedOrganizationID); err != nil {
			return fmt.Errorf("lock organization membership lifecycle: %w", err)
		}
		var source domain.Source
		var currentRole domain.OrganizationRole
		var currentActive bool
		var updatedAt time.Time
		if err := tx.QueryRow(ctx, `
			SELECT source, role, active, updated_at, user_id
			FROM organization_memberships
			WHERE organization_id = $1 AND id = $2 AND scim_deleted_at IS NULL
			FOR UPDATE`, membership.OrganizationID, membership.ID,
		).Scan(&source, &currentRole, &currentActive, &updatedAt, &membership.UserID); err != nil {
			return err
		}
		if source != domain.SourceLocal {
			return domain.ErrConflict
		}
		if !updatedAt.Equal(command.ExpectedUpdatedAt) {
			return domain.ErrVersionConflict
		}
		removesAdministrator := currentRole == domain.OrganizationRoleAdmin && currentActive &&
			(membership.Role != domain.OrganizationRoleAdmin || !membership.Active)
		if removesAdministrator {
			var anotherActiveAdministrator bool
			if err := tx.QueryRow(ctx, `
				SELECT EXISTS (
					SELECT 1
					FROM organization_memberships m
					JOIN users u ON u.id = m.user_id
					WHERE m.organization_id = $1
					  AND m.id <> $2
					  AND m.role = 'admin'
					  AND m.active = TRUE
					  AND m.scim_deleted_at IS NULL
					  AND u.active = TRUE
				)`, membership.OrganizationID, membership.ID,
			).Scan(&anotherActiveAdministrator); err != nil {
				return fmt.Errorf("check remaining organization administrators: %w", err)
			}
			if !anotherActiveAdministrator {
				return domain.ErrLastOrganizationAdmin
			}
		}
		if _, err := tx.Exec(ctx, `
			UPDATE organization_memberships
			SET email = $3, display_name = $4, role = $5, active = $6, updated_at = $7
			WHERE organization_id = $1 AND id = $2`,
			membership.OrganizationID,
			membership.ID,
			membership.Email,
			membership.DisplayName,
			membership.Role,
			membership.Active,
			membership.UpdatedAt,
		); err != nil {
			return fmt.Errorf("update organization membership: %w", err)
		}
		if err := a.store.appendEvent(ctx, tx, event{
			OrganizationID:   membership.OrganizationID,
			ActorPrincipalID: command.ActorPrincipalID,
			Type:             "organization_membership.updated",
			SubjectType:      "organization_membership",
			SubjectID:        membership.ID,
			RequestID:        command.RequestID,
			CreatedAt:        membership.UpdatedAt,
		}); err != nil {
			return err
		}
		if !currentActive || membership.Active {
			return nil
		}
		return a.store.appendPrincipalRevocation(ctx, tx, domain.PrincipalRevocation{
			UserID: membership.UserID, OrganizationID: membership.OrganizationID,
			Reason: "membership_deactivated", OccurredAt: membership.UpdatedAt,
		})
	})
	return membership, err
}

func (a *DirectoryAdapter) SetUserActive(
	ctx context.Context,
	command directory.SetUserActiveCommand,
) error {
	return a.store.inTransaction(ctx, func(tx *databaseTransaction) error {
		if _, err := tx.Exec(ctx, `SELECT pg_advisory_xact_lock($1)`, systemAdminLifecycleLock); err != nil {
			return fmt.Errorf("lock system administrator lifecycle: %w", err)
		}
		if err := a.store.requireSystemAdmin(ctx, tx, command.ActorPrincipalID); err != nil {
			return err
		}
		if !command.Active && command.ActorPrincipalID == command.UserID {
			return domain.ErrConflict
		}
		var active bool
		if err := tx.QueryRow(ctx, `SELECT active FROM users WHERE id = $1 FOR UPDATE`, command.UserID).
			Scan(&active); err != nil {
			return err
		}
		if active == command.Active {
			return nil
		}
		if !command.Active {
			if err := retainActiveOrganizationAdministrators(ctx, tx, command.UserID); err != nil {
				return err
			}
		}
		if _, err := tx.Exec(ctx, `
			UPDATE users
			SET active = $2, updated_at = $3
			WHERE id = $1`, command.UserID, command.Active, command.UpdatedAt,
		); err != nil {
			return fmt.Errorf("set user active: %w", err)
		}
		if !command.Active {
			if _, err := tx.Exec(ctx, `
				UPDATE api_tokens
				SET revoked_at = $2
				WHERE user_id = $1 AND revoked_at IS NULL`, command.UserID, command.UpdatedAt,
			); err != nil {
				return fmt.Errorf("revoke disabled user tokens: %w", err)
			}
		}
		eventType := "user.activated"
		if !command.Active {
			eventType = "user.deactivated"
		}
		if err := a.store.appendEvent(ctx, tx, event{
			ActorPrincipalID: command.ActorPrincipalID,
			Type:             eventType,
			SubjectType:      "user",
			SubjectID:        command.UserID,
			RequestID:        command.RequestID,
			CreatedAt:        command.UpdatedAt,
		}); err != nil {
			return err
		}
		if command.Active {
			return nil
		}
		return a.store.appendPrincipalRevocation(ctx, tx, domain.PrincipalRevocation{
			UserID: command.UserID, Reason: "user_deactivated", OccurredAt: command.UpdatedAt,
		})
	})
}

func retainActiveOrganizationAdministrators(ctx context.Context, tx *databaseTransaction, userID string) error {
	rows, err := tx.Query(ctx, `
		SELECT o.id
		FROM organizations o
		JOIN organization_memberships m ON m.organization_id = o.id
		WHERE m.user_id = $1
		  AND m.role = 'admin'
		  AND m.active = TRUE
		  AND m.scim_deleted_at IS NULL
		  AND o.active = TRUE
		ORDER BY o.id
		FOR UPDATE OF o`, userID)
	if err != nil {
		return fmt.Errorf("lock user administrator organizations: %w", err)
	}
	organizationIDs := make([]string, 0)
	for rows.Next() {
		var organizationID string
		if err := rows.Scan(&organizationID); err != nil {
			rows.Close()
			return fmt.Errorf("scan user administrator organization: %w", err)
		}
		organizationIDs = append(organizationIDs, organizationID)
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return fmt.Errorf("iterate user administrator organizations: %w", err)
	}
	rows.Close()
	for _, organizationID := range organizationIDs {
		var anotherActiveAdministrator bool
		if err := tx.QueryRow(ctx, `
			SELECT EXISTS (
				SELECT 1
				FROM organization_memberships m
				JOIN users u ON u.id = m.user_id
				WHERE m.organization_id = $1
				  AND m.user_id <> $2
				  AND m.role = 'admin'
				  AND m.active = TRUE
				  AND m.scim_deleted_at IS NULL
				  AND u.active = TRUE
			)`, organizationID, userID,
		).Scan(&anotherActiveAdministrator); err != nil {
			return fmt.Errorf("check remaining organization administrators: %w", err)
		}
		if !anotherActiveAdministrator {
			return domain.ErrLastOrganizationAdmin
		}
	}
	return nil
}

func (a *DirectoryAdapter) ListDirectory(ctx context.Context, organizationID string) (directory.Directory, error) {
	users, err := a.listMembers(ctx, organizationID)
	if err != nil {
		return directory.Directory{}, err
	}
	groups, err := a.listGroups(ctx, organizationID)
	if err != nil {
		return directory.Directory{}, err
	}
	return directory.Directory{Users: users, Groups: groups}, nil
}

func (a *DirectoryAdapter) listMembers(ctx context.Context, organizationID string) ([]directory.Member, error) {
	rows, err := a.store.pool.Query(ctx, `
		SELECT u.id, u.system_role, u.active, u.created_at, u.updated_at,
		       m.id, m.organization_id, m.user_id, m.email, m.display_name, m.role, m.source, m.active,
		       COALESCE(m.scim_external_id, ''), COALESCE(m.scim_user_name, ''), m.created_at, m.updated_at
		FROM organization_memberships m
		JOIN users u ON u.id = m.user_id
		WHERE m.organization_id = $1 AND m.scim_deleted_at IS NULL
		ORDER BY m.email, m.id`, organizationID)
	if err != nil {
		return nil, fmt.Errorf("list directory users: %w", err)
	}
	defer rows.Close()
	result := make([]directory.Member, 0)
	for rows.Next() {
		var member directory.Member
		if err := scanMember(rows, &member); err != nil {
			return nil, fmt.Errorf("scan directory user: %w", err)
		}
		result = append(result, member)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("iterate directory users: %w", err)
	}
	return result, nil
}

func (a *DirectoryAdapter) listGroups(ctx context.Context, organizationID string) ([]domain.Group, error) {
	rows, err := a.store.pool.Query(ctx, `
		SELECT id, organization_id, display_name, source, active,
		       COALESCE(scim_external_id, ''), created_at, updated_at
		FROM groups
		WHERE organization_id = $1
		ORDER BY display_name, id`, organizationID)
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

func insertMembership(ctx context.Context, tx *databaseTransaction, membership domain.OrganizationMembership) error {
	if _, err := tx.Exec(ctx, `
		INSERT INTO organization_memberships (
			id, organization_id, user_id, email, display_name, role, source, active,
			scim_external_id, scim_user_name, created_at, updated_at
		) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NULLIF($9, ''), NULLIF($10, ''), $11, $12)`,
		membership.ID, membership.OrganizationID, membership.UserID,
		membership.Email, membership.DisplayName, membership.Role,
		membership.Source, membership.Active, membership.SCIMExternalID, membership.SCIMUserName,
		membership.CreatedAt, membership.UpdatedAt,
	); err != nil {
		return fmt.Errorf("insert organization membership: %w", err)
	}
	return nil
}

type rowScanner interface{ Scan(...any) error }

func scanMember(row rowScanner, member *directory.Member) error {
	return row.Scan(
		&member.User.ID, &member.User.SystemRole, &member.User.Active,
		&member.User.CreatedAt, &member.User.UpdatedAt,
		&member.Membership.ID, &member.Membership.OrganizationID, &member.Membership.UserID,
		&member.Membership.Email, &member.Membership.DisplayName,
		&member.Membership.Role, &member.Membership.Source, &member.Membership.Active,
		&member.Membership.SCIMExternalID, &member.Membership.SCIMUserName,
		&member.Membership.CreatedAt, &member.Membership.UpdatedAt,
	)
}

func scanGroup(row rowScanner, group *domain.Group) error {
	return row.Scan(
		&group.ID, &group.OrganizationID, &group.DisplayName, &group.Source, &group.Active,
		&group.SCIMExternalID, &group.CreatedAt, &group.UpdatedAt,
	)
}
