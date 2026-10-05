package repository

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/tf4fun/antnest-platform/services/identity-service/internal/callercontext"
	"github.com/tf4fun/antnest-platform/services/identity-service/internal/domain"
	"github.com/tf4fun/antnest-platform/services/identity-service/internal/localauth"
)

type LocalAuthAdapter struct{ store *Store }

const tokenLastUsedSampleWindow = 5 * time.Minute

func (a *LocalAuthAdapter) FindLocalCredential(
	ctx context.Context,
	organizationSlug string,
	email string,
) (localauth.LocalCredential, error) {
	var result localauth.LocalCredential
	var userActive, membershipActive, organizationActive bool
	err := a.store.pool.QueryRow(ctx, `
			SELECT c.password_hash, u.id, m.organization_id, m.id, u.system_role, m.role,
			       u.active, m.active, o.active, o.slug, o.name
			FROM users u
			JOIN local_credentials c ON c.user_id = u.id
			JOIN organization_memberships m ON m.user_id = u.id
			JOIN organizations o ON o.id = m.organization_id
			WHERE o.slug = $1 AND m.email = $2 AND m.scim_deleted_at IS NULL`,
		organizationSlug, email,
	).Scan(
		&result.PasswordHash, &result.Principal.UserID, &result.Principal.OrganizationID,
		&result.Principal.MembershipID, &result.Principal.SystemRole,
		&result.Principal.OrganizationRole, &userActive, &membershipActive, &organizationActive,
		&result.Principal.OrganizationSlug, &result.Principal.OrganizationName,
	)
	if err != nil {
		return localauth.LocalCredential{}, normalizeError(err)
	}
	result.Principal.Active = userActive && membershipActive && organizationActive
	return result, nil
}

