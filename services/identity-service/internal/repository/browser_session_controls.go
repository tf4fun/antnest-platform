package repository

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/tf4fun/antnest-platform/services/identity-service/internal/browsersessions"
	"github.com/tf4fun/antnest-platform/services/identity-service/internal/callercontext"
	"github.com/tf4fun/antnest-platform/services/identity-service/internal/domain"
)

type BrowserSessionsAdapter struct{ store *Store }

func (s *Store) revalidateBrowserCaller(ctx context.Context, tx *databaseTransaction, caller *callercontext.Caller) (callercontext.Session, error) {
	return caller.Revalidate(ctx, func(ctx context.Context, sid string, observed time.Time) (callercontext.Session, error) {
		return s.resolveBrowserSession(ctx, tx, "id", sid, observed)
	})
}

// RPC admission requires a typed Caller. Internal directory operations may
// omit browser authority, but a present invalid context must fail closed.
// Call after the final business lock and before changing the caller's own
// role or token. The transaction resolver does not acquire actor parent locks.
func (s *Store) revalidateDirectoryCaller(ctx context.Context, tx *databaseTransaction, actorID, organizationID string) error {
	caller, err := callercontext.OptionalCallerFromContext(ctx)
	if err != nil || caller == nil {
		return err
	}
	live, err := s.revalidateBrowserCaller(ctx, tx, caller)
	if err != nil {
		return err
	}
	if live.Principal.UserID != actorID || (organizationID != "" && live.Principal.OrganizationID != organizationID) {
		return callercontext.ErrInvalid
	}
	return nil
}

