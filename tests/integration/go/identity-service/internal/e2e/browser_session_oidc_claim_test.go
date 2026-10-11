package e2e

import (
	"context"
	"fmt"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/tf4fun/antnest-platform/services/identity-service/internal/credentials"
	"github.com/tf4fun/antnest-platform/services/identity-service/internal/oidcflow"
)

func TestOIDCBrowserClaimRechecksWorkflowExpiryAfterStateLock(t *testing.T) {
	for _, status := range []string{"pending", "exchanging"} {
		t.Run(status, func(t *testing.T) {
			f := browserOIDCFixture(t)
			input := f.start(t)
			hash := credentials.HashToken(input.State)
			if status == "exchanging" {
				if _, err := f.store.OIDC().ClaimSession(t.Context(), hash, "first-claim", f.time()); err != nil {
					t.Fatal(err)
				}
			}
			ctx, cancel := context.WithTimeout(t.Context(), 15*time.Second)
			var workers sync.WaitGroup
			defer func() { cancel(); workers.Wait() }()
			blocker, err := f.pool.Begin(ctx)
			if err != nil {
				t.Fatal(err)
			}
			defer func() { _ = blocker.Rollback(context.WithoutCancel(ctx)) }()
			var expires time.Time
			var blockerPID uint32
			if err := blocker.QueryRow(ctx, `SELECT expires_at, pg_backend_pid() FROM oidc_auth_sessions WHERE state_hash = $1 FOR UPDATE`, hash).Scan(&expires, &blockerPID); err != nil {
				t.Fatal(err)
			}
			pid := make(chan uint32, 1)
			var captured sync.Once
			store := f.tracedStore(t, func(_ context.Context, conn *pgx.Conn, sql string) {
				if strings.Contains(sql, "FROM oidc_auth_sessions") && strings.Contains(sql, "FOR UPDATE") {
					captured.Do(func() { pid <- conn.PgConn().PID() })
				}
			})
			type outcome struct {
				claim oidcflow.SessionClaim
				err   error
			}
			finished := make(chan outcome, 1)
			observed := f.time()
			workers.Go(func() {
				claim, err := store.OIDC().ClaimSession(ctx, hash, "late-claim", observed)
				finished <- outcome{claim, err}
			})
			select {
			case id := <-pid:
				waitForDatabaseLock(t, ctx, f.pool, id)
				var blocked bool
				if err := f.pool.QueryRow(ctx, `SELECT $1::integer = ANY(pg_blocking_pids($2))`, blockerPID, id).Scan(&blocked); err != nil || !blocked {
					t.Fatalf("claim did not reach the original state lock: %v", err)
				}
			case result := <-finished:
				t.Fatalf("claim bypassed state lock: %v", result.err)
			case <-ctx.Done():
				t.Fatal(ctx.Err())
			}
			f.now.Store(expires.UnixNano())
			if err := blocker.Commit(ctx); err != nil {
				t.Fatal(err)
			}
			select {
			case result := <-finished:
				if result.err != nil || result.claim.Disposition != oidcflow.ClaimExpired {
					t.Fatalf("post-lock expired workflow was not terminalized: disposition=%s error=%v", result.claim.Disposition, result.err)
				}
			case <-ctx.Done():
				t.Fatal(ctx.Err())
			}
			var storedStatus, stage string
			var expiredEvents, claimedEvents, tokens int
			if err := f.pool.QueryRow(ctx, `
				SELECT status, failure_stage,
				 (SELECT count(*) FROM identity_events WHERE event_type = 'oidc_login.expired'),
				 (SELECT count(*) FROM identity_events WHERE event_type = 'oidc_login.claimed'),
				 (SELECT count(*) FROM api_tokens)
				FROM oidc_auth_sessions WHERE state_hash = $1`, hash).Scan(&storedStatus, &stage, &expiredEvents, &claimedEvents, &tokens); err != nil {
				t.Fatal(err)
			}
			wantClaims := 0
			if status == "exchanging" {
				wantClaims = 1
			}
			if storedStatus != "failed" || stage != "expired" || expiredEvents != 1 || claimedEvents != wantClaims || tokens != 0 || f.idp.ExchangeCount() != 0 {
				t.Fatal("expired workflow acquired a claim, exchanged credentials or missed durable terminalization")
			}
		})
	}
}

