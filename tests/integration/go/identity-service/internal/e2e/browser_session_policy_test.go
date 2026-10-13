package e2e

import (
	"context"
	"errors"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/tf4fun/antnest-platform/services/identity-service/internal/localauth"
	"github.com/tf4fun/antnest-platform/services/identity-service/internal/repository"
)

func browserPolicyLogin(t *testing.T, store *repository.Store, fixture localAdmissionFixture) localauth.LoginResult {
	t.Helper()
	auth, err := localauth.NewService(t.Context(), store.LocalAuth(), fixture.newID, fixture.clock, time.Hour, testPasswordEngine(t))
	if err != nil {
		t.Fatal(err)
	}
	result, err := auth.Login(t.Context(), localauth.LoginInput{
		RequestID: "policy-login", OrganizationSlug: fixture.admin.Organization.Slug,
		Email: "member@example.com", Password: "correct horse battery staple",
	})
	if err != nil {
		t.Fatal(err)
	}
	return result
}

func assertBrowserIdle(t *testing.T, fixture localAdmissionFixture, tokenID string, want time.Time) {
	t.Helper()
	var got time.Time
	if err := fixture.pool.QueryRow(t.Context(), `SELECT idle_expires_at FROM api_tokens WHERE id = $1`, tokenID).Scan(&got); err != nil {
		t.Fatal(err)
	}
	if !got.Equal(want) {
		t.Fatalf("idle deadline = %s, want %s", got, want)
	}
}

func TestBrowserStartupPolicyClampsExistingAndNewSessions(t *testing.T) {
	f, _, initial, now := browserDeadlineFixture(t)
	for _, invalid := range []time.Duration{0, -time.Second} {
		if err := f.store.InitializeBrowserSessions(t.Context(), invalid); err == nil {
			t.Fatal("invalid startup idle policy accepted")
		}
	}
	if err := f.store.InitializeBrowserSessions(t.Context(), 5*time.Second); err != nil {
		t.Fatal(err)
	}
	assertBrowserIdle(t, f, initial.TokenID, now.Add(5*time.Second))
	if err := f.store.InitializeBrowserSessions(t.Context(), 5*time.Second); err != nil {
		t.Fatalf("same startup policy is not idempotent: %v", err)
	}
	if err := f.store.InitializeBrowserSessions(t.Context(), 10*time.Second); err == nil {
		t.Fatal("a successfully initialized Store changed its policy at runtime")
	}
	created := browserPolicyLogin(t, f.store, f)
	assertBrowserIdle(t, f, created.TokenID, now.Add(5*time.Second))
	if !created.IdleExpiresAt.Equal(now.Add(5*time.Second)) || created.ActivityIntervalMS != 1666 {
		t.Fatalf("new credential policy: idle=%s interval=%d", created.IdleExpiresAt, created.ActivityIntervalMS)
	}
}

