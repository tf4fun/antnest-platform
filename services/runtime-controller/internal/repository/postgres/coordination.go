package postgres

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"sync"
	"time"

	"github.com/tf4fun/antnest-platform/services/runtime-controller/internal/repository"
)

const (
	observationLeadershipNamespace int32 = 0x414e5402
	observationLeadershipKey       int32 = 1
	observationReadyKey            int32 = 2
)

type observationLeadership struct {
	connection  *sql.Conn
	cancel      context.CancelFunc
	done        chan struct{}
	workerDone  chan struct{}
	doneOnce    sync.Once
	releaseOnce sync.Once
	mu          sync.RWMutex
	lost        bool
	ready       bool
	err         error
}

func (r *Repository) TryAcquireObservationLeadership(
	ctx context.Context,
) (repository.Leadership, bool, error) {
	connection, err := r.lockDatabase.Conn(ctx)
	if err != nil {
		return nil, false, fmt.Errorf("reserve observation leadership connection: %w", err)
	}
	var acquired bool
	if err := connection.QueryRowContext(ctx,
		"SELECT pg_try_advisory_lock($1, $2)",
		observationLeadershipNamespace, observationLeadershipKey,
	).Scan(&acquired); err != nil {
		_ = discardConnection(connection)
		_ = connection.Close()
		return nil, false, fmt.Errorf("try observation monitor leadership: %w", err)
	}
	if !acquired {
		if err := connection.Close(); err != nil && !errors.Is(err, sql.ErrConnDone) {
			return nil, false, fmt.Errorf("release observation leadership probe connection: %w", err)
		}
		return nil, false, nil
	}
	return newObservationLeadership(connection, r.leadershipProbeInterval), true, nil
}

func newObservationLeadership(connection *sql.Conn, probeInterval time.Duration) *observationLeadership {
	ctx, cancel := context.WithCancel(context.Background())
	leadership := &observationLeadership{
		connection: connection, cancel: cancel, done: make(chan struct{}), workerDone: make(chan struct{}),
	}
	go leadership.monitor(ctx, probeInterval)
	return leadership
}

func (l *observationLeadership) Done() <-chan struct{} { return l.done }

func (l *observationLeadership) Err() error {
	l.mu.RLock()
	defer l.mu.RUnlock()
	return l.err
}

func (l *observationLeadership) MarkObservationReady(ctx context.Context) error {
	l.mu.RLock()
	ready, lost := l.ready, l.lost
	l.mu.RUnlock()
	if lost {
		return fmt.Errorf("mark observation monitor ready: leadership session is lost")
	}
	if ready {
		return nil
	}
	var acquired bool
	if err := l.connection.QueryRowContext(ctx,
		"SELECT pg_try_advisory_lock($1, $2)",
		observationLeadershipNamespace, observationReadyKey,
	).Scan(&acquired); err != nil {
		return fmt.Errorf("mark observation monitor ready: %w", err)
	}
	if !acquired {
		return fmt.Errorf("mark observation monitor ready: readiness lock is already held")
	}
	l.mu.Lock()
	l.ready = true
	l.mu.Unlock()
	return nil
}

func (l *observationLeadership) MarkObservationUnready(ctx context.Context) error {
	l.mu.RLock()
	ready, lost := l.ready, l.lost
	l.mu.RUnlock()
	if !ready || lost {
		return nil
	}
	var unlocked bool
	if err := l.connection.QueryRowContext(ctx,
		"SELECT pg_advisory_unlock($1, $2)",
		observationLeadershipNamespace, observationReadyKey,
	).Scan(&unlocked); err != nil {
		return fmt.Errorf("mark observation monitor unready: %w", err)
	}
	if !unlocked {
		return fmt.Errorf("mark observation monitor unready: readiness lock was not held")
	}
	l.mu.Lock()
	l.ready = false
	l.mu.Unlock()
	return nil
}

