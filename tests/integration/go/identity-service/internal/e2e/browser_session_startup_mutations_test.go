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
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/tf4fun/antnest-platform/services/identity-service/internal/browsersessions"
	"github.com/tf4fun/antnest-platform/services/identity-service/internal/repository"
)

func TestBrowserStartupAndSessionMutationsUseOneTokenLockOrder(t *testing.T) {
	for _, mutation := range []string{"password", "bulk"} {
		for _, first := range []string{"startup", "mutation"} {
			t.Run(mutation+"/"+first+"-first", func(t *testing.T) {
				f := newBrowserControlsFixture(t)
				current := f.login(t, "admission", "member@example.com")
				if _, err := f.pool.Exec(t.Context(), `INSERT INTO api_tokens (id,public_session_id,token_hash,user_id,organization_id,membership_id,issued_at,expires_at,idle_expires_at,last_used_at) SELECT '000-first','startup-ordered-public','startup-ordered-hash',user_id,organization_id,membership_id,issued_at,expires_at,idle_expires_at,last_used_at FROM api_tokens WHERE id=$1`, current.TokenID); err != nil {
					t.Fatal(err)
				}
				ctx, cancel := context.WithTimeout(f.caller(t, current), 15*time.Second)
				var workers sync.WaitGroup
				defer func() { cancel(); workers.Wait() }()
				blocker, err := f.pool.Begin(ctx)
				if err != nil {
					t.Fatal(err)
				}
				defer func() { _ = blocker.Rollback(context.WithoutCancel(ctx)) }()
				if _, err := blocker.Exec(ctx, `SELECT id FROM api_tokens WHERE id=$1 FOR UPDATE`, current.TokenID); err != nil {
					t.Fatal(err)
				}
				newStore := func() (*repository.Store, <-chan uint32) {
					config := f.pool.Config()
					config.ConnConfig.RuntimeParams["enable_indexscan"], config.ConnConfig.RuntimeParams["enable_bitmapscan"] = "off", "off"
					pid := make(chan uint32, 1)
					var captured sync.Once
					config.ConnConfig.Tracer = multitracer.New(admissionQueryTracer{before: func(_ context.Context, conn *pgx.Conn, sql string) {
						if strings.Contains(sql, "SELECT id FROM api_tokens") && strings.Contains(sql, "FOR UPDATE") {
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
				startup, startupPID := newStore()
				changing, changingPID := newStore()
				started, changed := make(chan error, 1), make(chan error, 1)
				var replacement browsersessions.PasswordResult
				var revocation browsersessions.RevokeResult
				startStartup := func() { workers.Go(func() { started <- startup.InitializeBrowserSessions(ctx, 5*time.Second) }) }
				startMutation := func() {
					workers.Go(func() {
						var err error
						service := browsersessions.NewService(changing.BrowserSessions())
						if mutation == "password" {
							replacement, err = service.ChangePassword(ctx, browserPasswordInput(f))
						} else {
							revocation, err = service.Revoke(ctx, browsersessions.RevokeInput{RequestID: "startup-overlap", ActorPrincipalID: f.user.User.ID, UserID: f.user.User.ID, Scope: "self", Mode: "all"})
						}
						changed <- err
					})
				}
				firstPID, secondPID := startupPID, changingPID
				if first == "startup" {
					startStartup()
				} else {
					firstPID, secondPID = changingPID, startupPID
					startMutation()
				}
				firstWaiting := awaitBrowserPID(t, ctx, firstPID)
				assertBrowserBlocker(t, ctx, f, firstWaiting, blocker.Conn().PgConn().PID())
				// Before the second worker exists, only the first can own this
				// smaller row. A queued waiter alone does not prove lock order.
				_, err = f.pool.Exec(ctx, `SELECT id FROM api_tokens WHERE id='000-first' FOR UPDATE NOWAIT`)
				var lockErr *pgconn.PgError
				if !errors.As(err, &lockErr) || lockErr.Code != "55P03" {
					t.Fatalf("first worker did not hold the smaller token row: %v", err)
				}
				if first == "startup" {
					startMutation()
				} else {
					startStartup()
				}
				assertBrowserBlocker(t, ctx, f, awaitBrowserPID(t, ctx, secondPID), firstWaiting)
				if err := blocker.Rollback(ctx); err != nil {
					t.Fatal(err)
				}
				if err := <-started; err != nil {
					t.Fatalf("startup could not commit: %v", err)
				}
				if err := <-changed; err != nil {
					t.Fatalf("session mutation could not commit: %v", err)
				}
				if mutation == "password" {
					if replacement.AccessToken == "" || !replacement.ExpiresAt.Equal(current.ExpiresAt) {
						t.Fatal("startup overlap lost the password replacement")
					}
					if _, err := f.auth.Resolve(ctx, replacement.AccessToken); err != nil {
						t.Fatalf("startup revoked the new replacement: %v", err)
					}
				} else if revocation.RevokedCount != 2 || !revocation.CurrentRevoked {
					t.Fatal("startup overlap lost bulk revocation")
				}
				var revoked, events int
				if err := f.pool.QueryRow(ctx, `SELECT (SELECT count(*) FROM api_tokens WHERE revoked_at IS NOT NULL),(SELECT count(*) FROM session_revocations)`).Scan(&revoked, &events); err != nil {
					t.Fatal(err)
				}
				if revoked != 2 || events != 2 {
					t.Fatal("startup overlap lost committed token/feed effects")
				}
			})
		}
	}
}
