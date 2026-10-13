package main

import (
	"context"
	"crypto/sha256"
	"errors"
	"net/http"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
)

func TestCredentialCleanupRunCancelsBlockedSQLBeforeClosingPool(t *testing.T) {
	f := newBrowserStartupFixture(t)
	digest := sha256.Sum256([]byte("cleanup-startup-fixture"))
	if _, err := f.pool.Exec(t.Context(), `INSERT INTO credential_attempts (scope,key_hash,window_start,failures)
		VALUES ('login_account',$1,clock_timestamp()-interval '1 hour',1)`, digest[:]); err != nil {
		t.Fatal(err)
	}
	blocker, err := f.pool.Begin(t.Context())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		if err := blocker.Rollback(ctx); err != nil && !errors.Is(err, pgx.ErrTxClosed) {
			t.Errorf("release cleanup table lock: %v", err)
		}
	})
	if _, err := blocker.Exec(t.Context(), "LOCK TABLE credential_attempts IN ACCESS EXCLUSIVE MODE"); err != nil {
		t.Fatal(err)
	}
	blockerPID := blocker.Conn().PgConn().PID()
	address := browserStartupAddress(t)
	lookup, _ := browserStartupEnvironment(t, f, address)
	ctx, cancel := context.WithTimeout(t.Context(), 75*time.Second)
	done := make(chan struct{})
	var runErr error
	go func() { defer close(done); runErr = run(ctx, lookup) }()
	t.Cleanup(func() {
		cancel()
		<-done
		if runErr != nil {
			t.Errorf("stop Identity: %v", runErr)
		}
	})
	transport := &http.Transport{}
	t.Cleanup(transport.CloseIdleConnections)
	client := &http.Client{Transport: transport, Timeout: time.Second}
	ticker := time.NewTicker(20 * time.Millisecond)
	defer ticker.Stop()
	for {
		request, err := http.NewRequestWithContext(ctx, http.MethodGet, "http://"+address+"/status", nil)
		if err != nil {
			t.Fatal(err)
		}
		response, err := client.Do(request)
		if err == nil {
			if closeErr := response.Body.Close(); closeErr != nil {
				t.Fatal(closeErr)
			}
			if response.StatusCode == http.StatusOK {
				break
			}
		}
		select {
		case <-done:
			t.Fatalf("Identity stopped before readiness: %v", runErr)
		case <-ctx.Done():
			t.Fatal(ctx.Err())
		case <-ticker.C:
		}
	}

	// Observe the actual production timer and query, held by a real PostgreSQL
	// table lock. No shortened interval or substitute repository is used.
	var cleanupPID uint32
	for {
		err := f.pool.QueryRow(ctx, `SELECT pid FROM pg_stat_activity
			WHERE datname=current_database() AND application_name=$1
			AND query LIKE 'WITH expired AS (%' AND wait_event_type='Lock'
			AND $2=ANY(pg_blocking_pids(pid))`, f.applicationName, blockerPID).Scan(&cleanupPID)
		if err == nil {
			break
		}
		if ctx.Err() != nil {
			t.Fatal("production cleanup never reached the held SQL operation")
		}
		if !errors.Is(err, pgx.ErrNoRows) {
			t.Fatal(err)
		}
		select {
		case <-done:
			t.Fatalf("Identity stopped before scheduled cleanup: %v", runErr)
		case <-ctx.Done():
			t.Fatal("production cleanup never reached the held SQL operation")
		case <-ticker.C:
		}
	}
	cancel()
	select {
	case <-done:
	case <-time.After(10 * time.Second):
		cleanupCtx, cleanupCancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cleanupCancel()
		if err := blocker.Rollback(cleanupCtx); err != nil {
			t.Errorf("release lock after failed shutdown: %v", err)
		}
		t.Fatal("Identity did not cancel and join blocked cleanup during shutdown")
	}
	if runErr != nil {
		t.Fatal(runErr)
	}
	var connections int
	if err := f.pool.QueryRow(t.Context(), "SELECT count(*) FROM pg_stat_activity WHERE pid=$1", cleanupPID).Scan(&connections); err != nil {
		t.Fatal(err)
	}
	if connections != 0 {
		t.Fatal("cleanup connection survived service shutdown")
	}
	// The blocker is deliberately retained until run has returned and its pool
	// has closed; releasing it cannot make an uncancelled worker appear joined.
	if err := blocker.Rollback(t.Context()); err != nil {
		t.Fatal(err)
	}
	var failures int
	if err := f.pool.QueryRow(t.Context(), "SELECT failures FROM credential_attempts WHERE scope='login_account' AND key_hash=$1", digest[:]).Scan(&failures); err != nil {
		t.Fatal(err)
	}
	if failures != 1 {
		t.Fatal("cancelled cleanup changed the held attempt state")
	}
}
