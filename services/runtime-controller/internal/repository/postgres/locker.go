package postgres

import (
	"context"
	"database/sql"
	"database/sql/driver"
	"errors"
	"fmt"
	"strings"
	"time"

	"soft/antnest-platform/services/runtime-controller/internal/repository"
)

const lockRetryInterval = 50 * time.Millisecond

const agentMutationLockNamespace int32 = 0x414e5401

func (r *Repository) WithAgentLock(
	ctx context.Context, agentID string, execute func(context.Context) error,
) (resultErr error) {
	if strings.TrimSpace(agentID) == "" || execute == nil {
		return fmt.Errorf("agent ID and locked operation are required")
	}
	connection, err := r.lockDatabase.Conn(ctx)
	if err != nil {
		return fmt.Errorf("reserve Agent lock connection: %w", err)
	}
	locked := false
	discard := false
	defer func() {
		if locked {
			unlockCtx := context.WithoutCancel(ctx)
			if deadline, ok := ctx.Deadline(); ok && time.Until(deadline) > 0 {
				var cancel context.CancelFunc
				unlockCtx, cancel = context.WithDeadline(unlockCtx, deadline)
				defer cancel()
			} else if ctx.Err() != nil {
				discard = true
			}
			if !discard {
				unlockErr := releaseAgentLock(unlockCtx, connection, agentID)
				if unlockErr != nil {
					discard = true
					resultErr = errors.Join(resultErr, repository.ErrLockLost, unlockErr)
				}
			}
		}
		if discard {
			resultErr = errors.Join(resultErr, discardConnection(connection))
		}
		closeErr := connection.Close()
		if errors.Is(closeErr, sql.ErrConnDone) {
			closeErr = nil
		}
		resultErr = errors.Join(resultErr, closeErr)
	}()
	for !locked {
		if err := connection.QueryRowContext(ctx,
			"SELECT pg_try_advisory_lock($1, hashtext($2))", agentMutationLockNamespace, agentID,
		).Scan(&locked); err != nil {
			discard = true
			return fmt.Errorf("acquire Agent mutation lock: %w", err)
		}
		if !locked {
			timer := time.NewTimer(lockRetryInterval)
			select {
			case <-ctx.Done():
				timer.Stop()
				return fmt.Errorf("acquire Agent mutation lock: %w", ctx.Err())
			case <-timer.C:
			}
		}
	}
	resultErr = executeWithAgentLockMonitor(ctx, connection, r.mutationProbeInterval, execute)
	if errors.Is(resultErr, repository.ErrLockLost) {
		discard = true
	}
	return resultErr
}

func executeWithAgentLockMonitor(
	ctx context.Context,
	connection *sql.Conn,
	probeInterval time.Duration,
	execute func(context.Context) error,
) (resultErr error) {
	monitorCtx, stopMonitor := context.WithCancel(ctx)
	executionCtx, cancelExecution := context.WithCancelCause(ctx)
	monitorDone := make(chan struct{})
	leaseLost := make(chan error, 1)
	go monitorAgentLockSession(
		monitorCtx, connection, probeInterval, cancelExecution, leaseLost, monitorDone,
	)
	defer func() {
		stopMonitor()
		<-monitorDone
		cancelExecution(nil)
		select {
		case err := <-leaseLost:
			resultErr = errors.Join(resultErr, repository.ErrLockLost, err)
		default:
		}
	}()
	return execute(executionCtx)
}

func monitorAgentLockSession(
	ctx context.Context,
	connection *sql.Conn,
	probeInterval time.Duration,
	cancelExecution context.CancelCauseFunc,
	leaseLost chan<- error,
	done chan<- struct{},
) {
	defer close(done)
	if probeInterval <= 0 {
		probeInterval = time.Second
	}
	ticker := time.NewTicker(probeInterval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			probeCtx, cancel := context.WithTimeout(ctx, probeInterval)
			var value int
			err := connection.QueryRowContext(probeCtx, "SELECT 1").Scan(&value)
			cancel()
			if err == nil && value == 1 {
				continue
			}
			if ctx.Err() != nil {
				return
			}
			if err == nil {
				err = fmt.Errorf("agent mutation lock probe returned unexpected value")
			}
			err = fmt.Errorf("agent mutation lock session lost: %w", err)
			leaseLost <- err
			cancelExecution(errors.Join(repository.ErrLockLost, err))
			return
		}
	}
}

func releaseAgentLock(ctx context.Context, connection *sql.Conn, agentID string) error {
	var unlocked bool
	err := connection.QueryRowContext(ctx,
		"SELECT pg_advisory_unlock($1, hashtext($2))", agentMutationLockNamespace, agentID,
	).Scan(&unlocked)
	if err != nil || !unlocked {
		return errors.Join(err, fmt.Errorf("agent mutation lock was not released"))
	}
	return nil
}

func discardConnection(connection *sql.Conn) error {
	err := connection.Raw(func(any) error { return driver.ErrBadConn })
	if errors.Is(err, driver.ErrBadConn) {
		return nil
	}
	return err
}
