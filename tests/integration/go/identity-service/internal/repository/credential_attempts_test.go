package repository

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"math"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/tf4fun/antnest-platform/services/identity-service/internal/domain"
	"github.com/tf4fun/antnest-platform/services/identity-service/internal/identityid"
)

func credentialAttemptStore(t *testing.T) *Store {
	t.Helper()
	pool := browserMigrationPool(t)
	if err := ApplyMigrations(t.Context(), pool); err != nil {
		t.Fatal(err)
	}
	store, err := New(pool, identityid.MustNew, time.Now)
	if err != nil {
		t.Fatal(err)
	}
	return store
}

func attemptTestKeys(t *testing.T, organization, email string) [2]credentialAttemptKey {
	t.Helper()
	keys, err := loginAttemptKeys(organization, "unused-known-slug", email)
	if err != nil {
		t.Fatal(err)
	}
	return keys
}

func applyAttemptFailure(ctx context.Context, store *Store, keys [2]credentialAttemptKey) error {
	return store.inCredentialTransaction(ctx, func(tx *databaseTransaction, wait *credentialWaitBudget) error {
		admission, err := lockCredentialAttempts(ctx, tx, wait, keys)
		if err != nil {
			return err
		}
		return admission.recordFailure(ctx, tx, wait)
	})
}

func TestCredentialAttemptsFifthCommitSerializesSixthBeforeVerification(t *testing.T) {
	store := credentialAttemptStore(t)
	other, err := New(store.pool.Pool, identityid.MustNew, time.Now)
	if err != nil {
		t.Fatal(err)
	}
	keys := attemptTestKeys(t, "org-1", "account@example.test")
	for n := 0; n < 4; n++ {
		if err := applyAttemptFailure(t.Context(), store, keys); err != nil {
			t.Fatal(err)
		}
	}
	fifthReady, sixthReady := make(chan int32, 1), make(chan int32, 1)
	release := make(chan struct{})
	var releaseOnce sync.Once
	t.Cleanup(func() { releaseOnce.Do(func() { close(release) }) })
	fifth := startAttemptActor(t, func(ctx context.Context) error {
		return store.inCredentialTransaction(ctx, func(tx *databaseTransaction, wait *credentialWaitBudget) error {
			admission, err := lockCredentialAttempts(ctx, tx, wait, keys)
			if err != nil {
				return err
			}
			var pid int32
			if err := tx.QueryRow(ctx, "SELECT pg_backend_pid()").Scan(&pid); err != nil {
				return err
			}
			fifthReady <- pid
			select {
			case <-release:
			case <-ctx.Done():
				return ctx.Err()
			}
			return admission.recordFailure(ctx, tx, wait)
		})
	})
	fifthPID := awaitAttemptPID(t, fifthReady)
	var verifications atomic.Int32
	sixth := startAttemptActor(t, func(ctx context.Context) error {
		return other.inCredentialTransaction(ctx, func(tx *databaseTransaction, wait *credentialWaitBudget) error {
			var pid int32
			if err := tx.QueryRow(ctx, "SELECT pg_backend_pid()").Scan(&pid); err != nil {
				return err
			}
			sixthReady <- pid
			if _, err := lockCredentialAttempts(ctx, tx, wait, keys); err != nil {
				return err
			}
			verifications.Add(1)
			return nil
		})
	})
	assertAttemptBlocker(t, store, awaitAttemptPID(t, sixthReady), fifthPID)
	releaseOnce.Do(func() { close(release) })
	if err := awaitAttemptActor(t, fifth); err != nil {
		t.Fatal(err)
	}
	if err := awaitAttemptActor(t, sixth); !errors.Is(err, domain.ErrCredentialRateLimited) || verifications.Load() != 0 {
		t.Fatalf("sixth attempt reused pre-commit count: error=%v verifications=%d", err, verifications.Load())
	}
	for _, key := range keys {
		if state := readAttemptState(t, store, key); state.failures != 5 {
			t.Fatalf("blocked request incremented counter: %d", state.failures)
		}
	}
	before := attemptStateSnapshot(t, store)
	if err := applyAttemptFailure(t.Context(), other, keys); !errors.Is(err, domain.ErrCredentialRateLimited) {
		t.Fatalf("active backoff was ignored: %v", err)
	}
	if !bytes.Equal(before, attemptStateSnapshot(t, store)) {
		t.Fatal("blocked request extended backoff or changed rows")
	}
}

