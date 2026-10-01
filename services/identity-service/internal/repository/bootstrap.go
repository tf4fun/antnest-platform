package repository

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/tf4fun/antnest-platform/services/identity-service/internal/domain"
)

type BootstrapInput struct {
	OrganizationSlug string
	OrganizationName string
	AdminEmail       string
	AdminDisplayName string
	PasswordHash     string
	Now              time.Time
}

type BootstrapResult struct {
	Organization domain.Organization
	User         domain.User
	Membership   domain.OrganizationMembership
}

const identityBootstrapLockID int64 = 0x41544e4553544942

func (s *Store) Bootstrap(ctx context.Context, input BootstrapInput) (BootstrapResult, error) {
	var result BootstrapResult
	err := s.inTransaction(ctx, func(tx *databaseTransaction) error {
		if _, err := tx.Exec(ctx, `SELECT pg_advisory_xact_lock($1)`, identityBootstrapLockID); err != nil {
			return fmt.Errorf("lock identity bootstrap: %w", err)
		}
		organization, created, err := s.bootstrapOrganization(ctx, tx, input)
		if err != nil {
			return err
		}
		user, membership, userCreated, err := s.bootstrapAdministrator(ctx, tx, organization.ID, input)
		if err != nil {
			return err
		}
		result = BootstrapResult{Organization: organization, User: user, Membership: membership}
		if !created && !userCreated {
			return nil
		}
		return s.appendEvent(ctx, tx, event{
			OrganizationID: organization.ID, ActorPrincipalID: user.ID,
			Type: "identity.bootstrap.completed", SubjectType: "organization", SubjectID: organization.ID,
			CreatedAt: input.Now,
		})
	})
	return result, err
}

func (s *Store) bootstrapOrganization(
	ctx context.Context,
	tx *databaseTransaction,
	input BootstrapInput,
) (domain.Organization, bool, error) {
	var organization domain.Organization
	err := tx.QueryRow(ctx, `
		SELECT id, slug, name, active, created_at, updated_at
		FROM organizations
		WHERE slug = $1
		FOR UPDATE`, input.OrganizationSlug,
	).Scan(
		&organization.ID, &organization.Slug, &organization.Name, &organization.Active,
		&organization.CreatedAt, &organization.UpdatedAt,
	)
	if err == nil {
		if organization.Name != input.OrganizationName || !organization.Active {
			return domain.Organization{}, false, domain.ErrConflict
		}
		return organization, false, nil
	}
	if err != pgx.ErrNoRows {
		return domain.Organization{}, false, fmt.Errorf("find bootstrap organization: %w", err)
	}
	organization = domain.Organization{
		ID: s.newID("org"), Slug: input.OrganizationSlug, Name: input.OrganizationName,
		Active: true, CreatedAt: input.Now, UpdatedAt: input.Now,
	}
	if _, err := tx.Exec(ctx, `
		INSERT INTO organizations (id, slug, name, active, created_at, updated_at)
		VALUES ($1, $2, $3, TRUE, $4, $4)`,
		organization.ID, organization.Slug, organization.Name, input.Now,
	); err != nil {
		return domain.Organization{}, false, fmt.Errorf("insert bootstrap organization: %w", err)
	}
	return organization, true, nil
}

func (s *Store) bootstrapAdministrator(
	ctx context.Context,
	tx *databaseTransaction,
	organizationID string,
	input BootstrapInput,
) (domain.User, domain.OrganizationMembership, bool, error) {
	user, membership, err := findBootstrapAdministrator(ctx, tx, organizationID, input.AdminEmail)
	if err == nil {
		if user.SystemRole != domain.SystemRoleAdmin || !user.Active ||
			membership.Role != domain.OrganizationRoleAdmin || membership.Source != domain.SourceLocal || !membership.Active {
			return domain.User{}, domain.OrganizationMembership{}, false, domain.ErrConflict
		}
		return user, membership, false, nil
	}
	if !errors.Is(err, domain.ErrNotFound) {
		return domain.User{}, domain.OrganizationMembership{}, false, err
	}
	user = domain.User{
		ID: s.newID("user"), SystemRole: domain.SystemRoleAdmin, Active: true,
		CreatedAt: input.Now, UpdatedAt: input.Now,
	}
	if _, err := tx.Exec(ctx, `
		INSERT INTO users (id, system_role, active, created_at, updated_at)
		VALUES ($1, 'admin', TRUE, $2, $2)`, user.ID, input.Now,
	); err != nil {
		return domain.User{}, domain.OrganizationMembership{}, false, fmt.Errorf("insert bootstrap administrator: %w", err)
	}
	if _, err := tx.Exec(ctx, `
		INSERT INTO local_credentials (user_id, password_hash, created_at, updated_at)
		VALUES ($1, $2, $3, $3)`, user.ID, input.PasswordHash, input.Now,
	); err != nil {
		return domain.User{}, domain.OrganizationMembership{}, false, fmt.Errorf("insert bootstrap credential: %w", err)
	}
	membership = domain.OrganizationMembership{
		ID: s.newID("membership"), OrganizationID: organizationID, UserID: user.ID,
		Email: input.AdminEmail, DisplayName: input.AdminDisplayName,
		Role: domain.OrganizationRoleAdmin, Source: domain.SourceLocal, Active: true,
		CreatedAt: input.Now, UpdatedAt: input.Now,
	}
	if err := insertMembership(ctx, tx, membership); err != nil {
		return domain.User{}, domain.OrganizationMembership{}, false, err
	}
	return user, membership, true, nil
}

