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
	idleTTL := a.store.browserIdlePolicy()
	idle := command.IssuedAt.Add(idleTTL)
	if command.ExpiresAt.Before(idle) {
		idle = command.ExpiresAt
	}
	result := localauth.Token{ID: command.TokenID, ActivityIntervalMS: browserActivityInterval(idleTTL)}
	err := a.store.inTransaction(ctx, func(tx *databaseTransaction) error {
		if err := lockVerifiedLocalCredential(ctx, tx, command); err != nil {
			return err
		}
		now := a.store.browserAdmissionTime(command.IssuedAt)
		if !command.ExpiresAt.After(now) || !idle.After(now) {
			return domain.ErrUnauthenticated
		}
		if err := tx.QueryRow(ctx, `
			INSERT INTO api_tokens (
				id, token_hash, user_id, organization_id, membership_id, issued_at, expires_at,
				public_session_id, idle_expires_at, last_used_at, user_agent_hint
			) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $6, $10)
			RETURNING expires_at, idle_expires_at`,
			command.TokenID, command.TokenHash, command.Principal.UserID,
			command.Principal.OrganizationID, command.Principal.MembershipID,
			command.IssuedAt, command.ExpiresAt,
			a.store.newID("browsersession"), idle, command.UserAgentHint,
		).Scan(&result.ExpiresAt, &result.IdleExpiresAt); err != nil {
			return fmt.Errorf("insert API token: %w", err)
		}
		// PostgreSQL timestamps have microsecond precision. Admit the stored
		// deadlines, including time spent inserting, before recording issuance.
		now = a.store.browserAdmissionTime(now)
		if !result.ExpiresAt.After(now) || !result.IdleExpiresAt.After(now) {
			return domain.ErrUnauthenticated
		}
		return a.store.appendEvent(ctx, tx, event{
			OrganizationID:   command.Principal.OrganizationID,
			ActorPrincipalID: command.Principal.UserID,
			Type:             "access_token.issued", SubjectType: "access_token", SubjectID: command.TokenID,
			RequestID: command.RequestID, CreatedAt: command.IssuedAt,
		})
	})
	if err != nil {
		return localauth.Token{}, err
	}
	result.ExpiresAt = result.ExpiresAt.UTC()
	result.IdleExpiresAt = result.IdleExpiresAt.UTC()
	return result, nil
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
