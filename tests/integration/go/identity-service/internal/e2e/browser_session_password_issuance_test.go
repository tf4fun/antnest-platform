package e2e

import (
	"context"
	"errors"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/tf4fun/antnest-platform/services/identity-service/internal/browsersessions"
	"github.com/tf4fun/antnest-platform/services/identity-service/internal/domain"
	"github.com/tf4fun/antnest-platform/services/identity-service/internal/localauth"
	"github.com/tf4fun/antnest-platform/services/identity-service/internal/repository"
)

func TestBrowserPasswordAndIssuanceShareParentOrder(t *testing.T) {
	for _, kind := range []string{"local", "oidc"} {
		for _, ordering := range []string{"password-first", "login-first"} {
			t.Run(kind+"/"+ordering, func(t *testing.T) {
				var f browserControlsFixture
				type loginOutcome struct {
					raw, id string
					err     error
				}
				var loginOperation func(context.Context, *repository.Store) loginOutcome
				if kind == "oidc" {
					oidc := browserOIDCFixture(t)
					f = browserControlsForFixture(t, oidc.localAdmissionFixture, &oidc.now)
					input := oidc.start(t)
					loginOperation = func(ctx context.Context, store *repository.Store) loginOutcome {
						oidc.repository.Repository = store.OIDC()
						result, err := oidc.flow.CompleteLogin(ctx, input)
						return loginOutcome{result.AccessToken, result.TokenID, err}
					}
				} else {
					f = newBrowserControlsFixture(t)
					loginOperation = func(ctx context.Context, store *repository.Store) loginOutcome {
						auth, err := localauth.NewService(t.Context(), store.LocalAuth(), f.newID, f.clock, time.Hour, testPasswordEngine(t))
						if err != nil {
							return loginOutcome{err: err}
						}
						result, err := auth.Login(ctx, localauth.LoginInput{RequestID: "overlap-login", OrganizationSlug: "admission", Email: "member@example.com", Password: "correct horse battery staple"})
						return loginOutcome{result.AccessToken, result.TokenID, err}
					}
				}
				current := f.login(t, "admission", "member@example.com")
				ctx, cancel := context.WithTimeout(f.caller(t, current), 15*time.Second)
				var workers sync.WaitGroup
				defer func() { cancel(); workers.Wait() }()
				blocker, err := f.pool.Begin(ctx)
				if err != nil {
					t.Fatal(err)
				}
				defer func() { _ = blocker.Rollback(context.WithoutCancel(ctx)) }()
				blockSQL, blockID := `SELECT id FROM users WHERE id = $1 FOR UPDATE`, f.user.User.ID
				if ordering == "login-first" {
					blockSQL, blockID = `SELECT id FROM organizations WHERE id = $1 FOR UPDATE`, f.admin.Organization.ID
				}
				if _, err := blocker.Exec(ctx, blockSQL, blockID); err != nil {
					t.Fatal(err)
				}
				traced := func(marker string) (*repository.Store, <-chan uint32) {
					pid := make(chan uint32, 1)
					var captured sync.Once
					store := f.tracedStore(t, func(_ context.Context, c *pgx.Conn, sql string) {
						if strings.Contains(sql, marker) && (strings.Contains(sql, "FOR UPDATE") || strings.Contains(sql, "FOR SHARE") || strings.Contains(sql, "INSERT INTO credential_attempts")) {
							captured.Do(func() { pid <- c.PgConn().PID() })
						}
					})
					return store, pid
				}
				loginMarker := "FROM users"
				passwordMarker := "FROM users"
				if ordering == "login-first" {
					loginMarker = "FROM organizations"
				}
				if kind == "local" {
					// Local login and password change share the organization bucket
					// before either reaches its User lock.
					if ordering == "login-first" {
						passwordMarker = "INSERT INTO credential_attempts"
					} else {
						loginMarker = "INSERT INTO credential_attempts"
					}
				}
				loginStore, loginPID := traced(loginMarker)
				passwordStore, passwordPID := traced(passwordMarker)
				loginDone := make(chan loginOutcome, 1)
				type passwordOutcome struct {
					result browsersessions.PasswordResult
					err    error
				}
				passwordDone := make(chan passwordOutcome, 1)
				startLogin := func() { workers.Go(func() { loginDone <- loginOperation(ctx, loginStore) }) }
				startPassword := func() {
					workers.Go(func() {
						result, err := browsersessions.NewService(passwordStore.BrowserSessions(), testPasswordEngine(t)).ChangePassword(ctx, browserPasswordInput(f))
						passwordDone <- passwordOutcome{result, err}
					})
				}
				firstPID, secondPID := passwordPID, loginPID
				if ordering == "password-first" {
					startPassword()
				} else {
					firstPID, secondPID = loginPID, passwordPID
					startLogin()
				}
				var first uint32
				select {
				case first = <-firstPID:
					assertBrowserBlocker(t, ctx, f, first, blocker.Conn().PgConn().PID())
				case <-ctx.Done():
					t.Fatal(ctx.Err())
				}
				if ordering == "password-first" {
					startLogin()
				} else {
					startPassword()
				}
				select {
				case second := <-secondPID:
					waitForDatabaseLock(t, ctx, f.pool, second)
					var actual bool
					if ordering == "login-first" {
						if err := f.pool.QueryRow(ctx, `SELECT $1::integer = ANY(pg_blocking_pids($2))`, first, second).Scan(&actual); err != nil || !actual {
							t.Fatalf("password did not wait on login's held admission or User lock: %v", err)
						}
					} else if err := f.pool.QueryRow(ctx, `SELECT $1::integer = ANY(pg_blocking_pids($3)) OR $2::integer = ANY(pg_blocking_pids($3))`, blocker.Conn().PgConn().PID(), first, second).Scan(&actual); err != nil || !actual {
						t.Fatalf("login did not queue after password on target admission or User lock: %v", err)
					}
				case <-ctx.Done():
					t.Fatal(ctx.Err())
				}
				if err := blocker.Commit(ctx); err != nil {
					t.Fatal(err)
				}
				password, login := <-passwordDone, <-loginDone
				if password.err != nil || password.result.AccessToken == "" {
					t.Fatalf("overlapping password mutation did not commit: %v", password.err)
				}
				wantRevoked := 1
				if kind == "local" && ordering == "password-first" {
					if !errors.Is(login.err, domain.ErrUnauthenticated) || login.raw != "" {
						t.Fatalf("old password snapshot issued after rotation: %v", login.err)
					}
				} else {
					if login.err != nil || login.raw == "" {
						t.Fatalf("ordered login failed: %v", login.err)
					}
					_, err := f.auth.Resolve(ctx, login.raw)
					if ordering == "login-first" {
						wantRevoked = 2
						if !errors.Is(err, domain.ErrUnauthenticated) {
							t.Fatal("password omitted the earlier concurrent issuance")
						}
					} else if err != nil {
						t.Fatalf("later OIDC authentication did not get fresh authority: %v", err)
					}
				}
				if _, err := f.auth.Resolve(ctx, password.result.AccessToken); err != nil {
					t.Fatalf("replacement did not remain live after overlap: %v", err)
				}
				if _, err := f.auth.Resolve(ctx, current.AccessToken); !errors.Is(err, domain.ErrUnauthenticated) {
					t.Fatal("password overlap retained the original session")
				}
				var revoked, events int
				if err := f.pool.QueryRow(ctx, `SELECT (SELECT count(*) FROM api_tokens WHERE revoked_at IS NOT NULL), (SELECT count(*) FROM session_revocations WHERE reason = 'password_changed')`).Scan(&revoked, &events); err != nil {
					t.Fatal(err)
				}
				if revoked != wantRevoked || events != wantRevoked {
					t.Fatal("overlapping issuance lost atomic all-session revocation")
				}
			})
		}
	}
}
