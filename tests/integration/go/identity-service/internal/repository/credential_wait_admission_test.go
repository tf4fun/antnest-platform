package repository

import (
	"bytes"
	"context"
	"errors"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/tf4fun/antnest-platform/services/identity-service/internal/domain"
	"github.com/tf4fun/antnest-platform/services/identity-service/internal/identityid"
)

func TestCredentialWaitExhaustionPreservesPublicBusyOverStorageCause(t *testing.T) {
	store := credentialAttemptStore(t)
	for _, cause := range []error{pgx.ErrNoRows, &pgconn.PgError{Code: "23505"}, &pgconn.PgError{Code: "23503"}, &pgconn.PgError{Code: "23514"}} {
		t.Run(cause.Error(), func(t *testing.T) {
			err := store.inCredentialTransaction(t.Context(), func(_ *databaseTransaction, wait *credentialWaitBudget) error {
				wait.remaining = time.Millisecond
				return wait.wait(t.Context(), func(ctx context.Context) error {
					<-ctx.Done()
					return cause
				})
			})
			code, message, retryable := domain.ErrorDetails(err)
			if code != "credential_busy" || message != domain.ErrCredentialBusy.Message || !retryable || !errors.Is(err, cause) {
				t.Fatalf("wait exhaustion changed its public classification or lost its private cause: code=%s message=%s retryable=%t error=%v", code, message, retryable, err)
			}
		})
	}
}

type credentialBeginTraceKey struct{}

type credentialBeginTracer struct {
	afterBegin func(context.Context, *pgx.Conn)
}

func (tracer credentialBeginTracer) TraceQueryStart(ctx context.Context, _ *pgx.Conn, data pgx.TraceQueryStartData) context.Context {
	return context.WithValue(ctx, credentialBeginTraceKey{}, data.SQL == "begin")
}

func (tracer credentialBeginTracer) TraceQueryEnd(ctx context.Context, connection *pgx.Conn, data pgx.TraceQueryEndData) {
	if ctx.Value(credentialBeginTraceKey{}) == true && data.Err == nil {
		tracer.afterBegin(ctx, connection)
	}
}

func TestCredentialWaitBeginCompletedAfterAdmissionEndsReleasesTransaction(t *testing.T) {
	for _, cancelRequest := range []bool{false, true} {
		name := "database-budget"
		if cancelRequest {
			name = "request-cancelled"
		}
		t.Run(name, func(t *testing.T) {
			store := credentialAttemptStore(t)
			keys := attemptTestKeys(t, "org-1", "account@example.test")
			if err := applyAttemptFailure(t.Context(), store, keys); err != nil {
				t.Fatal(err)
			}
			before := attemptStateSnapshot(t, store)
			ctx, cancel := context.WithCancel(t.Context())
			defer cancel()
			var locked bool
			var traceErr error
			config := store.pool.Config()
			config.ConnConfig.Tracer = credentialBeginTracer{afterBegin: func(bounded context.Context, connection *pgx.Conn) {
				// BEGIN succeeded on the server. Keep its return in the driver hook
				// until admission ends, after taking a real row lock in that tx.
				if _, err := connection.Exec(bounded, `SELECT scope FROM credential_attempts WHERE scope='organization' FOR UPDATE`); err != nil {
					traceErr = err
					return
				}
				locked = true
				if cancelRequest {
					cancel()
				}
				<-bounded.Done()
			}}
			pool, err := pgxpool.NewWithConfig(t.Context(), config)
			if err != nil {
				t.Fatal(err)
			}
			t.Cleanup(pool.Close)
			other, err := New(pool, identityid.MustNew, time.Now)
			if err != nil {
				t.Fatal(err)
			}
			called := false
			err = other.inCredentialTransaction(ctx, func(*databaseTransaction, *credentialWaitBudget) error {
				called = true
				return nil
			})
			if traceErr != nil {
				t.Fatal(traceErr)
			}
			want := error(domain.ErrCredentialBusy)
			if cancelRequest {
				want = context.Canceled
			}
			if !locked || called || !errors.Is(err, want) {
				t.Fatalf("completed BEGIN escaped expired admission: locked=%t callback=%t error=%v", locked, called, err)
			}
			if got := pool.Stat().AcquiredConns(); got != 0 {
				t.Fatalf("expired BEGIN leaked %d acquired connections", got)
			}
			if _, err := store.pool.Exec(t.Context(), `SELECT scope FROM credential_attempts WHERE scope='organization' FOR UPDATE NOWAIT`); err != nil {
				t.Fatalf("expired BEGIN retained its row lock: %v", err)
			}
			if !bytes.Equal(before, attemptStateSnapshot(t, store)) {
				t.Fatal("expired BEGIN mutated attempt state")
			}
		})
	}
}

