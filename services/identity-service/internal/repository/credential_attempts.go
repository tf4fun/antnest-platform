package repository

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/tf4fun/antnest-platform/services/identity-service/internal/domain"
)

type credentialAttemptAdmission struct {
	keys   [2]credentialAttemptKey
	states [2]credentialAttemptState
}

func lockCredentialAttempts(ctx context.Context, tx *databaseTransaction, wait *credentialWaitBudget, keys [2]credentialAttemptKey) (*credentialAttemptAdmission, error) {
	if keys[0].scope != organizationAttemptScope || (keys[1].scope != loginAttemptScope && keys[1].scope != passwordChangeAttemptScope) {
		return nil, fmt.Errorf("credential attempt locks require Organization before account or User")
	}
	admission := &credentialAttemptAdmission{keys: keys}
	if err := admission.lockBucket(ctx, tx, wait, 0); err != nil {
		return nil, err
	}
	now, err := credentialDatabaseNow(ctx, tx, wait)
	if err != nil {
		return nil, err
	}
	if admission.states[0].remaining(now) > 0 {
		// A blocked Organization cannot create one row per rejected email.
		// An existing account may have a longer lock; retain the same lock order
		// and wait budget when looking it up without inserting a new bucket.
		err := wait.wait(ctx, func(bounded context.Context) error {
			state := &admission.states[1]
			return tx.QueryRow(bounded, `SELECT window_start,failures,locked_until
				FROM credential_attempts WHERE scope=$1 AND key_hash=$2 FOR UPDATE`,
				string(keys[1].scope), keys[1].digest[:]).Scan(&state.windowStart, &state.failures, &state.lockedUntil)
		})
		found := err == nil
		if err != nil && !errors.Is(err, pgx.ErrNoRows) {
			return nil, fmt.Errorf("lock existing credential attempt: %w", err)
		}
		now, err = credentialDatabaseNow(ctx, tx, wait)
		if err != nil {
			return nil, err
		}
		if remaining := admission.remaining(now); remaining > 0 {
			return nil, domain.CredentialRateLimited(remaining)
		}
		if found {
			admission.normalize(now)
			return admission, nil
		}
		// Both locks may expire during the bounded wait. Normal admission is
		// allowed now, still using the original allowance and transaction.
	}
	if err := admission.lockBucket(ctx, tx, wait, 1); err != nil {
		return nil, err
	}
	now, err = credentialDatabaseNow(ctx, tx, wait)
	if err != nil {
		return nil, err
	}
	if remaining := admission.remaining(now); remaining > 0 {
		return nil, domain.CredentialRateLimited(remaining)
	}
	admission.normalize(now)
	return admission, nil
}

func (admission *credentialAttemptAdmission) lockBucket(ctx context.Context, tx *databaseTransaction, wait *credentialWaitBudget, index int) error {
	key, state := admission.keys[index], &admission.states[index]
	err := wait.wait(ctx, func(bounded context.Context) error {
		// A single upsert locks or creates the bucket. INSERT DO NOTHING followed
		// by SELECT would let cleanup delete the row between the two statements.
		return tx.QueryRow(bounded, `INSERT INTO credential_attempts (scope,key_hash,window_start,failures)
			VALUES ($1,$2,clock_timestamp(),0)
			ON CONFLICT (scope,key_hash) DO UPDATE SET scope=EXCLUDED.scope
			RETURNING window_start,failures,locked_until`, string(key.scope), key.digest[:]).
			Scan(&state.windowStart, &state.failures, &state.lockedUntil)
	})
	if err != nil {
		return fmt.Errorf("lock credential attempt bucket: %w", err)
	}
	return nil
}

func (admission *credentialAttemptAdmission) remaining(now time.Time) time.Duration {
	return max(admission.states[0].remaining(now), admission.states[1].remaining(now))
}

func (admission *credentialAttemptAdmission) normalize(now time.Time) {
	for index, state := range admission.states {
		admission.states[index] = state.forAdmission(now)
	}
}

func credentialDatabaseNow(ctx context.Context, tx *databaseTransaction, wait *credentialWaitBudget) (time.Time, error) {
	var now time.Time
	err := wait.wait(ctx, func(bounded context.Context) error {
		return tx.QueryRow(bounded, "SELECT clock_timestamp()").Scan(&now)
	})
	if err != nil {
		return time.Time{}, fmt.Errorf("read credential admission clock: %w", err)
	}
	return now.UTC(), nil
}

func (admission *credentialAttemptAdmission) recordFailure(ctx context.Context, tx *databaseTransaction, wait *credentialWaitBudget) error {
	now, err := credentialDatabaseNow(ctx, tx, wait)
	if err != nil {
		return err
	}
	for index, state := range admission.states {
		if err := admission.writeState(ctx, tx, wait, index, state.withFailure(admission.keys[index].scope, now)); err != nil {
			return err
		}
	}
	return nil
}

func (admission *credentialAttemptAdmission) resetAccount(ctx context.Context, tx *databaseTransaction, wait *credentialWaitBudget) error {
	now, err := credentialDatabaseNow(ctx, tx, wait)
	if err != nil {
		return err
	}
	return admission.writeState(ctx, tx, wait, 1, credentialAttemptState{windowStart: now})
}

func (admission *credentialAttemptAdmission) writeState(ctx context.Context, tx *databaseTransaction, wait *credentialWaitBudget, index int, state credentialAttemptState) error {
	key := admission.keys[index]
	err := wait.wait(ctx, func(bounded context.Context) error {
		result, err := tx.Exec(bounded, `UPDATE credential_attempts SET window_start=$3,failures=$4,locked_until=$5
			WHERE scope=$1 AND key_hash=$2`, string(key.scope), key.digest[:], state.windowStart, state.failures, state.lockedUntil)
		if err != nil {
			return err
		}
		if result.RowsAffected() != 1 {
			return fmt.Errorf("locked credential attempt bucket disappeared")
		}
		return nil
	})
	if err != nil {
		return fmt.Errorf("record credential attempt outcome: %w", err)
	}
	admission.states[index] = state
	return nil
}

// CleanupCredentialAttempts removes one bounded batch. The process maintenance
// owner schedules calls; admission holds row locks through its outcome commit.
func (s *Store) CleanupCredentialAttempts(ctx context.Context) (int64, error) {
	var removed int64
	err := s.inCredentialTransaction(ctx, func(tx *databaseTransaction, wait *credentialWaitBudget) error {
		return wait.wait(ctx, func(bounded context.Context) error {
			result, err := tx.Exec(bounded, `WITH expired AS (
				SELECT scope,key_hash FROM credential_attempts
				WHERE window_start <= clock_timestamp()-interval '15 minutes'
				  AND (locked_until IS NULL OR locked_until <= clock_timestamp())
				ORDER BY window_start,scope,key_hash LIMIT 500 FOR UPDATE SKIP LOCKED
			) DELETE FROM credential_attempts a USING expired e WHERE a.scope=e.scope AND a.key_hash=e.key_hash`)
			if err == nil {
				removed = result.RowsAffected()
			}
			return err
		})
	})
	if err != nil {
		return 0, fmt.Errorf("cleanup credential attempts: %w", err)
	}
	return removed, nil
}
