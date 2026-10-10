package e2e

import (
	"context"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/tf4fun/antnest-platform/services/identity-service/internal/credentials"
	"github.com/tf4fun/antnest-platform/services/identity-service/internal/domain"
	"github.com/tf4fun/antnest-platform/services/identity-service/internal/oidcflow"
)

func TestOIDCBrowserWorkflowDeadlineIncludesTokenInsertionWait(t *testing.T) {
	f := browserOIDCFixture(t)
	input := f.start(t)
	ctx, cancel := context.WithTimeout(t.Context(), 15*time.Second)
	var workers sync.WaitGroup
	defer func() { cancel(); workers.Wait() }()
	if _, err := f.pool.Exec(ctx, `
		CREATE FUNCTION block_browser_insert() RETURNS trigger LANGUAGE plpgsql AS $$
		BEGIN
		  PERFORM pg_advisory_xact_lock(580071, 1);
		  RETURN NEW;
		END $$;
		CREATE TRIGGER block_browser_insert BEFORE INSERT ON api_tokens
		FOR EACH ROW EXECUTE FUNCTION block_browser_insert()`); err != nil {
		t.Fatal(err)
	}
	blocker, err := f.pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = blocker.Rollback(context.WithoutCancel(ctx)) }()
	if _, err := blocker.Exec(ctx, `SELECT pg_advisory_xact_lock(580071, 1)`); err != nil {
		t.Fatal(err)
	}
	var expires time.Time
	if err := f.pool.QueryRow(ctx, `SELECT expires_at FROM oidc_auth_sessions WHERE state_hash = $1`, credentials.HashToken(input.State)).Scan(&expires); err != nil {
		t.Fatal(err)
	}
	pid := make(chan uint32, 1)
	var captured sync.Once
	f.repository.Repository = f.tracedStore(t, func(_ context.Context, conn *pgx.Conn, sql string) {
		if strings.Contains(sql, "INSERT INTO api_tokens") {
			captured.Do(func() { pid <- conn.PgConn().PID() })
		}
	}).OIDC()
	type outcome struct {
		result oidcflow.CompleteLoginResult
		err    error
	}
	finished := make(chan outcome, 1)
	workers.Go(func() { result, err := f.flow.CompleteLogin(ctx, input); finished <- outcome{result, err} })
	select {
	case id := <-pid:
		waitForDatabaseLock(t, ctx, f.pool, id)
		var blocked bool
		if err := f.pool.QueryRow(ctx, `SELECT $1::integer = ANY(pg_blocking_pids($2))`, blocker.Conn().PgConn().PID(), id).Scan(&blocked); err != nil || !blocked {
			t.Fatalf("token INSERT did not block on the trigger's transaction: %v", err)
		}
	case result := <-finished:
		t.Fatalf("OIDC bypassed the token INSERT blocker: %v", result.err)
	case <-ctx.Done():
		t.Fatal(ctx.Err())
	}
	// Only the short OIDC workflow expires. Both browser deadlines remain live.
	f.now.Store(expires.UnixNano())
	if err := blocker.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	select {
	case result := <-finished:
		if code, _, _ := domain.ErrorDetails(result.err); code != "oidc_session_expired" || result.result.AccessToken != "" || result.result.TokenID != "" {
			t.Fatalf("expired login workflow issued a credential after INSERT wait: %v", result.err)
		}
	case <-ctx.Done():
		t.Fatal(ctx.Err())
	}
	var status, stage string
	var tokens, links, completed int
	if err := f.pool.QueryRow(ctx, `SELECT status, failure_stage,
		(SELECT count(*) FROM api_tokens), (SELECT count(*) FROM external_identities),
		(SELECT count(*) FROM identity_events WHERE event_type = 'oidc_login.completed')
		FROM oidc_auth_sessions WHERE state_hash = $1`, credentials.HashToken(input.State)).Scan(&status, &stage, &tokens, &links, &completed); err != nil {
		t.Fatal(err)
	}
	if status != "failed" || stage != "expired" || tokens != 0 || links != 0 || completed != 0 || f.idp.ExchangeCount() != 1 {
		t.Fatal("expired insertion failed to roll back issuance/link or persist terminal workflow failure")
	}
}