func TestCredentialWaitPoolCapacityExhaustionDoesNotEnterTransaction(t *testing.T) {
	store := credentialAttemptStore(t)
	config := store.pool.Config()
	config.MaxConns, config.MinConns = 1, 0
	pool, err := pgxpool.NewWithConfig(t.Context(), config)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)
	other, err := New(pool, identityid.MustNew, time.Now)
	if err != nil {
		t.Fatal(err)
	}
	held, err := pool.Acquire(t.Context())
	if err != nil {
		t.Fatal(err)
	}
	defer held.Release()
	called := false
	err = other.inCredentialTransaction(t.Context(), func(*databaseTransaction, *credentialWaitBudget) error {
		called = true
		return nil
	})
	if called || !errors.Is(err, domain.ErrCredentialBusy) {
		t.Fatalf("exhausted pool admitted a transaction: called=%t error=%v", called, err)
	}
	held.Release()
	if pool.Stat().AcquiredConns() != 0 {
		t.Fatal("exhausted pool retained an acquired connection")
	}
	if err := other.inCredentialTransaction(t.Context(), func(*databaseTransaction, *credentialWaitBudget) error { return nil }); err != nil {
		t.Fatalf("released pool failed subsequent admission: %v", err)
	}
}

func TestCredentialWaitRowTimeoutRollsBackWithoutFailureIncrement(t *testing.T) {
	store := credentialAttemptStore(t)
	keys := attemptTestKeys(t, "org-1", "account@example.test")
	if err := applyAttemptFailure(t.Context(), store, keys); err != nil {
		t.Fatal(err)
	}
	before := attemptStateSnapshot(t, store)
	held, err := store.pool.Begin(t.Context())
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = held.Rollback(context.WithoutCancel(t.Context())) }()
	if _, err := held.Exec(t.Context(), `SELECT scope FROM credential_attempts WHERE scope='organization' FOR UPDATE`); err != nil {
		t.Fatal(err)
	}
	var holderPID int32
	if err := held.QueryRow(t.Context(), "SELECT pg_backend_pid()").Scan(&holderPID); err != nil {
		t.Fatal(err)
	}
	started := make(chan int32, 1)
	actor := startAttemptActor(t, func(ctx context.Context) error {
		return store.inCredentialTransaction(ctx, func(tx *databaseTransaction, wait *credentialWaitBudget) error {
			var pid int32
			if err := tx.QueryRow(ctx, "SELECT pg_backend_pid()").Scan(&pid); err != nil {
				return err
			}
			started <- pid
			admission, err := lockCredentialAttempts(ctx, tx, wait, keys)
			if err != nil {
				return err
			}
			return admission.recordFailure(ctx, tx, wait)
		})
	})
	assertAttemptBlocker(t, store, awaitAttemptPID(t, started), holderPID)
	if err := awaitAttemptActor(t, actor); !errors.Is(err, domain.ErrCredentialBusy) {
		t.Fatalf("row admission wait did not return busy: %v", err)
	}
	if !bytes.Equal(before, attemptStateSnapshot(t, store)) {
		t.Fatal("row timeout changed attempt counters")
	}
	if err := held.Commit(t.Context()); err != nil {
		t.Fatal(err)
	}
	if err := applyAttemptFailure(t.Context(), store, keys); err != nil {
		t.Fatalf("released row did not admit a new request: %v", err)
	}
	for _, key := range keys {
		if state := readAttemptState(t, store, key); state.failures != 2 {
			t.Fatal("row timeout was incorrectly counted as a failure")
		}
	}
}
