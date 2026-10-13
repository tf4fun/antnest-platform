package e2e

import (
	"context"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/multitracer"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/tf4fun/antnest-platform/services/identity-service/internal/directory"
	"github.com/tf4fun/antnest-platform/services/identity-service/internal/repository"
)

func TestBrowserStartupAndUserDeactivationUseOneTokenLockOrder(t *testing.T) {
	f, _, initial, now := browserDeadlineFixture(t)
	// Heap order differs from immutable ID order. Both plans are legal in
	// PostgreSQL; bulk writers must not rely on the planner choosing an index.
	if _, err := f.pool.Exec(t.Context(), `
		INSERT INTO api_tokens (id, public_session_id, token_hash, user_id, organization_id, membership_id, issued_at, expires_at, idle_expires_at, last_used_at)
		SELECT '000-first', 'ordered-public', 'ordered-hash', user_id, organization_id, membership_id, issued_at, expires_at, idle_expires_at, last_used_at
		FROM api_tokens WHERE id = $1`, initial.TokenID); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(t.Context(), 15*time.Second)
	var workers sync.WaitGroup
	defer func() { cancel(); workers.Wait() }()
	blocker, err := f.pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = blocker.Rollback(context.WithoutCancel(ctx)) }()
	if _, err := blocker.Exec(ctx, `SELECT id FROM api_tokens WHERE id = $1 FOR UPDATE`, initial.TokenID); err != nil {
		t.Fatal(err)
	}
	newStore := func() (*repository.Store, <-chan uint32) {
		config := f.pool.Config()
		config.ConnConfig.RuntimeParams["enable_indexscan"] = "off"
		config.ConnConfig.RuntimeParams["enable_bitmapscan"] = "off"
		pid := make(chan uint32, 1)
		var captured sync.Once
		config.ConnConfig.Tracer = multitracer.New(admissionQueryTracer{before: func(_ context.Context, conn *pgx.Conn, sql string) {
			if strings.Contains(sql, "api_tokens") && (strings.Contains(sql, "UPDATE api_tokens") || strings.Contains(sql, "FOR UPDATE")) {
				captured.Do(func() { pid <- conn.PgConn().PID() })
			}
		}}, config.ConnConfig.Tracer)
		pool, err := pgxpool.NewWithConfig(t.Context(), config)
		if err != nil {
			t.Fatal(err)
		}
		t.Cleanup(pool.Close)
		store, err := repository.New(pool, f.newID, f.clock)
		if err != nil {
			t.Fatal(err)
		}
		return store, pid
	}
	disabling, disablePID := newStore()
	disabled := make(chan error, 1)
	workers.Go(func() {
		disabled <- directory.NewService(disabling.Directory(), f.newID, f.clock, testPasswordEngine(t)).SetUserActive(ctx, directory.SetUserActiveInput{
			RequestID: "startup-overlap-disable", ActorPrincipalID: f.admin.User.ID, UserID: f.user.User.ID, Active: false,
		})
	})
	select {
	case pid := <-disablePID:
		waitForDatabaseLock(t, ctx, f.pool, pid)
	case err := <-disabled:
		t.Fatalf("deactivation did not wait for the token row: %v", err)
	case <-ctx.Done():
		t.Fatal(ctx.Err())
	}
	starting, startupPID := newStore()
	started := make(chan error, 1)
	workers.Go(func() { started <- starting.InitializeBrowserSessions(ctx, 5*time.Second) })
	select {
	case pid := <-startupPID:
		waitForDatabaseLock(t, ctx, f.pool, pid)
	case err := <-started:
		t.Fatalf("startup did not wait for a token row: %v", err)
	case <-ctx.Done():
		t.Fatal(ctx.Err())
	}
	if err := blocker.Rollback(ctx); err != nil {
		t.Fatal(err)
	}
	for name, result := range map[string]<-chan error{"startup": started, "deactivation": disabled} {
		select {
		case err := <-result:
			if err != nil {
				t.Fatalf("%s did not commit without deadlock: %v", name, err)
			}
		case <-ctx.Done():
			t.Fatal(ctx.Err())
		}
	}
	var active bool
	var live, revoked int
	if err := f.pool.QueryRow(ctx, `SELECT active, (SELECT count(*) FROM api_tokens WHERE user_id = $1 AND revoked_at IS NULL), (SELECT count(*) FROM api_tokens WHERE user_id = $1 AND revoked_at IS NOT NULL) FROM users WHERE id = $1`, f.user.User.ID).Scan(&active, &live, &revoked); err != nil {
		t.Fatal(err)
	}
	if active || live != 0 || revoked != 2 {
		t.Fatal("startup lost or reversed the overlapping user deactivation")
	}
	assertBrowserIdle(t, f, initial.TokenID, now.Add(30*time.Minute))
	assertBrowserIdle(t, f, "000-first", now.Add(30*time.Minute))
}