func findBootstrapAdministrator(
	ctx context.Context,
	tx *databaseTransaction,
	organizationID string,
	email string,
) (domain.User, domain.OrganizationMembership, error) {
	var user domain.User
	var membership domain.OrganizationMembership
	err := tx.QueryRow(ctx, `
		SELECT u.id, u.system_role, u.active, u.created_at, u.updated_at,
		       m.id, m.organization_id, m.user_id, m.email, m.display_name,
		       m.role, m.source, m.active, COALESCE(m.scim_external_id, ''),
		       COALESCE(m.scim_user_name, ''), m.created_at, m.updated_at
		FROM organization_memberships m
		JOIN users u ON u.id = m.user_id
		JOIN local_credentials c ON c.user_id = u.id
		WHERE m.organization_id = $1 AND m.email = $2
		FOR UPDATE OF u, m, c`, organizationID, email,
	).Scan(
		&user.ID, &user.SystemRole, &user.Active, &user.CreatedAt, &user.UpdatedAt,
		&membership.ID, &membership.OrganizationID, &membership.UserID,
		&membership.Email, &membership.DisplayName, &membership.Role, &membership.Source,
		&membership.Active, &membership.SCIMExternalID, &membership.SCIMUserName,
		&membership.CreatedAt, &membership.UpdatedAt,
	)
	if err != nil {
		return domain.User{}, domain.OrganizationMembership{}, normalizeError(err)
	}
	return user, membership, nil
}

func (s *Store) FailExpiredOIDCSessions(ctx context.Context, now time.Time) (int64, error) {
	type expiredSession struct{ id, organizationID, requestID string }
	var expired []expiredSession
	err := s.inTransaction(ctx, func(tx *databaseTransaction) error {
		rows, err := tx.Query(ctx, `
			SELECT id, organization_id, request_id
			FROM oidc_auth_sessions
			WHERE status = 'exchanging' AND expires_at <= $1
			FOR UPDATE`, now)
		if err != nil {
			return fmt.Errorf("find expired OIDC sessions: %w", err)
		}
		for rows.Next() {
			var session expiredSession
			if err := rows.Scan(&session.id, &session.organizationID, &session.requestID); err != nil {
				rows.Close()
				return fmt.Errorf("scan expired OIDC session: %w", err)
			}
			expired = append(expired, session)
		}
		if err := rows.Err(); err != nil {
			rows.Close()
			return fmt.Errorf("iterate expired OIDC sessions: %w", err)
		}
		rows.Close()
		for _, session := range expired {
			if _, err := tx.Exec(ctx, `
				UPDATE oidc_auth_sessions
				SET status = 'failed', failure_stage = 'expired',
				    failure_reason = 'callback did not complete before session expiry',
				    failed_at = $2, updated_at = $2
				WHERE id = $1 AND status = 'exchanging'`, session.id, now); err != nil {
				return fmt.Errorf("expire interrupted OIDC session: %w", err)
			}
			if err := s.appendEvent(ctx, tx, event{
				OrganizationID: session.organizationID, Type: "oidc_login.expired",
				SubjectType: "oidc_auth_session", SubjectID: session.id,
				RequestID: session.requestID, Metadata: map[string]any{"recovery": true}, CreatedAt: now,
			}); err != nil {
				return err
			}
		}
		return nil
	})
	return int64(len(expired)), err
}
