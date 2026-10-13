package repository

import (
	"context"
	"sync"
	"testing"

	"github.com/jackc/pgx/v5"
)

func TestCredentialAttemptCleanupIsBoundedAndSkipsHeldActiveAndRecentRows(t *testing.T) {
	store := credentialAttemptStore(t)
	ctx := t.Context()
	if _, err := store.pool.Exec(ctx, `INSERT INTO credential_attempts
		SELECT 'login_account',decode(lpad(to_hex(n),64,'0'),'hex'),clock_timestamp()-interval '20 minutes',1,NULL
		FROM generate_series(0,601) n;
		INSERT INTO credential_attempts VALUES
		('organization',decode(repeat('f',64),'hex'),clock_timestamp()-interval '20 minutes',100,clock_timestamp()+interval '1 minute'),
		('organization',decode(repeat('e',64),'hex'),clock_timestamp(),1,NULL)`); err != nil {
		t.Fatal(err)
	}
	held, err := store.pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = held.Rollback(context.WithoutCancel(ctx)) }()
	if _, err := held.Exec(ctx, `SELECT scope FROM credential_attempts WHERE scope='login_account' AND key_hash=decode(repeat('0',64),'hex') FOR UPDATE`); err != nil {
		t.Fatal(err)
	}
	for _, want := range []int64{500, 101, 0} {
		if removed, err := store.CleanupCredentialAttempts(ctx); err != nil || removed != want {
			t.Fatalf("cleanup limit/locked-row skipping: removed=%d want=%d error=%v", removed, want, err)
		}
	}
	if err := held.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	if removed, err := store.CleanupCredentialAttempts(ctx); err != nil || removed != 1 {
		t.Fatalf("released expired row did not become eligible: removed=%d error=%v", removed, err)
	}
	var protected int
	if err := store.pool.QueryRow(ctx, "SELECT count(*) FROM credential_attempts").Scan(&protected); err != nil || protected != 2 {
		t.Fatalf("cleanup removed active lock or recent window: rows=%d error=%v", protected, err)
	}
}

func TestCredentialAttemptCleanupAndAdmissionCannotLoseOrReplaceAnInUseBucket(t *testing.T) {
	for _, cleanupFirst := range []bool{true, false} {
		name := "admission-first"
		if cleanupFirst {
			name = "cleanup-first"
		}
		t.Run(name, func(t *testing.T) {
			store := credentialAttemptStore(t)
			ctx := t.Context()
			keys := attemptTestKeys(t, "org-1", "account@example.test")
			for _, key := range keys {
				if _, err := store.pool.Exec(ctx, `INSERT INTO credential_attempts VALUES ($1,$2,clock_timestamp()-interval '20 minutes',4,NULL)`, string(key.scope), key.digest[:]); err != nil {
					t.Fatal(err)
				}
			}
			var deletion *databaseTransaction
			var deletionPID int32
			if cleanupFirst {
				var err error
				deletion, err = store.pool.BeginTx(ctx, pgx.TxOptions{})
				if err != nil {
					t.Fatal(err)
				}
				defer func() { _ = deletion.Rollback(context.WithoutCancel(ctx)) }()
				if _, err := deletion.Exec(ctx, `DELETE FROM credential_attempts WHERE scope=$1 AND key_hash=$2`, string(keys[0].scope), keys[0].digest[:]); err != nil {
					t.Fatal(err)
				}
				if err := deletion.QueryRow(ctx, "SELECT pg_backend_pid()").Scan(&deletionPID); err != nil {
					t.Fatal(err)
				}
			}
			started, locked := make(chan int32, 1), make(chan int32, 1)
			release := make(chan struct{})
			var once sync.Once
			t.Cleanup(func() { once.Do(func() { close(release) }) })
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
					locked <- pid
					select {
					case <-release:
					case <-ctx.Done():
						return ctx.Err()
					}
					return admission.recordFailure(ctx, tx, wait)
				})
			})
			pid := awaitAttemptPID(t, started)
			if cleanupFirst {
				assertAttemptBlocker(t, store, pid, deletionPID)
				if err := deletion.Commit(ctx); err != nil {
					t.Fatal(err)
				}
			}
			awaitAttemptPID(t, locked)
			if removed, err := store.CleanupCredentialAttempts(ctx); err != nil || removed != 0 {
				t.Fatalf("cleanup removed in-use admission buckets: removed=%d error=%v", removed, err)
			}
			once.Do(func() { close(release) })
			if err := awaitAttemptActor(t, actor); err != nil {
				t.Fatalf("cleanup/admission race lost its bucket: %v", err)
			}
			for _, key := range keys {
				if state := readAttemptState(t, store, key); state.failures != 1 || state.lockedUntil != nil {
					t.Fatal("expired bucket cleanup bypassed the first new failure")
				}
			}
		})
	}
}
