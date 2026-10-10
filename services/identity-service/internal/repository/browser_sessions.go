package repository

import (
	"context"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
)

func browserActivityInterval(idleTTL time.Duration) int {
	return int(max(int64(1), min(int64(30000), idleTTL.Milliseconds()/3)))
}

func (s *Store) browserIdlePolicy() time.Duration {
	return time.Duration(s.browserIdleTTL.Load())
}

// A database read or lock wait cannot preserve an earlier authority deadline.
// Also retain a later observation supplied by the caller if the clock moves back.
func (s *Store) browserAdmissionTime(observed time.Time) time.Time {
	now := s.now().UTC()
	if observed.After(now) {
		return observed
	}
	return now
}

// InitializeBrowserSessions runs before the listener opens. A failed database
// transaction must not publish a policy that existing rows have not admitted.
// A successfully initialized Store has an immutable policy for its lifetime.
func (s *Store) InitializeBrowserSessions(ctx context.Context, idleTTL time.Duration) error {
	if idleTTL <= 0 {
		return fmt.Errorf("browser session idle TTL must be positive")
	}
	s.browserInitialization.Lock()
	defer s.browserInitialization.Unlock()
	if s.browserPolicyInitialized {
		if s.browserIdlePolicy() != idleTTL {
			return fmt.Errorf("browser session idle policy is already initialized")
		}
		return nil
	}
	if err := s.inTransaction(ctx, func(tx *databaseTransaction) error {
		ids, err := lockBrowserSessionIDs(ctx, tx, "")
		if err != nil {
			return err
		}
		if len(ids) == 0 {
			return nil
		}
		_, err = tx.Exec(ctx, `
			UPDATE api_tokens
			SET idle_expires_at = LEAST(idle_expires_at, expires_at, last_used_at + $2::interval)
			WHERE id = ANY($1::text[])`, ids, pgtype.Interval{Microseconds: idleTTL.Microseconds(), Valid: true})
		return err
	}); err != nil {
		return fmt.Errorf("initialize browser session idle policy: %w", err)
	}
	// Data-plane reads never take a configuration mutex while holding database
	// locks. Publish only after commit; main admits traffic only after this call.
	s.browserIdleTTL.Store(int64(idleTTL))
	s.browserPolicyInitialized = true
	return nil
}

// Every bulk browser-session mutation acquires rows in this order before
// updating them. Only the locked IDs may be changed by the subsequent UPDATE.
// The empty user selects all users for the startup policy clamp.
func lockBrowserSessionIDs(ctx context.Context, tx *databaseTransaction, userID string) ([]string, error) {
	rows, err := tx.Query(ctx, `
		SELECT id FROM api_tokens
		WHERE kind = 'browser' AND revoked_at IS NULL AND ($1 = '' OR user_id = $1)
		ORDER BY id FOR UPDATE`, userID)
	if err != nil {
		return nil, err
	}
	return pgx.CollectRows(rows, pgx.RowTo[string])
}
