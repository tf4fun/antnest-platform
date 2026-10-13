package repository

import (
	"context"
	"time"

	"github.com/tf4fun/antnest-platform/services/identity-service/internal/browsersessions"
	"github.com/tf4fun/antnest-platform/services/identity-service/internal/callercontext"
	"github.com/tf4fun/antnest-platform/services/identity-service/internal/credentials"
	"github.com/tf4fun/antnest-platform/services/identity-service/internal/domain"
)

// The caller owns authority, credential and SID locks, and supplies the remaining
// database wait budget as the context deadline. This helper performs no KDF work.
func (a *BrowserSessionsAdapter) rotateBrowserPassword(ctx context.Context, tx *databaseTransaction, attempt browsersessions.PasswordAttempt, prepared browsersessions.PasswordPreparation, live callercontext.Session, ids []string) (browsersessions.PasswordResult, error) {
	var result browsersessions.PasswordResult
	idleTTL := a.store.browserIdlePolicy()
	var hint string
	if err := tx.QueryRow(ctx, `SELECT user_agent_hint FROM api_tokens WHERE id = $1`, live.ID).Scan(&hint); err != nil {
		return result, err
	}
	now := a.store.browserAdmissionTime(time.Time{})
	if !live.ExpiresAt.After(now) || !live.IdleExpiresAt.After(now) {
		return result, callercontext.ErrInvalid
	}
	updated, err := tx.Exec(ctx, `UPDATE local_credentials SET password_hash = $3, updated_at = $4
		WHERE user_id = $1 AND password_hash = $2`, live.Principal.UserID, prepared.ExpectedPasswordHash, prepared.PasswordHash, now)
	if err != nil {
		return result, err
	}
	if updated.RowsAffected() != 1 {
		return result, domain.ErrConflict
	}
	events, err := revokeLockedBrowserSessions(ctx, tx, ids, "", "", "", "password_changed", now)
	if err != nil {
		return result, err
	}
	raw, hash, err := credentials.NewOpaqueToken("ant_api_")
	if err != nil {
		return result, err
	}
	result.TokenID = a.store.newID("authtoken")
	if err := tx.QueryRow(ctx, `INSERT INTO api_tokens
		(id, token_hash, public_session_id, user_id, organization_id, membership_id, issued_at, last_used_at, expires_at, idle_expires_at, user_agent_hint)
		VALUES ($1, $2, $3, $4, $5, $6, $7, $7, $8, LEAST($8::timestamptz, $9::timestamptz), $10)
		RETURNING expires_at, idle_expires_at`, result.TokenID, hash, a.store.newID("browsersession"), live.Principal.UserID,
		live.Principal.OrganizationID, live.Principal.MembershipID, now, live.ExpiresAt, now.Add(idleTTL), hint).Scan(&result.ExpiresAt, &result.IdleExpiresAt); err != nil {
		return result, err
	}
	fresh := a.store.browserAdmissionTime(now)
	if !live.IdleExpiresAt.After(fresh) || !result.ExpiresAt.After(fresh) || !result.IdleExpiresAt.After(fresh) {
		return result, callercontext.ErrInvalid
	}
	result.Status, result.Principal, result.AccessToken = "changed", live.Principal, raw
	result.ExpiresAt, result.IdleExpiresAt = result.ExpiresAt.UTC(), result.IdleExpiresAt.UTC()
	result.ActivityIntervalMS = browserActivityInterval(idleTTL)
	if err := a.store.appendEvent(ctx, tx, event{OrganizationID: live.Principal.OrganizationID, ActorPrincipalID: live.Principal.UserID, Type: "local_credential.changed", SubjectType: "user", SubjectID: live.Principal.UserID, RequestID: attempt.RequestID, CreatedAt: now}); err != nil {
		return result, err
	}
	if err := a.store.appendEvent(ctx, tx, event{OrganizationID: live.Principal.OrganizationID, ActorPrincipalID: live.Principal.UserID, Type: "access_token.issued", SubjectType: "access_token", SubjectID: result.TokenID, RequestID: attempt.RequestID, CreatedAt: now}); err != nil {
		return result, err
	}
	if err := appendSessionRevocations(ctx, tx, events); err != nil {
		return result, err
	}
	return result, nil
}
