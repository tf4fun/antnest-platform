package repository

import (
	"context"
	"errors"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/tf4fun/antnest-platform/services/identity-service/internal/callercontext"
	"github.com/tf4fun/antnest-platform/services/identity-service/internal/domain"
	"github.com/tf4fun/antnest-platform/services/identity-service/internal/localauth"
)

type LocalAuthAdapter struct{ store *Store }

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

func (a *LocalAuthAdapter) ResolveToken(
	ctx context.Context,
	digest string,
	now time.Time,
) (principal domain.Principal, resultErr error) {
	session, err := a.ResolveTokenSession(ctx, digest, now)
	return session.Principal, err
}

func (a *LocalAuthAdapter) ResolveTokenSession(ctx context.Context, digest string, now time.Time) (callercontext.Session, error) {
	return a.store.resolveBrowserSession(ctx, a.store.pool, "token_hash", digest, now)
}

func (a *LocalAuthAdapter) ResolveSession(ctx context.Context, id string, now time.Time) (callercontext.Session, error) {
	return a.store.resolveBrowserSession(ctx, a.store.pool, "id", id, now)
}

func (s *Store) resolveBrowserSession(ctx context.Context, queryer interface {
	QueryRow(context.Context, string, ...any) pgx.Row
}, column, value string, now time.Time) (callercontext.Session, error) {
	// column is selected only by private, fixed SID and token-hash profiles.
	idleTTL := s.browserIdlePolicy()
	now = s.browserAdmissionTime(now)
	var session callercontext.Session
	principal := &session.Principal
	var userActive, membershipActive, organizationActive bool
	err := queryer.QueryRow(ctx, `
		SELECT t.id, t.expires_at, t.idle_expires_at,
		       u.id, m.organization_id, m.id, u.system_role, m.role,
		       u.active, m.active, o.active, o.slug, o.name
		FROM api_tokens t
		JOIN users u ON u.id = t.user_id
		JOIN organization_memberships m
		  ON m.id = t.membership_id AND m.organization_id = t.organization_id AND m.user_id = u.id
		JOIN organizations o ON o.id = t.organization_id
		WHERE t.`+column+` = $1 AND t.kind = 'browser' AND t.revoked_at IS NULL
		  AND t.expires_at > $2 AND t.idle_expires_at > $2
		  AND m.scim_deleted_at IS NULL`, value, now,
	).Scan(
		&session.ID, &session.ExpiresAt, &session.IdleExpiresAt,
		&principal.UserID, &principal.OrganizationID, &principal.MembershipID,
		&principal.SystemRole, &principal.OrganizationRole,
		&userActive, &membershipActive, &organizationActive,
		&principal.OrganizationSlug, &principal.OrganizationName,
	)
	if err != nil {
		return callercontext.Session{}, normalizeError(err)
	}
	session.ActivityIntervalMS = browserActivityInterval(idleTTL)
	now = s.browserAdmissionTime(now)
	if !session.ExpiresAt.After(now) || !session.IdleExpiresAt.After(now) {
		return callercontext.Session{}, domain.ErrNotFound
	}
	session.ExpiresAt = session.ExpiresAt.UTC()
	session.IdleExpiresAt = session.IdleExpiresAt.UTC()
	principal.Active = userActive && membershipActive && organizationActive
	return session, nil
}

func (a *LocalAuthAdapter) RevokeByTokenHash(
	ctx context.Context, digest string, now time.Time,
) (status localauth.RevokeStatus, resultErr error) {
	status = localauth.RevokeStatusAlreadyInvalid
	resultErr = a.store.inTransaction(ctx, func(tx *databaseTransaction) error {
		var tokenID string
		if err := tx.QueryRow(ctx, `
			SELECT id
			FROM api_tokens
			WHERE token_hash = $1 AND kind = 'browser'
			FOR UPDATE`, digest,
		).Scan(&tokenID); err != nil {
			if errors.Is(err, pgx.ErrNoRows) {
				return nil
			}
			return err
		}
		session, err := a.store.resolveBrowserSession(ctx, tx, "id", tokenID, now)
		if errors.Is(err, domain.ErrNotFound) {
			return nil
		}
		if err != nil {
			return err
		}
		now = a.store.browserAdmissionTime(now)
		if !session.Principal.Active || !session.ExpiresAt.After(now) || !session.IdleExpiresAt.After(now) {
			return nil
		}
		events, err := revokeLockedBrowserSessions(ctx, tx, []string{tokenID}, "", "", "", "session_revoked", now)
		if err != nil {
			return err
		}
		if err := a.store.appendEvent(ctx, tx, event{
			OrganizationID: session.Principal.OrganizationID, ActorPrincipalID: session.Principal.UserID,
			Type: "access_token.revoked", SubjectType: "access_token", SubjectID: tokenID,
			CreatedAt: now,
		}); err != nil {
			return err
		}
		if err := appendSessionRevocations(ctx, tx, events); err != nil {
			return err
		}
		status = localauth.RevokeStatusRevoked
		return nil
	})
	if resultErr != nil {
		return "", resultErr
	}
	return status, resultErr
}