func (r *Repository) ObservationMonitorReady(ctx context.Context) (ready bool, resultErr error) {
	connection, err := r.lockDatabase.Conn(ctx)
	if err != nil {
		return false, fmt.Errorf("reserve observation readiness probe connection: %w", err)
	}
	defer joinCloseError(&resultErr, "observation readiness probe connection", connection.Close)
	var acquired bool
	if err := connection.QueryRowContext(ctx,
		"SELECT pg_try_advisory_lock($1, $2)",
		observationLeadershipNamespace, observationReadyKey,
	).Scan(&acquired); err != nil {
		return false, fmt.Errorf("probe observation monitor readiness: %w", err)
	}
	if !acquired {
		return true, nil
	}
	var unlocked bool
	if err := connection.QueryRowContext(ctx,
		"SELECT pg_advisory_unlock($1, $2)",
		observationLeadershipNamespace, observationReadyKey,
	).Scan(&unlocked); err != nil {
		return false, fmt.Errorf("release observation readiness probe: %w", err)
	}
	if !unlocked {
		return false, fmt.Errorf("release observation readiness probe: lock was not held")
	}
	return false, nil
}

func (l *observationLeadership) monitor(ctx context.Context, probeInterval time.Duration) {
	defer close(l.workerDone)
	ticker := time.NewTicker(probeInterval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			probeCtx, cancel := context.WithTimeout(ctx, probeInterval)
			var value int
			err := l.connection.QueryRowContext(probeCtx, "SELECT 1").Scan(&value)
			cancel()
			if err == nil && value == 1 {
				continue
			}
			if ctx.Err() != nil {
				return
			}
			if err == nil {
				err = fmt.Errorf("observation leadership probe returned unexpected value")
			}
			l.markLost(fmt.Errorf("observation leadership session lost: %w", err))
			return
		}
	}
}

func (l *observationLeadership) markLost(err error) {
	discardErr := discardConnection(l.connection)
	closeErr := l.connection.Close()
	if errors.Is(closeErr, sql.ErrConnDone) {
		closeErr = nil
	}
	l.mu.Lock()
	l.lost = true
	l.err = errors.Join(err, discardErr, closeErr)
	l.mu.Unlock()
	l.doneOnce.Do(func() { close(l.done) })
}

func (l *observationLeadership) Release(ctx context.Context) error {
	l.releaseOnce.Do(func() {
		l.cancel()
		<-l.workerDone
		l.mu.RLock()
		lost := l.lost
		l.mu.RUnlock()
		if lost {
			l.doneOnce.Do(func() { close(l.done) })
			return
		}
		unreadyErr := l.MarkObservationUnready(ctx)
		var unlocked bool
		unlockErr := l.connection.QueryRowContext(ctx,
			"SELECT pg_advisory_unlock($1, $2)",
			observationLeadershipNamespace, observationLeadershipKey,
		).Scan(&unlocked)
		resultErr := unreadyErr
		if unlockErr != nil || !unlocked {
			resultErr = errors.Join(unlockErr, fmt.Errorf("observation monitor leadership was not released"))
			resultErr = errors.Join(resultErr, discardConnection(l.connection))
		}
		closeErr := l.connection.Close()
		if errors.Is(closeErr, sql.ErrConnDone) {
			closeErr = nil
		}
		l.mu.Lock()
		l.err = errors.Join(resultErr, closeErr)
		l.mu.Unlock()
		l.doneOnce.Do(func() { close(l.done) })
	})
	return l.Err()
}

func (r *Repository) ListenObservationNotifications(
	ctx context.Context, ready func(), notify func(string),
) (resultErr error) {
	if ready == nil || notify == nil {
		return fmt.Errorf("observation notification callbacks are required")
	}
	connection, err := r.database.Conn(ctx)
	if err != nil {
		return fmt.Errorf("reserve observation notification connection: %w", err)
	}
	defer joinCloseError(&resultErr, "observation notification connection", connection.Close)
	return connection.Raw(func(raw any) error {
		stdlibConnection, ok := raw.(*transactionConnection)
		if !ok {
			return fmt.Errorf("observation notification requires the pgx database driver")
		}
		postgresConnection := stdlibConnection.Conn.Conn()
		if _, err := postgresConnection.Exec(ctx, "LISTEN runtime_controller_observation"); err != nil {
			return fmt.Errorf("listen for Runtime observations: %w", err)
		}
		ready()
		for {
			notification, err := postgresConnection.WaitForNotification(ctx)
			if err != nil {
				if errors.Is(err, context.Canceled) || errors.Is(err, context.DeadlineExceeded) {
					return ctx.Err()
				}
				return fmt.Errorf("wait for Runtime observation notification: %w", err)
			}
			notify(notification.Payload)
		}
	})
}

var _ repository.ObservationCoordinator = (*Repository)(nil)
var _ repository.ObservationNotificationSource = (*Repository)(nil)