func TestBrowserStartupPublishesPolicyWithoutBlockingLiveReads(t *testing.T) {
	f := browserOIDCFixture(t)
	input := f.start(t)
	initial, err := f.flow.CompleteLogin(t.Context(), input)
	if err != nil {
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
	var blockerPID uint32
	if err := blocker.QueryRow(ctx, `SELECT pg_backend_pid() FROM api_tokens WHERE id = $1 FOR UPDATE`, initial.TokenID).Scan(&blockerPID); err != nil {
		t.Fatal(err)
	}
	pid := make(chan uint32, 1)
	var captured sync.Once
	store := f.tracedStore(t, func(_ context.Context, conn *pgx.Conn, sql string) {
		if strings.Contains(sql, "FROM api_tokens") && strings.Contains(sql, "FOR UPDATE") {
			captured.Do(func() { pid <- conn.PgConn().PID() })
		}
	})
	// Both initialization and replay must use this exact Store; another Store
	// would bypass a shared policy mutex and make the deadlock regression vacuous.
	f.repository.Repository = store.OIDC()
	initialized := make(chan error, 1)
	workers.Go(func() { initialized <- store.InitializeBrowserSessions(ctx, 5*time.Second) })
	select {
	case id := <-pid:
		waitForDatabaseLock(t, ctx, f.pool, id)
		var blocked bool
		if err := f.pool.QueryRow(ctx, `SELECT $1::integer = ANY(pg_blocking_pids($2))`, blockerPID, id).Scan(&blocked); err != nil || !blocked {
			t.Fatalf("startup bypassed token blocker: %v", err)
		}
	case err := <-initialized:
		t.Fatalf("startup did not wait for token lock: %v", err)
	case <-ctx.Done():
		t.Fatal(ctx.Err())
	}
	type outcome struct {
		result oidcflow.CompleteLoginResult
		err    error
	}
	read := make(chan outcome, 1)
	workers.Go(func() {
		resolved, err := store.LocalAuth().ResolveSession(ctx, initial.TokenID, f.time())
		if err != nil {
			read <- outcome{err: err}
			return
		}
		if resolved.ActivityIntervalMS != 30000 || !resolved.IdleExpiresAt.Equal(initial.IdleExpiresAt) {
			read <- outcome{err: fmt.Errorf("live lookup observed uncommitted policy")}
			return
		}
		result, err := f.flow.CompleteLogin(ctx, input)
		read <- outcome{result, err}
	})
	readDeadline := time.NewTimer(2 * time.Second)
	defer readDeadline.Stop()
	select {
	case result := <-read:
		if result.err != nil || result.result.ActivityIntervalMS != 30000 || !result.result.IdleExpiresAt.Equal(initial.IdleExpiresAt) || result.result.AccessToken != "" || !result.result.AlreadyCompleted {
			t.Fatalf("non-touch replay observed pending policy or failed: %v", result.err)
		}
	case <-readDeadline.C:
		t.Fatal("configuration lock blocked a live read behind startup's database wait")
	case <-ctx.Done():
		t.Fatal(ctx.Err())
	}
	if err := blocker.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	select {
	case err := <-initialized:
		if err != nil {
			t.Fatal(err)
		}
	case <-ctx.Done():
		t.Fatal(ctx.Err())
	}
	after, err := f.flow.CompleteLogin(ctx, input)
	if err != nil || after.ActivityIntervalMS != 1666 || !after.IdleExpiresAt.Equal(f.time().Add(5*time.Second).Truncate(time.Microsecond)) || after.AccessToken != "" {
		t.Fatalf("committed startup policy was not published with its stored deadline: %v", err)
	}
}
