package e2e

import (
	"context"
	"errors"
	"os"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/multitracer"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/tf4fun/antnest-platform/services/identity-service/internal/directory"
	"github.com/tf4fun/antnest-platform/services/identity-service/internal/domain"
	"github.com/tf4fun/antnest-platform/services/identity-service/internal/localauth"
	"github.com/tf4fun/antnest-platform/services/identity-service/internal/repository"
)

func TestLocalLoginOverlapsAdministratorDeactivation(t *testing.T) {
	databaseURL := os.Getenv("ANTNEST_IDENTITY_TEST_DATABASE_URL")
	if databaseURL == "" {
		t.Skip("ANTNEST_IDENTITY_TEST_DATABASE_URL is not set")
	}
	f := newLocalAdmissionFixture(t, databaseURL, time.Now)
	if _, err := f.pool.Exec(t.Context(), `UPDATE organization_memberships SET role = 'admin' WHERE id = $1`, f.user.Membership.ID); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(t.Context(), 15*time.Second)
	var workers sync.WaitGroup
	defer func() { cancel(); workers.Wait() }()
	userLocked := make(chan struct{})
	continueDisable := make(chan struct{})
	disableStore := f.tracedStore(t, func(ctx context.Context, _ *pgx.Conn, sql string) {
		if strings.Contains(sql, "FOR UPDATE OF o") {
			close(userLocked)
			select {
			case <-continueDisable:
			case <-ctx.Done():
			}
		}
	})
	disabled := make(chan error, 1)
	workers.Go(func() {
		disabled <- directory.NewService(disableStore.Directory(), f.newID, time.Now).SetUserActive(ctx, directory.SetUserActiveInput{
			RequestID: "disable-during-login", ActorPrincipalID: f.admin.User.ID, UserID: f.user.User.ID, Active: false,
		})
	})
	select {
	case <-userLocked:
	case err := <-disabled:
		t.Fatalf("deactivation did not reach the User lock: %v", err)
	case <-ctx.Done():
		t.Fatal(ctx.Err())
	}
	loginPID := make(chan uint32, 1)
	var captured sync.Once
	loginStore := f.tracedStore(t, func(_ context.Context, conn *pgx.Conn, sql string) {
		if strings.Contains(sql, "FOR SHARE") && strings.Contains(sql, "FROM users") {
			captured.Do(func() { loginPID <- conn.PgConn().PID() })
		}
	})
	auth, err := localauth.NewService(loginStore.LocalAuth(), f.newID, time.Now, time.Hour)
	if err != nil {
		t.Fatal(err)
	}
	loggedIn := make(chan error, 1)
	workers.Go(func() {
		_, loginErr := auth.Login(ctx, localauth.LoginInput{
			RequestID: "concurrent-login", OrganizationSlug: "admission", Email: "member@example.com", Password: "correct horse battery staple",
		})
		loggedIn <- loginErr
	})
	select {
	case pid := <-loginPID:
		waitForDatabaseLock(t, ctx, f.pool, pid)
	case <-ctx.Done():
		t.Fatal(ctx.Err())
	}
	close(continueDisable)
	if err := <-disabled; err != nil {
		t.Fatalf("deactivation must commit without deadlock: %v", err)
	}
	if err := <-loggedIn; !errors.Is(err, domain.ErrUnauthenticated) {
		t.Fatalf("concurrent login = %v, want unauthenticated without deadlock", err)
	}
	f.assertIssuanceCount(t, 0)
}

