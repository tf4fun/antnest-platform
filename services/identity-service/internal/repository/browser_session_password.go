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

func (a *BrowserSessionsAdapter) ChangePassword(ctx context.Context, attempt browsersessions.PasswordAttempt, prepare browsersessions.PreparePassword) (browsersessions.PasswordOutcome, error) {
	if prepare == nil {
		return browsersessions.PasswordOutcome{}, fmt.Errorf("browser password change requires credential preparation")
	}
	var outcome browsersessions.PasswordOutcome
	var live callercontext.Session
	var checkedAt time.Time
	checkFrozen := func() error {
		if err := ctx.Err(); err != nil {
			return err
		}
		// Preserve the original signed CCT and the locked live deadlines after
		// our own revocation, including while waiting for commit acknowledgement.
		if _, err := attempt.Caller.Revalidate(ctx, func(context.Context, string, time.Time) (callercontext.Session, error) {
			return live, nil
		}); err != nil {
			return err
		}
		checkedAt = a.store.browserAdmissionTime(checkedAt)
		if !live.ExpiresAt.After(checkedAt) || !live.IdleExpiresAt.After(checkedAt) || outcome.Changed &&
			(!outcome.Result.ExpiresAt.After(checkedAt) || !outcome.Result.IdleExpiresAt.After(checkedAt)) {
			return callercontext.ErrInvalid
		}
		return nil
	}
	err := a.store.inCredentialTransaction(ctx, func(tx *databaseTransaction, wait *credentialWaitBudget) error {
		checkCaller := func() error {
			// Wrap the entire revalidation: Caller maps resolver storage failures
			// to dependency errors, but database admission busy must survive.
			return wait.wait(ctx, func(bounded context.Context) error {
				var err error
				live, err = a.store.revalidateBrowserCaller(bounded, tx, attempt.Caller)
				return err
			})
		}
		if err := checkCaller(); err != nil {
			return err
		}
		claims := attempt.Caller.Claims()
		keys, err := passwordChangeAttemptKeys(claims.Organization, claims.Subject)
		if err != nil {
			return err
		}
		admission, err := lockCredentialAttempts(ctx, tx, wait, keys)
		if err != nil {
			var limited *domain.CredentialRateLimitError
			if errors.As(err, &limited) {
				if callerErr := checkCaller(); callerErr != nil {
					return callerErr
				}
			}
			return err
		}
		if err := checkCaller(); err != nil {
			return err
		}
		credential, err := lockBrowserPasswordCredential(ctx, tx, wait, attempt.Caller, checkCaller)
		if err != nil {
			return err
		}
		prepared, err := prepare(ctx, credential, checkCaller)
		if err != nil {
			return err
		}
		var ids []string
		if err := wait.wait(ctx, func(bounded context.Context) error {
			var err error
			ids, err = lockBrowserSessionIDs(bounded, tx, claims.Subject)
			return err
		}); err != nil {
			return err
		}
		// Logout can commit during KDF work. Both outcomes take the SID locks
		// and revalidate before they can mutate durable state.
		if err := checkCaller(); err != nil {
			return err
		}
		if !prepared.Matched {
			if err := admission.recordFailure(ctx, tx, wait); err != nil {
				return err
			}
			return checkCaller()
		}
		if prepared.ExpectedPasswordHash != credential.PasswordHash || prepared.PasswordHash == "" {
			return domain.ErrConflict
		}
		if err := wait.wait(ctx, func(bounded context.Context) error {
			var err error
			outcome.Result, err = a.rotateBrowserPassword(bounded, tx, attempt, prepared, live, ids)
			return err
		}); err != nil {
			return err
		}
		if err := admission.resetAccount(ctx, tx, wait); err != nil {
			return err
		}
		outcome.Changed = true
		return checkFrozen()
	})
	if err != nil {
		// An ambiguous commit never exposes credentials or replays the attempt.
		return browsersessions.PasswordOutcome{}, fmt.Errorf("rotate browser password: %w", err)
	}
	// ACK may arrive after expiry. Withhold the result without compensating
	// a committed rotation or failed guess.
	if err := checkFrozen(); err != nil {
		return browsersessions.PasswordOutcome{}, err
	}
	return outcome, nil
}

func lockBrowserPasswordCredential(ctx context.Context, tx *databaseTransaction, wait *credentialWaitBudget, caller *callercontext.Caller, recheck func() error) (domain.LocalCredential, error) {
	claims := caller.Claims()
	// Buckets precede User -> Organization -> Membership -> credential. Take
	// credential update intent on its first locking read, before sorted SIDs.
	for _, lock := range []struct {
		query string
		args  []any
	}{
		{`SELECT id FROM users WHERE id = $1 AND active FOR UPDATE`, []any{claims.Subject}},
		{`SELECT id FROM organizations WHERE id = $1 AND active FOR SHARE`, []any{claims.Organization}},
		{`SELECT id FROM organization_memberships WHERE id = $1 AND user_id=$2 AND organization_id=$3 AND active AND scim_deleted_at IS NULL FOR SHARE`, []any{claims.Membership, claims.Subject, claims.Organization}},
	} {
		var id string
		err := wait.wait(ctx, func(bounded context.Context) error {
			return tx.QueryRow(bounded, lock.query, lock.args...).Scan(&id)
		})
		if errors.Is(err, pgx.ErrNoRows) && !errors.Is(err, domain.ErrCredentialBusy) {
			return domain.LocalCredential{}, callercontext.ErrInvalid
		}
		if err != nil {
			return domain.LocalCredential{}, err
		}
		if err := recheck(); err != nil {
			return domain.LocalCredential{}, err
		}
	}
	credential := domain.LocalCredential{UserID: claims.Subject}
	err := wait.wait(ctx, func(bounded context.Context) error {
		return tx.QueryRow(bounded, `SELECT password_hash FROM local_credentials WHERE user_id=$1 FOR UPDATE`, claims.Subject).Scan(&credential.PasswordHash)
	})
	if errors.Is(err, pgx.ErrNoRows) && !errors.Is(err, domain.ErrCredentialBusy) {
		if err := recheck(); err != nil {
			return domain.LocalCredential{}, err
		}
		return domain.LocalCredential{}, domain.InvalidArgument("Local password is not available for this account")
	}
	if err != nil {
		return domain.LocalCredential{}, err
	}
	if err := recheck(); err != nil {
		return domain.LocalCredential{}, err
	}
	return credential, nil
}
