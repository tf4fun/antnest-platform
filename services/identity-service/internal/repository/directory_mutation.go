package repository

import (
	"context"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/tf4fun/antnest-platform/services/identity-service/internal/callercontext"
	"github.com/tf4fun/antnest-platform/services/identity-service/internal/domain"
)

type directoryMutationAdmission struct {
	caller  *callercontext.Caller
	session callercontext.Session
}

// User/Organization/Membership and affected SCIM Token locks precede this call.
// Take the caller and target browser-session union once, in its final mode.
// Return only target IDs: a global target revocation must not revoke its actor.
func (s *Store) admitDirectoryMutation(ctx context.Context, tx *databaseTransaction, actorID, organizationID, targetUserID string, revokeTargets bool) (directoryMutationAdmission, []string, error) {
	var admission directoryMutationAdmission
	caller, err := callercontext.OptionalCallerFromContext(ctx)
	if err != nil {
		return admission, nil, err
	}
	callerSID := ""
	if caller != nil {
		callerSID = caller.Claims().Session
	}
	rows, err := tx.Query(ctx, `SELECT id, user_id=$1 AND revoked_at IS NULL AND $3 FROM api_tokens
		WHERE kind='browser' AND ((user_id=$1 AND revoked_at IS NULL AND $3) OR id=$2)
		ORDER BY id FOR UPDATE`, targetUserID, callerSID, revokeTargets)
	if err != nil {
		return admission, nil, err
	}
	type lockedSession struct {
		id     string
		revoke bool
	}
	sessions, err := pgx.CollectRows(rows, func(row pgx.CollectableRow) (lockedSession, error) {
		var session lockedSession
		err := row.Scan(&session.id, &session.revoke)
		return session, err
	})
	if err != nil {
		return admission, nil, err
	}
	var targetIDs []string
	for _, session := range sessions {
		if session.revoke {
			targetIDs = append(targetIDs, session.id)
		}
	}
	if caller == nil {
		// Trusted internal calls retain their existing no-browser-context path.
		return admission, targetIDs, nil
	}
	live, err := s.revalidateBrowserCaller(ctx, tx, caller)
	if err != nil {
		return admission, nil, err
	}
	if live.Principal.UserID != actorID || organizationID != "" && live.Principal.OrganizationID != organizationID {
		return admission, nil, callercontext.ErrInvalid
	}
	return directoryMutationAdmission{caller: caller, session: live}, targetIDs, nil
}

// Run after every audit and principal/session feed write. Intentional self
// demotion/deactivation may revoke the caller here, but cannot extend either
// original session deadline or the signed CCT's validity window.
func (s *Store) finishDirectoryMutation(ctx context.Context, tx *databaseTransaction, admission directoryMutationAdmission, sessionEvents []domain.SessionRevocation) error {
	if admission.caller == nil {
		return nil
	}
	for _, event := range sessionEvents {
		if event.TokenID == admission.session.ID {
			_, err := admission.caller.Revalidate(ctx, func(context.Context, string, time.Time) (callercontext.Session, error) {
				return admission.session, nil
			})
			return err
		}
	}
	_, err := s.revalidateBrowserCaller(ctx, tx, admission.caller)
	return err
}
