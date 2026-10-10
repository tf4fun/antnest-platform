package repository

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/tf4fun/antnest-platform/services/identity-service/internal/browsersessions"
	"github.com/tf4fun/antnest-platform/services/identity-service/internal/callercontext"
	"github.com/tf4fun/antnest-platform/services/identity-service/internal/credentials"
	"github.com/tf4fun/antnest-platform/services/identity-service/internal/domain"
)

func (a *BrowserSessionsAdapter) GetLocalCredential(ctx context.Context, userID string) (domain.LocalCredential, error) {
	return a.store.Directory().GetLocalCredential(ctx, userID)
}

func (a *BrowserSessionsAdapter) ChangePassword(ctx context.Context, command browsersessions.PasswordCommand) (browsersessions.PasswordResult, error) {
	var result browsersessions.PasswordResult
	var checkedAt time.Time
	idleTTL := a.store.browserIdlePolicy()
	claims := command.Caller.Claims()
	err := a.store.inTransaction(ctx, func(tx *databaseTransaction) error {
		// Serialize issuance, rotation and all-user revocation on User first.
		// Parent locks precede token locks and feed writer locks in every path.
		for _, lock := range []struct{ query, id string }{
			{`SELECT id FROM users WHERE id = $1 AND active FOR UPDATE`, claims.Subject},
			{`SELECT id FROM organizations WHERE id = $1 AND active FOR SHARE`, claims.Organization},
			{`SELECT id FROM organization_memberships WHERE id = $1 AND active AND scim_deleted_at IS NULL FOR SHARE`, claims.Membership},
		} {
			var id string
			if err := tx.QueryRow(ctx, lock.query, lock.id).Scan(&id); err != nil {
				if errors.Is(err, pgx.ErrNoRows) {
					return callercontext.ErrInvalid
				}
				return err
			}
		}
		ids, err := lockBrowserSessionIDs(ctx, tx, claims.Subject)
		if err != nil {
			return err
		}
		live, err := a.store.revalidateBrowserCaller(ctx, tx, command.Caller)
		if err != nil {
			return err
		}
		var hint string
		if err := tx.QueryRow(ctx, `SELECT user_agent_hint FROM api_tokens WHERE id = $1`, live.ID).Scan(&hint); err != nil {
			return err
		}
		now := a.store.browserAdmissionTime(time.Time{})
		if !live.ExpiresAt.After(now) || !live.IdleExpiresAt.After(now) {
			return callercontext.ErrInvalid
		}
		updated, err := tx.Exec(ctx, `UPDATE local_credentials SET password_hash = $3, updated_at = $4
			WHERE user_id = $1 AND password_hash = $2`, live.Principal.UserID, command.ExpectedPasswordHash, command.PasswordHash, now)
		if err != nil {
			return err
		}
		if updated.RowsAffected() != 1 {
			return domain.ErrConflict
		}
		events, err := revokeLockedBrowserSessions(ctx, tx, ids, "", "", "", "password_changed", now)
		if err != nil {
			return err
		}
		raw, hash, err := credentials.NewOpaqueToken("ant_api_")
		if err != nil {
			return err
		}
		result.TokenID = a.store.newID("authtoken")
		if err := tx.QueryRow(ctx, `INSERT INTO api_tokens
			(id, token_hash, public_session_id, user_id, organization_id, membership_id, issued_at, last_used_at, expires_at, idle_expires_at, user_agent_hint)
			VALUES ($1, $2, $3, $4, $5, $6, $7, $7, $8, LEAST($8::timestamptz, $9::timestamptz), $10)
			RETURNING expires_at, idle_expires_at`, result.TokenID, hash, a.store.newID("browsersession"), live.Principal.UserID,
			live.Principal.OrganizationID, live.Principal.MembershipID, now, live.ExpiresAt, now.Add(idleTTL), hint).Scan(&result.ExpiresAt, &result.IdleExpiresAt); err != nil {
			return err
		}
		fresh := a.store.browserAdmissionTime(now)
		if !live.IdleExpiresAt.After(fresh) || !result.ExpiresAt.After(fresh) || !result.IdleExpiresAt.After(fresh) {
			return callercontext.ErrInvalid
		}
		result.Status, result.Principal, result.AccessToken = "changed", live.Principal, raw
		result.ExpiresAt, result.IdleExpiresAt = result.ExpiresAt.UTC(), result.IdleExpiresAt.UTC()
		result.ActivityIntervalMS = browserActivityInterval(idleTTL)
		if err := a.store.appendEvent(ctx, tx, event{OrganizationID: live.Principal.OrganizationID, ActorPrincipalID: live.Principal.UserID, Type: "local_credential.changed", SubjectType: "user", SubjectID: live.Principal.UserID, RequestID: command.RequestID, CreatedAt: now}); err != nil {
			return err
		}
		if err := a.store.appendEvent(ctx, tx, event{OrganizationID: live.Principal.OrganizationID, ActorPrincipalID: live.Principal.UserID, Type: "access_token.issued", SubjectType: "access_token", SubjectID: result.TokenID, RequestID: command.RequestID, CreatedAt: now}); err != nil {
			return err
		}
		if err := appendSessionRevocations(ctx, tx, events); err != nil {
			return err
		}
		// The feed writer may wait after issuance. An expired replacement must
		// roll the entire transaction back rather than return a dead credential.
		checkedAt = a.store.browserAdmissionTime(fresh)
		if !result.ExpiresAt.After(checkedAt) || !result.IdleExpiresAt.After(checkedAt) {
			return callercontext.ErrInvalid
		}
		return nil
	})
	// An ambiguous commit never exposes a replayable credential. The caller
	// must log in with the new password if its successful response was lost.
	if err != nil {
		return browsersessions.PasswordResult{}, fmt.Errorf("rotate browser password: %w", err)
	}
	// Commit acknowledgement can arrive after expiry. Its effects are durable,
	// but no expired raw credential is returned and no rollback is promised.
	checkedAt = a.store.browserAdmissionTime(checkedAt)
	if !result.ExpiresAt.After(checkedAt) || !result.IdleExpiresAt.After(checkedAt) {
		return browsersessions.PasswordResult{}, callercontext.ErrInvalid
	}
	return result, nil
}