func TestCredentialAttemptsBlockedOrganizationDoesNotGrowAccountsAndReportsLongestLock(t *testing.T) {
	store := credentialAttemptStore(t)
	keys := attemptTestKeys(t, "org-1", "existing@example.test")
	for index, key := range keys {
		seconds, failures := 30, 100
		if index == 1 {
			seconds, failures = 60, 10
		}
		if _, err := store.pool.Exec(t.Context(), `INSERT INTO credential_attempts VALUES ($1,$2,clock_timestamp(),$3,clock_timestamp()+make_interval(secs=>$4::int))`, string(key.scope), key.digest[:], failures, seconds); err != nil {
			t.Fatal(err)
		}
	}
	for n := 0; n < 8; n++ {
		unknown := attemptTestKeys(t, "org-1", fmt.Sprintf("new-%d@example.test", n))
		if err := applyAttemptFailure(t.Context(), store, unknown); !errors.Is(err, domain.ErrCredentialRateLimited) {
			t.Fatalf("organization backoff bypassed: %v", err)
		}
	}
	var rows int
	if err := store.pool.QueryRow(t.Context(), "SELECT count(*) FROM credential_attempts").Scan(&rows); err != nil || rows != 2 {
		t.Fatalf("blocked organization grew account buckets: rows=%d error=%v", rows, err)
	}
	account := readAttemptState(t, store, keys[1])
	if account.lockedUntil == nil {
		t.Fatal("fixture has no account delay")
	}
	var beforeCall, afterCall time.Time
	if err := store.pool.QueryRow(t.Context(), "SELECT clock_timestamp()").Scan(&beforeCall); err != nil {
		t.Fatal(err)
	}
	err := applyAttemptFailure(t.Context(), store, keys)
	if clockErr := store.pool.QueryRow(t.Context(), "SELECT clock_timestamp()").Scan(&afterCall); clockErr != nil {
		t.Fatal(clockErr)
	}
	lower := max(1, int(math.Ceil(account.lockedUntil.Sub(afterCall).Seconds())))
	upper := max(1, int(math.Ceil(account.lockedUntil.Sub(beforeCall).Seconds())))
	var limited *domain.CredentialRateLimitError
	if !errors.As(err, &limited) || limited.RetryAfterSeconds < lower || limited.RetryAfterSeconds > upper {
		t.Fatalf("response did not use longest existing lock in database time bounds [%d,%d]: %v", lower, upper, err)
	}
}

func TestCredentialAttemptsRecheckBothExpirationsAfterExistingAccountWait(t *testing.T) {
	store := credentialAttemptStore(t)
	ctx := t.Context()
	keys := attemptTestKeys(t, "org-1", "account@example.test")
	for _, key := range keys {
		if _, err := store.pool.Exec(ctx, `INSERT INTO credential_attempts VALUES ($1,$2,clock_timestamp()-interval '20 minutes',5,clock_timestamp()+interval '1 minute')`, string(key.scope), key.digest[:]); err != nil {
			t.Fatal(err)
		}
	}
	held, err := store.pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = held.Rollback(context.WithoutCancel(ctx)) }()
	// Admission first sees the committed active account lock. Its locking read
	// must use this newer expired state after the holder commits.
	if _, err := held.Exec(ctx, `UPDATE credential_attempts SET locked_until=clock_timestamp()-interval '1 microsecond' WHERE scope='login_account'`); err != nil {
		t.Fatal(err)
	}
	var holderPID int32
	if err := held.QueryRow(ctx, "SELECT pg_backend_pid()").Scan(&holderPID); err != nil {
		t.Fatal(err)
	}
	var organizationUntil time.Time
	if err := store.pool.QueryRow(ctx, `UPDATE credential_attempts SET failures=100,locked_until=clock_timestamp()+interval '1 second' WHERE scope='organization' RETURNING locked_until`).Scan(&organizationUntil); err != nil {
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
	pid := awaitAttemptPID(t, started)
	assertAttemptBlocker(t, store, pid, holderPID)
	var blockedQuery string
	if err := store.pool.QueryRow(ctx, "SELECT query FROM pg_stat_activity WHERE pid=$1", pid).Scan(&blockedQuery); err != nil {
		t.Fatal(err)
	}
	if !strings.HasPrefix(strings.TrimSpace(blockedQuery), "SELECT window_start,failures,locked_until") {
		t.Fatal("fixture did not enter the blocked-Organization existing-account branch")
	}
	// Advance real database time past the Organization delay, within the same
	// two-second allowance. The transaction-start timestamp is still too early.
	if _, err := store.pool.Exec(ctx, `SELECT pg_sleep(GREATEST(0,EXTRACT(EPOCH FROM ($1::timestamptz-clock_timestamp()))))`, organizationUntil); err != nil {
		t.Fatal(err)
	}
	if err := held.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	if err := awaitAttemptActor(t, actor); err != nil {
		t.Fatalf("expired locks rejected admission after its wait: %v", err)
	}
	for _, key := range keys {
		state := readAttemptState(t, store, key)
		if state.failures != 1 || state.lockedUntil != nil || state.windowStart.Before(organizationUntil) {
			t.Fatal("post-wait admission did not reset both expired windows")
		}
	}
}

