package repository

import (
	"context"
	"fmt"

	"github.com/jackc/pgx/v5"

	"soft/antnest-platform/services/identity-service/internal/directory"
	"soft/antnest-platform/services/identity-service/internal/domain"
)

type DirectoryAdapter struct{ store *Store }

func (a *DirectoryAdapter) GetPrincipal(
	ctx context.Context,
	userID string,
	organizationID string,
) (domain.Principal, error) {
	return observeRepositoryValue(ctx, "get_directory_principal", func(ctx context.Context) (domain.Principal, error) {
		return a.store.getPrincipal(ctx, a.store.pool, userID, organizationID)
	})
}

func (a *DirectoryAdapter) CreateOrganization(
	ctx context.Context,
	command directory.CreateOrganizationCommand,
) (domain.Organization, error) {
	organization := command.Organization
	err := a.store.inTransaction(ctx, "create_organization", func(tx pgx.Tx) error {
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
	err := a.store.inTransaction(ctx, "create_local_user", func(tx pgx.Tx) error {
		if _, err := tx.Exec(ctx, `
			INSERT INTO users (
				id, email, display_name, password_hash, system_role, source, active, created_at, updated_at
			) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
			command.User.ID, command.User.Email, command.User.DisplayName, command.PasswordHash,
			command.User.SystemRole, command.User.Source, command.User.Active,
			command.User.CreatedAt, command.User.UpdatedAt,
		); err != nil {
			return fmt.Errorf("insert local user: %w", err)
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
	err := a.store.inTransaction(ctx, "add_organization_membership", func(tx pgx.Tx) error {
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
			SELECT id, organization_id, user_id, role, source, active,
			       COALESCE(scim_external_id, ''), COALESCE(scim_user_name, ''), created_at, updated_at
			FROM organization_memberships
			WHERE organization_id = $1 AND user_id = $2
			FOR UPDATE`, membership.OrganizationID, membership.UserID,
		).Scan(
			&existing.ID, &existing.OrganizationID, &existing.UserID, &existing.Role,
			&existing.Source, &existing.Active, &existing.SCIMExternalID, &existing.SCIMUserName,
			&existing.CreatedAt, &existing.UpdatedAt,
		)
		if err == nil {
			if existing.Source != domain.SourceLocal || existing.Role != membership.Role || !existing.Active {
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

func (a *DirectoryAdapter) ListDirectory(ctx context.Context, organizationID string) (directory.Directory, error) {
	return observeRepositoryValue(ctx, "list_directory", func(ctx context.Context) (directory.Directory, error) {
		users, err := a.listMembers(ctx, organizationID)
		if err != nil {
			return directory.Directory{}, err
		}
		groups, err := a.listGroups(ctx, organizationID)
		if err != nil {
			return directory.Directory{}, err
		}
		return directory.Directory{Users: users, Groups: groups}, nil
	})
}

func (a *DirectoryAdapter) listMembers(ctx context.Context, organizationID string) ([]directory.Member, error) {
	rows, err := a.store.pool.Query(ctx, `
		SELECT u.id, u.email, u.display_name, u.system_role, u.source, u.active, u.created_at, u.updated_at,
		       m.id, m.organization_id, m.user_id, m.role, m.source, m.active,
		       COALESCE(m.scim_external_id, ''), COALESCE(m.scim_user_name, ''), m.created_at, m.updated_at
		FROM organization_memberships m
		JOIN users u ON u.id = m.user_id
		WHERE m.organization_id = $1
		ORDER BY u.email, m.id`, organizationID)
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

func insertMembership(ctx context.Context, tx pgx.Tx, membership domain.OrganizationMembership) error {
	if _, err := tx.Exec(ctx, `
		INSERT INTO organization_memberships (
			id, organization_id, user_id, role, source, active,
			scim_external_id, scim_user_name, created_at, updated_at
		) VALUES ($1, $2, $3, $4, $5, $6, NULLIF($7, ''), NULLIF($8, ''), $9, $10)`,
		membership.ID, membership.OrganizationID, membership.UserID, membership.Role,
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
		&member.User.ID, &member.User.Email, &member.User.DisplayName, &member.User.SystemRole,
		&member.User.Source, &member.User.Active, &member.User.CreatedAt, &member.User.UpdatedAt,
		&member.Membership.ID, &member.Membership.OrganizationID, &member.Membership.UserID,
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
