package postgres

import (
	"context"
	"fmt"
	"net"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/stretchr/testify/require"

	"github.com/tf4fun/antnest-platform/services/agent-controller/internal/application"
	"github.com/tf4fun/antnest-platform/services/agent-controller/internal/ports"
)

type publicationCleanupStore struct {
	*Repository
	callbacks atomic.Int64
}

func (store *publicationCleanupStore) WithExecutionPublication(ctx context.Context, organization string, callback func(context.Context) error) error {
	return store.Repository.WithExecutionPublication(ctx, organization, func(ownedContext context.Context) error {
		store.callbacks.Add(1)
		return callback(ownedContext)
	})
}

type publicationCleanupResult struct {
	acknowledgement ports.ExecutionAcknowledgement
	err             error
}

func TestExecutionPublicationCancellationJoinsDedicatedSessionCleanup(t *testing.T) {
	observer := providerTestRepository(t)
	ctx, cancel := context.WithTimeout(t.Context(), 30*time.Second)
	defer cancel()
	organization := fmt.Sprintf("publication-cleanup-%d", time.Now().UnixNano())
	holder, err := observer.pool.Acquire(ctx)
	require.NoError(t, err)
	t.Cleanup(func() {
		cleanup, stop := context.WithTimeout(context.Background(), 5*time.Second)
		defer stop()
		_, failure := holder.Exec(cleanup, `SELECT pg_advisory_unlock($1, hashtext($2))`, executionPublicationLockNamespace, organization)
		if failure != nil {
			t.Errorf("release publication test holder: %v", failure)
		}
		holder.Release()
	})
	_, err = holder.Exec(ctx, `SELECT pg_advisory_lock($1, hashtext($2))`, executionPublicationLockNamespace, organization)
	require.NoError(t, err)
	holderPID := int32(holder.Conn().PgConn().PID())

	configuration := observer.pool.Config()
	configuration.MinConns = 0
	configuration.MinIdleConns = 0
	configuration.MaxConns = 1
	configuration.ConnConfig.RuntimeParams["application_name"] = organization
	connected := make(chan *pgconn.PgConn, 1)
	afterConnect := configuration.ConnConfig.AfterConnect
	configuration.ConnConfig.AfterConnect = func(connectContext context.Context, connection *pgconn.PgConn) error {
		if afterConnect != nil {
			if failure := afterConnect(connectContext, connection); failure != nil {
				return failure
			}
		}
		connected <- connection
		return nil
	}

	// There are no ordinary-pool acquisitions. The first dial establishes the
	// real lock session; its asynchronous cancellation needs a second dial. Hold
	// that dial before opening another socket so CleanupDone cannot complete.
	cancelDialEntered := make(chan struct{})
	releaseCancelDial := make(chan struct{})
	var enteredOnce, releaseOnce sync.Once
	release := func() { releaseOnce.Do(func() { close(releaseCancelDial) }) }
	var dials atomic.Int64
	dial := configuration.ConnConfig.DialFunc
	configuration.ConnConfig.DialFunc = func(dialContext context.Context, network, address string) (net.Conn, error) {
		if dials.Add(1) > 1 {
			enteredOnce.Do(func() { close(cancelDialEntered) })
			select {
			case <-releaseCancelDial:
			case <-dialContext.Done():
				return nil, dialContext.Err()
			}
		}
		return dial(dialContext, network, address)
	}
	pool, err := pgxpool.NewWithConfig(ctx, configuration)
	require.NoError(t, err)
	store := &publicationCleanupStore{Repository: &Repository{pool: &databasePool{pool}}}
	t.Cleanup(store.Close)
	publisher := application.NewExecutionPublisher(store, nil, nil)
	ownerContext, cancelOwner := context.WithCancel(ctx)
	results := make(chan publicationCleanupResult, 1)
	returned := make(chan struct{})
	var session *pgconn.PgConn
	t.Cleanup(func() {
		release()
		cancelOwner()
		cleanup, stop := context.WithTimeout(context.Background(), 20*time.Second)
		defer stop()
		select {
		case <-returned:
		case <-cleanup.Done():
			t.Error("publication worker did not join during cleanup")
		}
		if session == nil {
			select {
			case session = <-connected:
			default:
			}
		}
		if session != nil {
			select {
			case <-session.CleanupDone():
			case <-cleanup.Done():
				t.Error("dedicated publication session did not finish cleanup")
			}
		}
	})
	go func() {
		defer close(returned)
		acknowledgement, failure := publisher.Publish(ownerContext, organization)
		results <- publicationCleanupResult{acknowledgement: acknowledgement, err: failure}
	}()
	select {
	case session = <-connected:
	case <-ctx.Done():
		t.Fatal("dedicated publication session did not connect", ctx.Err())
	}
	pid := int32(session.PID())
	awaitPublicationCleanupCondition(t, ctx, "publication never waited on the real APUB holder", func(queryContext context.Context) (bool, error) {
		var waiting bool
		failure := observer.pool.QueryRow(queryContext, `SELECT EXISTS (
 SELECT 1 FROM pg_stat_activity
 WHERE pid=$1 AND wait_event_type='Lock' AND $2=ANY(pg_blocking_pids(pid))
)`, pid, holderPID).Scan(&waiting)
		return waiting, failure
	})
	require.EqualValues(t, 1, dials.Load(), "the gate must not be a connection/setup failure")
	cancelOwner()
	select {
	case <-cancelDialEntered:
	case <-ctx.Done():
		t.Fatal("canceled lock wait never entered dedicated-session cleanup", ctx.Err())
	}
	select {
	case <-session.CleanupDone():
		t.Fatal("cleanup completed despite the held cancellation dial")
	default:
	}

	// Positive synchronization above proves cleanup is held. This bounded
	// negative observation only checks that the caller remains joined to it.
	var result publicationCleanupResult
	completed := false
	observation := time.NewTimer(100 * time.Millisecond)
	select {
	case result = <-results:
		completed = true
		t.Error("publication returned before its dedicated session finished cleanup")
	case <-observation.C:
	case <-ctx.Done():
		t.Error("test deadline expired while observing held cleanup")
	}
	observation.Stop()
	require.Zero(t, store.callbacks.Load())
	require.Zero(t, store.pool.Stat().AcquiredConns())
	var backendPresent bool
	err = observer.pool.QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE pid=$1)`, pid).Scan(&backendPresent)
	require.NoError(t, err)
	require.True(t, backendPresent, "the held cleanup must retain a real dedicated backend")

	release()
	if !completed {
		select {
		case result = <-results:
		case <-ctx.Done():
			t.Fatal("publication did not finish after releasing session cleanup", ctx.Err())
		}
	}
	require.ErrorIs(t, result.err, context.Canceled)
	require.Empty(t, result.acknowledgement)
	require.Zero(t, store.callbacks.Load())
	select {
	case <-returned:
	case <-ctx.Done():
		t.Fatal("publication worker did not join", ctx.Err())
	}
	select {
	case <-session.CleanupDone():
	default:
		t.Error("publication returned before CleanupDone closed")
	}
	awaitPublicationCleanupCondition(t, ctx, "canceled publication left a backend or advisory lock", func(queryContext context.Context) (bool, error) {
		var backends, locks int
		failure := observer.pool.QueryRow(queryContext, `SELECT
 (SELECT count(*) FROM pg_stat_activity WHERE pid=$1),
 (SELECT count(*) FROM pg_locks WHERE pid=$1)`, pid).Scan(&backends, &locks)
		return backends == 0 && locks == 0, failure
	})
	require.Zero(t, store.pool.Stat().AcquiredConns())
}

func awaitPublicationCleanupCondition(t *testing.T, ctx context.Context, message string, condition func(context.Context) (bool, error)) {
	t.Helper()
	ctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	ticker := time.NewTicker(5 * time.Millisecond)
	defer ticker.Stop()
	for {
		ready, err := condition(ctx)
		require.NoError(t, err)
		if ready {
			return
		}
		select {
		case <-ticker.C:
		case <-ctx.Done():
			t.Fatal(message, ctx.Err())
		}
	}
}