func TestCredentialAttemptsUseFreshOutcomeClockAndResetOnlyAccount(t *testing.T) {
	store := credentialAttemptStore(t)
	keys := attemptTestKeys(t, "org-1", "account@example.test")
	var beforeOutcome time.Time
	if err := store.inCredentialTransaction(t.Context(), func(tx *databaseTransaction, wait *credentialWaitBudget) error {
		admission, err := lockCredentialAttempts(t.Context(), tx, wait, keys)
		if err != nil {
			return err
		}
		// Separate admission from completion without relying on replica clocks.
		if _, err := tx.Exec(t.Context(), "SELECT pg_sleep(0.02)"); err != nil {
			return err
		}
		if err := tx.QueryRow(t.Context(), "SELECT clock_timestamp()").Scan(&beforeOutcome); err != nil {
			return err
		}
		return admission.recordFailure(t.Context(), tx, wait)
	}); err != nil {
		t.Fatal(err)
	}
	for _, key := range keys {
		state := readAttemptState(t, store, key)
		if state.windowStart.Before(beforeOutcome) || state.failures != 1 {
			t.Fatal("first failure window reused admission/transaction time")
		}
	}
	for n := 1; n < 4; n++ {
		if err := applyAttemptFailure(t.Context(), store, keys); err != nil {
			t.Fatal(err)
		}
	}
	if err := store.inCredentialTransaction(t.Context(), func(tx *databaseTransaction, wait *credentialWaitBudget) error {
		admission, err := lockCredentialAttempts(t.Context(), tx, wait, keys)
		if err != nil {
			return err
		}
		if _, err := tx.Exec(t.Context(), "SELECT pg_sleep(0.02)"); err != nil {
			return err
		}
		if err := tx.QueryRow(t.Context(), "SELECT clock_timestamp()").Scan(&beforeOutcome); err != nil {
			return err
		}
		return admission.recordFailure(t.Context(), tx, wait)
	}); err != nil {
		t.Fatal(err)
	}
	if state := readAttemptState(t, store, keys[1]); state.lockedUntil == nil || state.lockedUntil.Before(beforeOutcome.Add(time.Second)) {
		t.Fatal("fifth failure backoff reused pre-verification time")
	}
	// Expire only the account delay, preserving the original 15-minute window.
	if _, err := store.pool.Exec(t.Context(), `UPDATE credential_attempts SET locked_until=clock_timestamp()-interval '1 microsecond' WHERE scope='login_account'`); err != nil {
		t.Fatal(err)
	}
	if err := store.inCredentialTransaction(t.Context(), func(tx *databaseTransaction, wait *credentialWaitBudget) error {
		admission, err := lockCredentialAttempts(t.Context(), tx, wait, keys)
		if err != nil {
			return err
		}
		return admission.resetAccount(t.Context(), tx, wait)
	}); err != nil {
		t.Fatal(err)
	}
	if state := readAttemptState(t, store, keys[1]); state.failures != 0 || state.lockedUntil != nil {
		t.Fatal("success did not reset its account")
	}
	if state := readAttemptState(t, store, keys[0]); state.failures != 5 {
		t.Fatal("account success reset Organization aggregate")
	}
}

