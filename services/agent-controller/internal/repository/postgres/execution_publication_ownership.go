package postgres

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/tf4fun/antnest-platform/services/agent-controller/internal/ports"
)

// Publication ownership is separate from the short-lived mutation locks.
const executionPublicationLockNamespace int32 = 0x41505542

func (repository *Repository) WithExecutionPublication(ctx context.Context, organizationID string, callback func(context.Context) error) (resultErr error) {
	if err := ctx.Err(); err != nil {
		return err
	}
	if organizationID == "" || callback == nil {
		return ports.ErrInvalidExecutionConfiguration
	}
	// The lock session owns no ordinary pool connection or transaction while
	// the callback reads, decrypts, publishes over HTTP and records the receipt.
	configuration := repository.pool.Config().ConnConfig.Copy()
	connection, err := pgx.ConnectConfig(ctx, configuration)
	if err != nil {
		if canceled := ctx.Err(); canceled != nil {
			return canceled
		}
		return fmt.Errorf("connect execution publication ownership: %w", err)
	}
	locked := false
	defer func() {
		cleanup, cancel := context.WithTimeout(context.WithoutCancel(ctx), 5*time.Second)
		defer cancel()
		if locked {
			var unlocked bool
			if err := connection.QueryRow(cleanup, `SELECT pg_advisory_unlock($1, hashtext($2))`, executionPublicationLockNamespace, organizationID).Scan(&unlocked); err != nil {
				resultErr = errors.Join(resultErr, fmt.Errorf("release execution publication ownership: %w", err))
			} else if !unlocked {
				resultErr = errors.Join(resultErr, errors.New("execution publication ownership was not held by its session"))
			}
		}
		// A failed lock receipt may still have acquired ownership. Always close
		// the private session rather than returning unknown locks to a pool.
		if err := connection.Close(cleanup); err != nil {
			resultErr = errors.Join(resultErr, fmt.Errorf("close execution publication ownership session: %w", err))
		}
		// Cancellation can mark a pgx connection closed before its underlying
		// session cleanup finishes. Join that work within the cleanup budget.
		select {
		case <-connection.PgConn().CleanupDone():
		case <-cleanup.Done():
			resultErr = errors.Join(resultErr, fmt.Errorf("join execution publication ownership cleanup: %w", cleanup.Err()))
		}
	}()
	if _, err := connection.Exec(ctx, `SELECT pg_advisory_lock($1, hashtext($2))`, executionPublicationLockNamespace, organizationID); err != nil {
		if canceled := ctx.Err(); canceled != nil {
			return canceled
		}
		return fmt.Errorf("acquire execution publication ownership: %w", err)
	}
	locked = true
	if err := ctx.Err(); err != nil {
		return err
	}
	if err := callback(ctx); err != nil {
		return err
	}
	return ctx.Err()
}