func (s *Store) authorizeBrowserAccess(ctx context.Context, tx *databaseTransaction, access browsersessions.Access) (callercontext.Session, error) {
	// No actor or additional parent locks: mutual administrator revocations
	// already hold different target Users and must not acquire each other's.
	if access.Scope == "organization" {
		var present bool
		if err := tx.QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM organization_memberships
			WHERE user_id = $1 AND organization_id = $2 AND scim_deleted_at IS NULL)`, access.UserID, access.Caller.Claims().Organization).Scan(&present); err != nil {
			return callercontext.Session{}, err
		}
		if !present {
			return callercontext.Session{}, domain.ErrNotFound
		}
	}
	live, err := s.revalidateBrowserCaller(ctx, tx, access.Caller)
	if err != nil {
		return callercontext.Session{}, err
	}
	if err := access.Authorize(live.Principal); err != nil {
		return callercontext.Session{}, err
	}
	return live, nil
}

func (a *BrowserSessionsAdapter) Touch(ctx context.Context, caller *callercontext.Caller) (browsersessions.Deadlines, error) {
	var result browsersessions.Deadlines
	idleTTL := a.store.browserIdlePolicy()
	err := a.store.inTransaction(ctx, func(tx *databaseTransaction) error {
		var id string
		if err := tx.QueryRow(ctx, `SELECT id FROM api_tokens WHERE id = $1 AND kind = 'browser' FOR UPDATE`, caller.Claims().Session).Scan(&id); err != nil {
			if errors.Is(err, pgx.ErrNoRows) {
				return callercontext.ErrInvalid
			}
			return err
		}
		live, err := a.store.revalidateBrowserCaller(ctx, tx, caller)
		if err != nil {
			return err
		}
		now := a.store.browserAdmissionTime(time.Time{})
		if !live.ExpiresAt.After(now) || !live.IdleExpiresAt.After(now) {
			return callercontext.ErrInvalid
		}
		if err := tx.QueryRow(ctx, `UPDATE api_tokens SET last_used_at = $2, idle_expires_at = LEAST(expires_at, $3)
			WHERE id = $1 RETURNING expires_at, idle_expires_at`, id, now, now.Add(idleTTL)).Scan(&result.ExpiresAt, &result.IdleExpiresAt); err != nil {
			return err
		}
		// Keep the original idle admission bound even if insertion hooks or a
		// storage delay cross it. Reading our renewed deadline cannot revive it.
		fresh := a.store.browserAdmissionTime(now)
		if !live.ExpiresAt.After(fresh) || !live.IdleExpiresAt.After(fresh) || !result.IdleExpiresAt.After(fresh) {
			return callercontext.ErrInvalid
		}
		if _, err := a.store.revalidateBrowserCaller(ctx, tx, caller); err != nil {
			return err
		}
		result.ExpiresAt, result.IdleExpiresAt = result.ExpiresAt.UTC(), result.IdleExpiresAt.UTC()
		result.ActivityIntervalMS = browserActivityInterval(idleTTL)
		return nil
	})
	if err != nil {
		return browsersessions.Deadlines{}, err
	}
	return result, nil
}

func (a *BrowserSessionsAdapter) List(ctx context.Context, access browsersessions.Access, input browsersessions.ListInput) (browsersessions.Page, error) {
	page := browsersessions.Page{Sessions: []browsersessions.Session{}}
	err := a.store.inTransaction(ctx, func(tx *databaseTransaction) error {
		live, err := a.store.authorizeBrowserAccess(ctx, tx, access)
		if err != nil {
			return err
		}
		organizationID := ""
		if access.Scope == "organization" {
			organizationID = live.Principal.OrganizationID
		}
		rows, err := tx.Query(ctx, `SELECT t.public_session_id, o.id, o.slug, o.name, t.issued_at, t.last_used_at,
			t.idle_expires_at, t.expires_at, t.user_agent_hint, t.id = $5
			FROM api_tokens t JOIN users u ON u.id = t.user_id
			JOIN organizations o ON o.id = t.organization_id
			JOIN organization_memberships m ON m.id = t.membership_id AND m.organization_id = o.id AND m.user_id = u.id
			WHERE t.user_id = $1 AND ($2 = '' OR t.organization_id = $2)
			AND t.kind = 'browser' AND t.revoked_at IS NULL AND t.expires_at > $3 AND t.idle_expires_at > $3
			AND u.active AND o.active AND m.active AND m.scim_deleted_at IS NULL
			AND t.public_session_id > $4 ORDER BY t.public_session_id LIMIT $6`,
			access.UserID, organizationID, a.store.browserAdmissionTime(time.Time{}), input.AfterID, live.ID, input.Limit+1)
		if err != nil {
			return err
		}
		items, err := pgx.CollectRows(rows, func(row pgx.CollectableRow) (browsersessions.Session, error) {
			var item browsersessions.Session
			err := row.Scan(&item.ID, &item.OrganizationID, &item.OrganizationSlug, &item.OrganizationName, &item.CreatedAt, &item.LastActiveAt, &item.IdleExpiresAt, &item.ExpiresAt, &item.UserAgentHint, &item.Current)
			item.CreatedAt, item.LastActiveAt = item.CreatedAt.UTC(), item.LastActiveAt.UTC()
			item.IdleExpiresAt, item.ExpiresAt = item.IdleExpiresAt.UTC(), item.ExpiresAt.UTC()
			return item, err
		})
		if err != nil {
			return err
		}
		if _, err := a.store.revalidateBrowserCaller(ctx, tx, access.Caller); err != nil {
			return err
		}
		if len(items) > input.Limit {
			items = items[:input.Limit]
			page.NextAfterID = items[len(items)-1].ID
		}
		now := a.store.browserAdmissionTime(time.Time{})
		for _, item := range items {
			if item.ExpiresAt.After(now) && item.IdleExpiresAt.After(now) {
				page.Sessions = append(page.Sessions, item)
			}
		}
		return nil
	})
	if err != nil {
		return browsersessions.Page{}, err
	}
	return page, nil
}

func (a *BrowserSessionsAdapter) Revoke(ctx context.Context, access browsersessions.Access, input browsersessions.RevokeInput) (browsersessions.RevokeResult, error) {
	var result browsersessions.RevokeResult
	err := a.store.inTransaction(ctx, func(tx *databaseTransaction) error {
		var userID string
		if err := tx.QueryRow(ctx, `SELECT id FROM users WHERE id = $1 FOR UPDATE`, access.UserID).Scan(&userID); err != nil {
			return err
		}
		ids, err := lockBrowserSessionIDs(ctx, tx, userID)
		if err != nil {
			return err
		}
		live, err := a.store.authorizeBrowserAccess(ctx, tx, access)
		if err != nil {
			return err
		}
		organizationID, exceptID := "", ""
		if access.Scope == "organization" {
			organizationID = live.Principal.OrganizationID
		}
		if input.Mode == "others" {
			exceptID = live.ID
		}
		now := a.store.browserAdmissionTime(time.Time{})
		events, err := revokeLockedBrowserSessions(ctx, tx, ids, organizationID, "", exceptID, "session_revoked", now)
		if err != nil {
			return err
		}
		result.RevokedCount = len(events)
		for _, value := range events {
			result.CurrentRevoked = result.CurrentRevoked || value.TokenID == live.ID
		}
		if len(events) == 0 {
			return nil
		}
		if err := a.store.appendEvent(ctx, tx, event{OrganizationID: live.Principal.OrganizationID, ActorPrincipalID: live.Principal.UserID, Type: "browser_sessions.revoked", SubjectType: "user", SubjectID: userID, RequestID: input.RequestID, CreatedAt: now, Metadata: map[string]any{"scope": access.Scope, "mode": input.Mode, "revoked_count": result.RevokedCount}}); err != nil {
			return err
		}
		return appendSessionRevocations(ctx, tx, events)
	})
	if err != nil {
		return browsersessions.RevokeResult{}, fmt.Errorf("revoke browser sessions: %w", err)
	}
	return result, nil
}