func TestCredentialAttemptsRollbackOperationAndCommitFailures(t *testing.T) {
	for _, failure := range []string{"operation", "commit"} {
		t.Run(failure, func(t *testing.T) {
			store := credentialAttemptStore(t)
			keys := attemptTestKeys(t, "org-1", "account@example.test")
			if err := applyAttemptFailure(t.Context(), store, keys); err != nil {
				t.Fatal(err)
			}
			before := attemptStateSnapshot(t, store)
			err := store.inCredentialTransaction(t.Context(), func(tx *databaseTransaction, wait *credentialWaitBudget) error {
				admission, err := lockCredentialAttempts(t.Context(), tx, wait, keys)
				if err != nil {
					return err
				}
				if err := admission.recordFailure(t.Context(), tx, wait); err != nil {
					return err
				}
				if failure == "operation" {
					return domain.ErrCredentialBusy
				}
				_, err = tx.Exec(t.Context(), `CREATE TEMP TABLE attempt_commit_probe (value INT UNIQUE DEFERRABLE INITIALLY DEFERRED) ON COMMIT DROP; INSERT INTO attempt_commit_probe VALUES (1),(1)`)
				return err
			})
			if err == nil || errors.Is(err, domain.ErrUnauthenticated) || errors.Is(err, domain.ErrCredentialRateLimited) {
				t.Fatalf("transaction failure became a confirmed authentication result: %v", err)
			}
			if !bytes.Equal(before, attemptStateSnapshot(t, store)) {
				t.Fatal("failed transaction committed counters")
			}
		})
	}
}

type attemptActor struct {
	done   <-chan error
	joined <-chan struct{}
}

func startAttemptActor(t *testing.T, run func(context.Context) error) attemptActor {
	t.Helper()
	ctx, cancel := context.WithTimeout(t.Context(), 10*time.Second)
	done, joined := make(chan error, 1), make(chan struct{})
	go func() { defer close(joined); done <- run(ctx) }()
	t.Cleanup(func() { cancel(); <-joined })
	return attemptActor{done: done, joined: joined}
}

func awaitAttemptActor(t *testing.T, actor attemptActor) error {
	t.Helper()
	select {
	case err := <-actor.done:
		<-actor.joined
		return err
	case <-time.After(5 * time.Second):
		t.Fatal("credential attempt actor did not finish")
		return nil
	}
}

func awaitAttemptPID(t *testing.T, ready <-chan int32) int32 {
	t.Helper()
	select {
	case pid := <-ready:
		return pid
	case <-time.After(5 * time.Second):
		t.Fatal("credential attempt actor did not reach its barrier")
		return 0
	}
}

func assertAttemptBlocker(t *testing.T, store *Store, waiter, blocker int32) {
	t.Helper()
	ctx, cancel := context.WithTimeout(t.Context(), time.Second)
	defer cancel()
	for ctx.Err() == nil {
		var blocked bool
		if err := store.pool.QueryRow(ctx, `SELECT $1=ANY(pg_blocking_pids($2))`, blocker, waiter).Scan(&blocked); err != nil {
			t.Fatal(err)
		}
		if blocked {
			return
		}
		time.Sleep(time.Millisecond)
	}
	t.Fatal("expected credential attempt row blocker was not observed")
}

func readAttemptState(t *testing.T, store *Store, key credentialAttemptKey) credentialAttemptState {
	t.Helper()
	var state credentialAttemptState
	if err := store.pool.QueryRow(t.Context(), `SELECT window_start, failures, locked_until FROM credential_attempts WHERE scope=$1 AND key_hash=$2`, string(key.scope), key.digest[:]).Scan(&state.windowStart, &state.failures, &state.lockedUntil); err != nil {
		t.Fatal(err)
	}
	return state
}

func attemptStateSnapshot(t *testing.T, store *Store) []byte {
	t.Helper()
	var value []byte
	if err := store.pool.QueryRow(t.Context(), `SELECT COALESCE(jsonb_agg(to_jsonb(a) ORDER BY scope,key_hash),'[]'::jsonb) FROM credential_attempts a`).Scan(&value); err != nil {
		t.Fatal(err)
	}
	return value
}
