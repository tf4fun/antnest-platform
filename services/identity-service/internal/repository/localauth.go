package repository

import (
	"context"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"

	"soft/antnest-platform/services/identity-service/internal/domain"
	"soft/antnest-platform/services/identity-service/internal/localauth"
)

type LocalAuthAdapter struct{ store *Store }

func (a *LocalAuthAdapter) FindLocalCredential(
	ctx context.Context,
	organizationSlug string,
	email string,
) (localauth.LocalCredential, error) {
	return observeRepositoryValue(ctx, "find_local_credential", func(ctx context.Context) (localauth.LocalCredential, error) {
		var result localauth.LocalCredential
		var userActive, membershipActive, organizationActive bool
		err := a.store.pool.QueryRow(ctx, `
			SELECT u.password_hash, u.id, m.organization_id, m.id, u.system_role, m.role,
			       u.active, m.active, o.active
			FROM users u
			JOIN organization_memberships m ON m.user_id = u.id
			JOIN organizations o ON o.id = m.organization_id
			WHERE o.slug = $1 AND u.email = $2 AND u.password_hash IS NOT NULL`,
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
	err := a.store.pool.QueryRow(ctx, `
		UPDATE api_tokens t
		SET last_used_at = CASE
			WHEN t.last_used_at IS NULL OR t.last_used_at < $2::timestamptz - interval '5 minutes'
				THEN $2::timestamptz
			ELSE t.last_used_at
		END
		FROM users u, organization_memberships m, organizations o
		WHERE t.token_hash = $1 AND t.revoked_at IS NULL AND t.expires_at > $2
		  AND u.id = t.user_id
		  AND m.id = t.membership_id AND m.organization_id = t.organization_id AND m.user_id = u.id
		  AND o.id = t.organization_id
		RETURNING u.id, m.organization_id, m.id, u.system_role, m.role,
		          u.active, m.active, o.active`, digest, now,
	).Scan(
		&principal.UserID, &principal.OrganizationID, &principal.MembershipID,
		&principal.SystemRole, &principal.OrganizationRole,
		&userActive, &membershipActive, &organizationActive,
	)
	if err != nil {
		return domain.Principal{}, normalizeError(err)
	}
	principal.Active = userActive && membershipActive && organizationActive
	return principal, nil
}

func (a *LocalAuthAdapter) RevokeToken(
	ctx context.Context,
	actorUserID string,
	tokenID string,
	now time.Time,
) error {
	return a.store.inTransaction(ctx, "revoke_access_token", func(tx pgx.Tx) error {
		var ownerUserID, organizationID string
		var alreadyRevoked bool
		if err := tx.QueryRow(ctx, `
			SELECT user_id, organization_id, revoked_at IS NOT NULL
			FROM api_tokens
			WHERE id = $1
			FOR UPDATE`, tokenID,
		).Scan(&ownerUserID, &organizationID, &alreadyRevoked); err != nil {
			return err
		}
		principal, err := a.store.getPrincipal(ctx, tx, actorUserID, organizationID)
		if err != nil {
			return err
		}
		if actorUserID != ownerUserID && !principal.CanAdminister(organizationID) {
			return domain.ErrForbidden
		}
		if alreadyRevoked {
			return nil
		}
		if _, err := tx.Exec(ctx, `UPDATE api_tokens SET revoked_at = $2 WHERE id = $1`, tokenID, now); err != nil {
			return fmt.Errorf("revoke API token: %w", err)
		}
		return a.store.appendEvent(ctx, tx, event{
			OrganizationID: organizationID, ActorPrincipalID: actorUserID,
			Type: "access_token.revoked", SubjectType: "access_token", SubjectID: tokenID,
			CreatedAt: now,
		})
	})
}
