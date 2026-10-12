package e2e

import (
	"context"
	"errors"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/multitracer"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/tf4fun/antnest-platform/services/identity-service/internal/browsersessions"
	"github.com/tf4fun/antnest-platform/services/identity-service/internal/callercontext"
	"github.com/tf4fun/antnest-platform/services/identity-service/internal/repository"
)

func TestBrowserPasswordFeedWaitCannotReturnExpiredReplacement(t *testing.T) {
	for _, deadline := range []string{"idle", "absolute"} {
		t.Run(deadline, func(t *testing.T) {
			f := newBrowserControlsFixture(t)
			idleTTL := 30 * time.Minute
			if deadline == "idle" {
				idleTTL = 5 * time.Second
			}
			if err := f.store.InitializeBrowserSessions(t.Context(), idleTTL); err != nil {
				t.Fatal(err)
			}
			login := f.login(t, "admission", "member@example.com")
			expires := f.clock().Add(5 * time.Second)
			if deadline == "absolute" {
				if _, err := f.pool.Exec(t.Context(), `UPDATE api_tokens SET expires_at = $2 WHERE id = $1`, login.TokenID, expires); err != nil {
					t.Fatal(err)
				}
			}
			ctx, cancel := context.WithTimeout(f.caller(t, login), 12*time.Second)
			var workers sync.WaitGroup
			defer func() { cancel(); workers.Wait() }()
			blocker, err := f.pool.Begin(ctx)
			if err != nil {
				t.Fatal(err)
			}
			defer func() { _ = blocker.Rollback(context.WithoutCancel(ctx)) }()
			if _, err := blocker.Exec(ctx, `LOCK TABLE session_revocations IN SHARE ROW EXCLUSIVE MODE`); err != nil {
				t.Fatal(err)
			}
			var original string
			if err := f.pool.QueryRow(ctx, `SELECT password_hash FROM local_credentials WHERE user_id = $1`, f.user.User.ID).Scan(&original); err != nil {
				t.Fatal(err)
			}
			pid := make(chan uint32, 1)
			var captured sync.Once
			store := f.tracedStore(t, func(_ context.Context, c *pgx.Conn, sql string) {
				if strings.Contains(sql, "LOCK TABLE session_revocations") {
					captured.Do(func() { pid <- c.PgConn().PID() })
				}
			})
			if err := store.InitializeBrowserSessions(ctx, idleTTL); err != nil {
				t.Fatal(err)
			}
			type outcome struct {
				result browsersessions.PasswordResult
				err    error
			}
			finished := make(chan outcome, 1)
			workers.Go(func() {
				result, err := browsersessions.NewService(store.BrowserSessions(), testPasswordEngine(t)).ChangePassword(ctx, browserPasswordInput(f))
				finished <- outcome{result, err}
			})
			select {
			case p := <-pid:
				assertBrowserBlocker(t, ctx, f, p, blocker.Conn().PgConn().PID())
			case r := <-finished:
				t.Fatalf("rotation bypassed feed writer wait: %v", r.err)
			case <-ctx.Done():
				t.Fatal(ctx.Err())
			}
			f.now.Store(expires.UnixNano())
			if err := blocker.Commit(ctx); err != nil {
				t.Fatal(err)
			}
			r := <-finished
			if !errors.Is(r.err, callercontext.ErrInvalid) || r.result.AccessToken != "" || r.result.TokenID != "" {
				t.Fatalf("feed wait returned expired replacement credential: %v", r.err)
			}
			var hash string
			var tokens, revoked, events int
			if err := f.pool.QueryRow(ctx, `SELECT password_hash, (SELECT count(*) FROM api_tokens), (SELECT count(*) FROM api_tokens WHERE revoked_at IS NOT NULL), (SELECT count(*) FROM session_revocations) FROM local_credentials WHERE user_id = $1`, f.user.User.ID).Scan(&hash, &tokens, &revoked, &events); err != nil {
				t.Fatal(err)
			}
			if hash != original || tokens != 1 || revoked != 0 || events != 0 {
				t.Fatal("expired replacement did not roll back the entire password transaction")
			}
		})
	}
}

type passwordCommitKey struct{}
type passwordCommitTracer struct{ after func() }

func (tracer passwordCommitTracer) TraceQueryStart(ctx context.Context, _ *pgx.Conn, data pgx.TraceQueryStartData) context.Context {
	return context.WithValue(ctx, passwordCommitKey{}, strings.EqualFold(strings.TrimSpace(data.SQL), "commit"))
}
func (tracer passwordCommitTracer) TraceQueryEnd(ctx context.Context, _ *pgx.Conn, data pgx.TraceQueryEndData) {
	if commit, _ := ctx.Value(passwordCommitKey{}).(bool); commit && data.Err == nil {
		tracer.after()
	}
}

func TestBrowserPasswordResponseChecksDeadlineAfterSuccessfulCommit(t *testing.T) {
	f := newBrowserControlsFixture(t)
	login := f.login(t, "admission", "member@example.com")
	expires := f.clock().Add(5 * time.Second)
	if _, err := f.pool.Exec(t.Context(), `UPDATE api_tokens SET expires_at = $2 WHERE id = $1`, login.TokenID, expires); err != nil {
		t.Fatal(err)
	}
	ctx := f.caller(t, login)
	config := f.pool.Config()
	commits := 0
	config.ConnConfig.Tracer = multitracer.New(config.ConnConfig.Tracer, passwordCommitTracer{after: func() { commits++; f.now.Store(expires.UnixNano()) }})
	pool, err := pgxpool.NewWithConfig(t.Context(), config)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)
	store, err := repository.New(pool, f.newID, f.clock)
	if err != nil {
		t.Fatal(err)
	}
	result, err := browsersessions.NewService(store.BrowserSessions(), testPasswordEngine(t)).ChangePassword(ctx, browserPasswordInput(f))
	if commits != 1 {
		t.Fatal("deadline probe did not run after the real password transaction committed")
	}
	if !errors.Is(err, callercontext.ErrInvalid) || result.AccessToken != "" || result.TokenID != "" {
		t.Fatalf("completed transaction returned an already-expired replacement: %v", err)
	}
	// The commit is durable; only the response is withheld. No rollback or
	// request-ID secret recovery is promised after this boundary.
	var tokens, revoked, events int
	if err := f.pool.QueryRow(ctx, `SELECT (SELECT count(*) FROM api_tokens), (SELECT count(*) FROM api_tokens WHERE revoked_at IS NOT NULL), (SELECT count(*) FROM session_revocations)`).Scan(&tokens, &revoked, &events); err != nil {
		t.Fatal(err)
	}
	if tokens != 2 || revoked != 1 || events != 1 {
		t.Fatal("postcommit expiry was incorrectly described as a rollback")
	}
}