func TestBrowserRestartCannotReviveOrExtendStoredDeadlines(t *testing.T) {
	f, _, initial, now := browserDeadlineFixture(t)
	revoked := now.Add(-time.Second)
	tests := []struct {
		id                             string
		idle, absolute, activity, want time.Time
		revoked                        *time.Time
	}{
		{id: "long", idle: now.Add(20 * time.Minute), absolute: now.Add(time.Hour), activity: now, want: now.Add(5 * time.Second)},
		{id: "short", idle: now.Add(2 * time.Second), absolute: now.Add(time.Hour), activity: now, want: now.Add(2 * time.Second)},
		{id: "idle-expired", idle: now.Add(-time.Second), absolute: now.Add(time.Hour), activity: now, want: now.Add(-time.Second)},
		{id: "absolute-expired", idle: now.Add(time.Hour), absolute: now.Add(-2 * time.Second), activity: now, want: now.Add(-2 * time.Second)},
		{id: "old-activity", idle: now.Add(time.Hour), absolute: now.Add(time.Hour), activity: now.Add(-time.Minute), want: now.Add(-55 * time.Second)},
		{id: "revoked", idle: now.Add(20 * time.Minute), absolute: now.Add(time.Hour), activity: now, want: now.Add(20 * time.Minute), revoked: &revoked},
	}
	for _, test := range tests {
		if _, err := f.pool.Exec(t.Context(), `
			INSERT INTO api_tokens (id, public_session_id, token_hash, user_id, organization_id, membership_id, kind, issued_at, expires_at, idle_expires_at, last_used_at, revoked_at)
			SELECT $1, $1 || '-public', $1 || '-hash', user_id, organization_id, membership_id, 'browser', issued_at, $3, $4, $5, $6
			FROM api_tokens WHERE id = $2`, test.id, initial.TokenID, test.absolute, test.idle, test.activity, test.revoked); err != nil {
			t.Fatal(err)
		}
	}
	for _, ttl := range []time.Duration{5 * time.Second, 2 * time.Hour} {
		restarted, err := repository.New(f.pool, f.newID, f.clock)
		if err != nil {
			t.Fatal(err)
		}
		if err := restarted.InitializeBrowserSessions(t.Context(), ttl); err != nil {
			t.Fatal(err)
		}
		for _, test := range tests {
			assertBrowserIdle(t, f, test.id, test.want)
			var publicID string
			var absolute, activity time.Time
			var revokedAt *time.Time
			if err := f.pool.QueryRow(t.Context(), `SELECT public_session_id, expires_at, last_used_at, revoked_at FROM api_tokens WHERE id = $1`, test.id).Scan(&publicID, &absolute, &activity, &revokedAt); err != nil {
				t.Fatal(err)
			}
			if publicID != test.id+"-public" || !absolute.Equal(test.absolute) || !activity.Equal(test.activity) || (revokedAt == nil) != (test.revoked == nil) || revokedAt != nil && !revokedAt.Equal(*test.revoked) {
				t.Fatal("startup changed public references, absolute authority or prior revocation")
			}
		}
		created := browserPolicyLogin(t, restarted, f)
		wantIdle := now.Add(min(ttl, time.Hour))
		assertBrowserIdle(t, f, created.TokenID, wantIdle)
		wantInterval := 1666
		if ttl == 2*time.Hour {
			wantInterval = 30000
		}
		if !created.ExpiresAt.Equal(now.Add(time.Hour)) || !created.IdleExpiresAt.Equal(wantIdle) || created.ActivityIntervalMS != wantInterval {
			t.Fatal("new session did not clip the restarted idle policy to its original absolute lifetime")
		}
	}
}

func TestBrowserStartupCancellationDoesNotPublishPolicyAndCanRetry(t *testing.T) {
	f, _, initial, now := browserDeadlineFixture(t)
	// An implementation that commits each row independently must not pass by
	// encountering the blocked row before it has made any visible changes.
	const firstID = "000-before-blocked"
	if _, err := f.pool.Exec(t.Context(), `
		INSERT INTO api_tokens (id, public_session_id, token_hash, user_id, organization_id, membership_id, kind, issued_at, expires_at, idle_expires_at, last_used_at)
		SELECT $1, $1 || '-public', $1 || '-hash', user_id, organization_id, membership_id, kind, issued_at, expires_at, idle_expires_at, last_used_at
		FROM api_tokens WHERE id = $2`, firstID, initial.TokenID); err != nil {
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
	pid := make(chan uint32, 1)
	var captured sync.Once
	store := f.tracedStore(t, func(_ context.Context, conn *pgx.Conn, sql string) {
		if strings.Contains(sql, "FROM api_tokens") && strings.Contains(sql, "FOR UPDATE") {
			captured.Do(func() { pid <- conn.PgConn().PID() })
		}
	})
	initCtx, cancelInit := context.WithCancel(ctx)
	defer cancelInit()
	finished := make(chan error, 1)
	workers.Go(func() { finished <- store.InitializeBrowserSessions(initCtx, 5*time.Second) })
	select {
	case id := <-pid:
		waitForDatabaseLock(t, ctx, f.pool, id)
	case err := <-finished:
		t.Fatalf("startup did not wait for the token row: %v", err)
	case <-ctx.Done():
		t.Fatal(ctx.Err())
	}
	cancelInit()
	select {
	case err := <-finished:
		if !errors.Is(err, context.Canceled) {
			t.Fatalf("cancelled initialization error = %v", err)
		}
	case <-ctx.Done():
		t.Fatal(ctx.Err())
	}
	if err := blocker.Rollback(ctx); err != nil {
		t.Fatal(err)
	}
	assertBrowserIdle(t, f, initial.TokenID, now.Add(30*time.Minute))
	assertBrowserIdle(t, f, firstID, now.Add(30*time.Minute))
	beforeRetry := browserPolicyLogin(t, store, f)
	assertBrowserIdle(t, f, beforeRetry.TokenID, now.Add(30*time.Minute))
	if err := store.InitializeBrowserSessions(ctx, 5*time.Second); err != nil {
		t.Fatal(err)
	}
	afterRetry := browserPolicyLogin(t, store, f)
	assertBrowserIdle(t, f, afterRetry.TokenID, now.Add(5*time.Second))
}