func (a *LocalAuthAdapter) IssueToken(
	ctx context.Context,
	command localauth.IssueTokenCommand,
) (localauth.Token, error) {
	err := a.store.inTransaction(ctx, func(tx *databaseTransaction) error {
		if err := lockVerifiedLocalCredential(ctx, tx, command); err != nil {
			return err
		}
		if _, err := tx.Exec(ctx, `
			INSERT INTO api_tokens (
				id, token_hash, user_id, organization_id, membership_id, issued_at, expires_at
			) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
			command.TokenID, command.TokenHash, command.Principal.UserID,
			command.Principal.OrganizationID, command.Principal.MembershipID,
			command.IssuedAt, command.ExpiresAt,
		); err != nil {
			return fmt.Errorf("insert API token: %w", err)
		}
		return a.store.appendEvent(ctx, tx, event{
			OrganizationID:   command.Principal.OrganizationID,
			ActorPrincipalID: command.Principal.UserID,
			Type:             "access_token.issued", SubjectType: "access_token", SubjectID: command.TokenID,
			RequestID: command.RequestID, CreatedAt: command.IssuedAt,
		})
	})
	return localauth.Token{ID: command.TokenID, ExpiresAt: command.ExpiresAt}, err
}

func lockVerifiedLocalCredential(ctx context.Context, tx *databaseTransaction, command localauth.IssueTokenCommand) error {
	// Match directory authorization/deactivation: User, then Organization,
	// then Membership/credential. Hold verified facts through issuance.
	var userID string
	if err := tx.QueryRow(ctx, `
		SELECT id FROM users WHERE id = $1 AND active FOR SHARE`,
		command.Principal.UserID).Scan(&userID); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return domain.ErrUnauthenticated
		}
		return fmt.Errorf("lock login user: %w", err)
	}
	var organizationID string
	if err := tx.QueryRow(ctx, `
		SELECT id FROM organizations WHERE id = $1 AND active FOR SHARE`,
		command.Principal.OrganizationID).Scan(&organizationID); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return domain.ErrUnauthenticated
		}
		return fmt.Errorf("lock login organization: %w", err)
	}
	var current domain.Principal
	err := tx.QueryRow(ctx, `
		SELECT u.id, m.organization_id, m.id, u.system_role, m.role, TRUE
		FROM users u
		JOIN local_credentials c ON c.user_id = u.id
		JOIN organization_memberships m ON m.user_id = u.id
		WHERE u.id = $1 AND m.organization_id = $2 AND m.id = $3
		  AND u.active AND m.active AND m.scim_deleted_at IS NULL
		  AND c.password_hash = $4
		FOR SHARE OF m, c`, userID, organizationID,
		command.Principal.MembershipID, command.ExpectedPasswordHash,
	).Scan(&current.UserID, &current.OrganizationID, &current.MembershipID,
		&current.SystemRole, &current.OrganizationRole, &current.Active)
	if errors.Is(err, pgx.ErrNoRows) {
		return domain.ErrUnauthenticated
	}
	if err != nil {
		return fmt.Errorf("revalidate verified local credential: %w", err)
	}
	// Revalidate authorization facts, not organization display metadata. A
	// rename between password verification and issuance does not revoke access.
	// Compare every remaining field so new authorization facts are not omitted.
	expected := command.Principal
	current.OrganizationSlug, current.OrganizationName = "", ""
	expected.OrganizationSlug, expected.OrganizationName = "", ""
	if current != expected {
		return domain.ErrUnauthenticated
	}
	return nil
}

func (a *LocalAuthAdapter) ResolveToken(
	ctx context.Context,
	digest string,
	now time.Time,
) (principal domain.Principal, resultErr error) {
	session, err := a.ResolveTokenSession(ctx, digest, now)
	return session.Principal, err
}

func (a *LocalAuthAdapter) ResolveTokenSession(ctx context.Context, digest string, now time.Time) (callercontext.Session, error) {
	return a.resolveSession(ctx, "token_hash", digest, now, true)
}

func (a *LocalAuthAdapter) ResolveSession(ctx context.Context, id string, now time.Time) (callercontext.Session, error) {
	return a.resolveSession(ctx, "id", id, now, false)
}

func (a *LocalAuthAdapter) resolveSession(ctx context.Context, column, value string, now time.Time, touch bool) (callercontext.Session, error) {
	// column is selected only by the two private, fixed query profiles above.
	var session callercontext.Session
	principal := &session.Principal
	var userActive, membershipActive, organizationActive bool
	var lastUsedAt *time.Time
	err := a.store.pool.QueryRow(ctx, `
		SELECT t.id, t.last_used_at, t.expires_at,
		       u.id, m.organization_id, m.id, u.system_role, m.role,
		       u.active, m.active, o.active, o.slug, o.name
		FROM api_tokens t
		JOIN users u ON u.id = t.user_id
		JOIN organization_memberships m
		  ON m.id = t.membership_id AND m.organization_id = t.organization_id AND m.user_id = u.id
		JOIN organizations o ON o.id = t.organization_id
		WHERE t.`+column+` = $1 AND t.revoked_at IS NULL AND t.expires_at > $2
		  AND m.scim_deleted_at IS NULL`, value, now,
	).Scan(
		&session.ID, &lastUsedAt, &session.ExpiresAt,
		&principal.UserID, &principal.OrganizationID, &principal.MembershipID,
		&principal.SystemRole, &principal.OrganizationRole,
		&userActive, &membershipActive, &organizationActive,
		&principal.OrganizationSlug, &principal.OrganizationName,
	)
	if err != nil {
		return callercontext.Session{}, normalizeError(err)
	}
	if touch && shouldTouchTokenLastUsed(lastUsedAt, now) {
		_ = a.touchTokenLastUsed(ctx, session.ID, now)
	}
	principal.Active = userActive && membershipActive && organizationActive
	return session, nil
}

func shouldTouchTokenLastUsed(lastUsedAt *time.Time, now time.Time) bool {
	return lastUsedAt == nil || lastUsedAt.Before(now.Add(-tokenLastUsedSampleWindow))
}

func (a *LocalAuthAdapter) touchTokenLastUsed(ctx context.Context, tokenID string, now time.Time) error {
	_, err := a.store.pool.Exec(ctx, `
		UPDATE api_tokens
		SET last_used_at = $2
		WHERE id = $1
		  AND (last_used_at IS NULL OR last_used_at < $2::timestamptz - interval '5 minutes')`,
		tokenID, now,
	)
	return err
}

func (a *LocalAuthAdapter) RevokeByTokenHash(
	ctx context.Context, digest string, now time.Time,
) (status localauth.RevokeStatus, resultErr error) {
	status = localauth.RevokeStatusAlreadyInvalid
	resultErr = a.store.inTransaction(ctx, func(tx *databaseTransaction) error {
		var tokenID, ownerUserID, organizationID string
		var expiresAt time.Time
		var revokedAt *time.Time
		if err := tx.QueryRow(ctx, `
			SELECT id, user_id, organization_id, expires_at, revoked_at
			FROM api_tokens
			WHERE token_hash = $1
			FOR UPDATE`, digest,
		).Scan(&tokenID, &ownerUserID, &organizationID, &expiresAt, &revokedAt); err != nil {
			if errors.Is(err, pgx.ErrNoRows) {
				return nil
			}
			return err
		}
		if revokedAt != nil || !expiresAt.After(now) {
			return nil
		}
		if _, err := tx.Exec(ctx, `UPDATE api_tokens SET revoked_at = $2 WHERE id = $1`, tokenID, now); err != nil {
			return fmt.Errorf("revoke API token: %w", err)
		}
		if err := a.store.appendEvent(ctx, tx, event{
			OrganizationID: organizationID, ActorPrincipalID: ownerUserID,
			Type: "access_token.revoked", SubjectType: "access_token", SubjectID: tokenID,
			CreatedAt: now,
		}); err != nil {
			return err
		}
		status = localauth.RevokeStatusRevoked
		return nil
	})
	return status, resultErr
}