func TestOIDCCompletionDeadlineIncludesDatabaseLockWait(t *testing.T) {
	databaseURL := os.Getenv("ANTNEST_IDENTITY_TEST_DATABASE_URL")
	if databaseURL == "" {
		t.Skip("ANTNEST_IDENTITY_TEST_DATABASE_URL is not set")
	}
	f := newOIDCAdmissionFixture(t, databaseURL)
	input := f.start(t)
	ctx, cancel := context.WithTimeout(t.Context(), 15*time.Second)
	var workers sync.WaitGroup
	defer func() { cancel(); workers.Wait() }()
	blocker, err := f.pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = blocker.Rollback(context.WithoutCancel(ctx)) }()
	if _, err := blocker.Exec(ctx, `SELECT id FROM oidc_providers FOR UPDATE`); err != nil {
		t.Fatal(err)
	}
	completionPID := make(chan uint32, 1)
	var captured sync.Once
	f.repository.Repository = f.tracedStore(t, func(_ context.Context, conn *pgx.Conn, sql string) {
		if strings.Contains(sql, "FOR UPDATE OF s, p") {
			captured.Do(func() { completionPID <- conn.PgConn().PID() })
		}
	}).OIDC()
	completed := make(chan error, 1)
	workers.Go(func() {
		_, completionErr := f.flow.CompleteLogin(ctx, input)
		completed <- completionErr
	})
	select {
	case pid := <-completionPID:
		waitForDatabaseLock(t, ctx, f.pool, pid)
	case err := <-completed:
		t.Fatalf("completion did not wait for the Provider lock: %v", err)
	case <-ctx.Done():
		t.Fatal(ctx.Err())
	}
	// Keep the original command/IssuedAt. Only the clock advances while the
	// actual PostgreSQL completion query is blocked on our transaction.
	f.advance(time.Minute)
	if err := blocker.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	if err := <-completed; err != nil {
		if code, _, _ := domain.ErrorDetails(err); code != "oidc_session_expired" {
			t.Fatalf("completion after lock wait: %v", err)
		}
	} else {
		t.Fatal("completion succeeded after its login deadline")
	}
	var status, stage string
	var tokens, links, events int
	if err := f.pool.QueryRow(ctx, `
		SELECT status, failure_stage,
		       (SELECT count(*) FROM api_tokens), (SELECT count(*) FROM external_identities),
		       (SELECT count(*) FROM identity_events WHERE event_type = 'oidc_login.completed')
		FROM oidc_auth_sessions`).Scan(&status, &stage, &tokens, &links, &events); err != nil {
		t.Fatal(err)
	}
	if status != "failed" || stage != "expired" || tokens != 0 || links != 0 || events != 0 {
		t.Fatalf("expired lock wait: status=%s stage=%s tokens=%d links=%d events=%d", status, stage, tokens, links, events)
	}
}

func (f localAdmissionFixture) tracedStore(t *testing.T, before func(context.Context, *pgx.Conn, string)) *repository.Store {
	t.Helper()
	config := f.pool.Config()
	config.ConnConfig.Tracer = multitracer.New(admissionQueryTracer{before: before}, config.ConnConfig.Tracer)
	pool, err := pgxpool.NewWithConfig(t.Context(), config)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)
	store, err := repository.New(pool, f.newID, f.clock)
	if err != nil {
		t.Fatal(err)
	}
	return store
}

type admissionQueryTracer struct {
	before func(context.Context, *pgx.Conn, string)
}

func (tracer admissionQueryTracer) TraceQueryStart(ctx context.Context, conn *pgx.Conn, data pgx.TraceQueryStartData) context.Context {
	tracer.before(ctx, conn, data.SQL)
	return ctx
}

func (admissionQueryTracer) TraceQueryEnd(context.Context, *pgx.Conn, pgx.TraceQueryEndData) {}

func waitForDatabaseLock(t *testing.T, ctx context.Context, pool *pgxpool.Pool, pid uint32) {
	t.Helper()
	ticker := time.NewTicker(10 * time.Millisecond)
	defer ticker.Stop()
	for {
		var blocked bool
		if err := pool.QueryRow(ctx, `SELECT cardinality(pg_blocking_pids($1)) > 0`, pid).Scan(&blocked); err != nil {
			t.Fatal(err)
		}
		if blocked {
			return
		}
		select {
		case <-ticker.C:
		case <-ctx.Done():
			t.Fatal(ctx.Err())
		}
	}
}
