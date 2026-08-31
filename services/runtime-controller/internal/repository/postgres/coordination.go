package postgres

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"sync"
	"time"

	"github.com/jackc/pgx/v5/stdlib"

	platformmonitor "soft/antnest-platform/services/runtime-controller/internal/platform/monitor"
)

const (
	observationLeadershipNamespace int32 = 0x414e5402
	observationLeadershipKey       int32 = 1
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
	err         error
}

func (r *Repository) TryAcquireObservationLeadership(
	ctx context.Context,
) (platformmonitor.Leadership, bool, error) {
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
		var unlocked bool
		unlockErr := l.connection.QueryRowContext(ctx,
			"SELECT pg_advisory_unlock($1, $2)",
			observationLeadershipNamespace, observationLeadershipKey,
		).Scan(&unlocked)
		var resultErr error
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
) error {
	if ready == nil || notify == nil {
		return fmt.Errorf("observation notification callbacks are required")
	}
	connection, err := r.database.Conn(ctx)
	if err != nil {
		return fmt.Errorf("reserve observation notification connection: %w", err)
	}
	defer connection.Close()
	return connection.Raw(func(raw any) error {
		stdlibConnection, ok := raw.(*stdlib.Conn)
		if !ok {
			return fmt.Errorf("observation notification requires the pgx database driver")
		}
		postgresConnection := stdlibConnection.Conn()
		if _, err := postgresConnection.Exec(ctx, "LISTEN runtime_controller_observation"); err != nil {
			return fmt.Errorf("listen for Runtime observations: %w", err)
		}
		ready()
		for {
			notification, err := postgresConnection.WaitForNotification(ctx)
			if err != nil {
				if errors.Is(err, context.Canceled) || errors.Is(err, context.DeadlineExceeded) {
					return nil
				}
				return fmt.Errorf("wait for Runtime observation notification: %w", err)
			}
			notify(notification.Payload)
		}
	})
}

var _ platformmonitor.Coordinator = (*Repository)(nil)
