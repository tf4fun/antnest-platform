package repository

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"

	"soft/antnest-platform/services/identity-service/internal/domain"
	"soft/antnest-platform/services/identity-service/internal/localauth"
)

type LocalAuthAdapter struct{ store *Store }

const tokenLastUsedSampleWindow = 5 * time.Minute

func (a *LocalAuthAdapter) FindLocalCredential(
	ctx context.Context,
	organizationSlug string,
	email string,
) (localauth.LocalCredential, error) {
	return observeRepositoryValue(ctx, "find_local_credential", func(ctx context.Context) (localauth.LocalCredential, error) {
		var result localauth.LocalCredential
		var userActive, membershipActive, organizationActive bool
		err := a.store.pool.QueryRow(ctx, `
			SELECT c.password_hash, u.id, m.organization_id, m.id, u.system_role, m.role,
			       u.active, m.active, o.active
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
		)
		if err != nil {
			return localauth.LocalCredential{}, normalizeError(err)
		}
		result.Principal.Active = userActive && membershipActive && organizationActive
		return result, nil
	})
}

func (a *LocalAuthAdapter) IssueToken(
	ctx context.Context,
	command localauth.IssueTokenCommand,
) (localauth.Token, error) {
	err := a.store.inTransaction(ctx, "issue_access_token", func(tx pgx.Tx) error {
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

func (a *LocalAuthAdapter) ResolveToken(
	ctx context.Context,
	digest string,
	now time.Time,
) (principal domain.Principal, resultErr error) {
	ctx, finish := startRepositoryOperation(ctx, "resolve_access_token")
	defer func() { finish(resultErr) }()
	var userActive, membershipActive, organizationActive bool
	var tokenID string
	var lastUsedAt *time.Time
	err := a.store.pool.QueryRow(ctx, `
		SELECT t.id, t.last_used_at,
		       u.id, m.organization_id, m.id, u.system_role, m.role,
		       u.active, m.active, o.active
		FROM api_tokens t
		JOIN users u ON u.id = t.user_id
		JOIN organization_memberships m
		  ON m.id = t.membership_id AND m.organization_id = t.organization_id AND m.user_id = u.id
		JOIN organizations o ON o.id = t.organization_id
		WHERE t.token_hash = $1 AND t.revoked_at IS NULL AND t.expires_at > $2
		  AND m.scim_deleted_at IS NULL`, digest, now,
	).Scan(
		&tokenID, &lastUsedAt,
		&principal.UserID, &principal.OrganizationID, &principal.MembershipID,
		&principal.SystemRole, &principal.OrganizationRole,
		&userActive, &membershipActive, &organizationActive,
	)
	if err != nil {
		return domain.Principal{}, normalizeError(err)
	}
	if shouldTouchTokenLastUsed(lastUsedAt, now) {
		_ = a.touchTokenLastUsed(ctx, tokenID, now)
	}
	principal.Active = userActive && membershipActive && organizationActive
	return principal, nil
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
	resultErr = a.store.inTransaction(ctx, "revoke_access_token", func(tx pgx.Tx) error {
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
