package repository

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/tf4fun/antnest-platform/services/identity-service/internal/domain"
)

// One transaction shares one database admission allowance. Charge pool and SQL
// waits cumulatively; KDF work runs separately with the original request context.
type credentialWaitBudget struct {
	remaining time.Duration
}

func (budget *credentialWaitBudget) wait(ctx context.Context, operation func(context.Context) error) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	if budget.remaining <= 0 {
		return domain.ErrCredentialBusy
	}
	bounded, cancel := context.WithTimeout(ctx, budget.remaining)
	defer cancel()
	started := time.Now()
	err := operation(bounded)
	budget.remaining -= time.Since(started)
	if original := ctx.Err(); original != nil {
		return original
	}
	if bounded.Err() != nil || budget.remaining <= 0 {
		// An expired admission cannot retain credit from time spent creating
		// its deadline before the operation timer started.
		budget.remaining = 0
		return domain.WithCause(domain.ErrCredentialBusy, err)
	}
	return err
}

func (s *Store) inCredentialTransaction(ctx context.Context, operation func(*databaseTransaction, *credentialWaitBudget) error) error {
	wait := &credentialWaitBudget{remaining: 2 * time.Second}
	var tx *databaseTransaction
	err := wait.wait(ctx, func(bounded context.Context) error {
		var err error
		tx, err = s.pool.BeginTx(bounded, pgx.TxOptions{})
		return err
	})
	if tx != nil {
		defer func() {
			cleanup, cancel := context.WithTimeout(context.WithoutCancel(ctx), 5*time.Second)
			defer cancel()
			_ = tx.Rollback(cleanup)
		}()
	}
	if err != nil {
		return fmt.Errorf("begin credential transaction: %w", err)
	}
	if err := operation(tx, wait); err != nil {
		// The storage cause is private once admission has classified a timeout.
		// Generic normalization must not turn it back into not_found/conflict.
		if errors.Is(err, domain.ErrCredentialBusy) {
			return err
		}
		return normalizeError(err)
	}
	// A failed or ambiguous commit is an operation error, never a confirmed
	// password rejection. Do not retry the transaction or compensate counters.
	if err := tx.Commit(ctx); err != nil {
		return normalizeError(fmt.Errorf("commit credential transaction: %w", err))
	}
	return nil
}
