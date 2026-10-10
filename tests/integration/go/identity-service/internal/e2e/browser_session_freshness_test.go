package e2e

import (
	"context"
	"errors"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/tf4fun/antnest-platform/services/identity-service/internal/credentials"
	"github.com/tf4fun/antnest-platform/services/identity-service/internal/domain"
	"github.com/tf4fun/antnest-platform/services/identity-service/internal/localauth"
)

func TestBrowserResolutionUsesFreshClockAfterDatabaseRead(t *testing.T) {
	for _, lookup := range []string{"raw", "sid"} {
		for _, boundary := range []string{"idle", "absolute"} {
			t.Run(lookup+"/"+boundary, func(t *testing.T) {
				f, _, login, now := browserDeadlineFixture(t)
				deadline := now.Add(time.Second)
				idle, absolute := now.Add(time.Hour), now.Add(time.Hour)
				if boundary == "idle" {
					idle = deadline
				} else {
					absolute = deadline
				}
				if _, err := f.pool.Exec(t.Context(), `UPDATE api_tokens SET idle_expires_at = $2, expires_at = $3 WHERE id = $1`, login.TokenID, idle, absolute); err != nil {
					t.Fatal(err)
				}
				current := now
				f.clock = func() time.Time { return current }
				observed := false
				store := f.tracedStore(t, func(_ context.Context, _ *pgx.Conn, sql string) {
					if strings.Contains(sql, "FROM api_tokens") {
						observed = true
						// The SQL parameters were already captured at dispatch. By the
						// time the result can be used, the authority is exactly expired.
						current = deadline
					}
				})
				var err error
				if lookup == "raw" {
					_, err = store.LocalAuth().ResolveTokenSession(t.Context(), credentials.HashToken(login.AccessToken), now)
				} else {
					_, err = store.LocalAuth().ResolveSession(t.Context(), login.TokenID, now)
				}
				if !observed {
					t.Fatal("lookup did not reach the real token query")
				}
				if !errors.Is(err, domain.ErrNotFound) {
					t.Fatalf("post-read expiry = %v, want not found", err)
				}
			})
		}
	}
}

func TestBrowserLocalIssuanceDeadlineIncludesCredentialLockWait(t *testing.T) {
	for _, boundary := range []string{"idle", "absolute"} {
		t.Run(boundary, func(t *testing.T) {
			f, _, _, now := browserDeadlineFixture(t)
			var clock atomic.Int64
			clock.Store(now.UnixNano())
			f.clock = func() time.Time { return time.Unix(0, clock.Load()).UTC() }
			ctx, cancel := context.WithTimeout(t.Context(), 15*time.Second)
			var workers sync.WaitGroup
			defer func() { cancel(); workers.Wait() }()
			blocker, err := f.pool.Begin(ctx)
			if err != nil {
				t.Fatal(err)
			}
			defer func() { _ = blocker.Rollback(context.WithoutCancel(ctx)) }()
			if _, err := blocker.Exec(ctx, `SELECT id FROM users WHERE id = $1 FOR UPDATE`, f.user.User.ID); err != nil {
				t.Fatal(err)
			}
			pid := make(chan uint32, 1)
			var captured sync.Once
			store := f.tracedStore(t, func(_ context.Context, conn *pgx.Conn, sql string) {
				if strings.Contains(sql, "FROM users") && strings.Contains(sql, "FOR SHARE") {
					captured.Do(func() { pid <- conn.PgConn().PID() })
				}
			})
			absoluteTTL := time.Hour
			if boundary == "absolute" {
				absoluteTTL = time.Second
			} else if err := store.InitializeBrowserSessions(ctx, time.Second); err != nil {
				t.Fatal(err)
			}
			auth, err := localauth.NewService(store.LocalAuth(), f.newID, f.clock, absoluteTTL)
			if err != nil {
				t.Fatal(err)
			}
			type outcome struct {
				login localauth.LoginResult
				err   error
			}
			finished := make(chan outcome, 1)
			workers.Go(func() {
				login, err := auth.Login(ctx, localauth.LoginInput{OrganizationSlug: f.admin.Organization.Slug, Email: "member@example.com", Password: "correct horse battery staple"})
				finished <- outcome{login, err}
			})
			select {
			case id := <-pid:
				waitForDatabaseLock(t, ctx, f.pool, id)
			case result := <-finished:
				t.Fatalf("issuance did not wait for the credential lock: %v", result.err)
			case <-ctx.Done():
				t.Fatal(ctx.Err())
			}
			clock.Store(now.Add(time.Second).UnixNano())
			if err := blocker.Commit(ctx); err != nil {
				t.Fatal(err)
			}
			select {
			case result := <-finished:
				if !errors.Is(result.err, domain.ErrUnauthenticated) || result.login.AccessToken != "" {
					t.Fatalf("expired issuance returned credential=%t, error=%v", result.login.AccessToken != "", result.err)
				}
			case <-ctx.Done():
				t.Fatal(ctx.Err())
			}
			// The fixture's initial login is the only admitted token and issuance event.
			f.assertIssuanceCount(t, 1)
		})
	}
}

func TestBrowserLoginAdmitsOnlyLivePersistedTimestampPrecision(t *testing.T) {
	for _, boundary := range []string{"idle", "absolute"} {
		for _, precision := range []time.Duration{time.Nanosecond, time.Microsecond} {
			t.Run(boundary+"/"+precision.String(), func(t *testing.T) {
				f, _, _, now := browserDeadlineFixture(t)
				absoluteTTL, idleTTL := time.Hour, time.Hour
				if boundary == "idle" {
					idleTTL = precision
				} else {
					absoluteTTL = precision
				}
				if err := f.store.InitializeBrowserSessions(t.Context(), idleTTL); err != nil {
					t.Fatal(err)
				}
				auth, err := localauth.NewService(f.store.LocalAuth(), f.newID, f.clock, absoluteTTL)
				if err != nil {
					t.Fatal(err)
				}
				login, err := auth.Login(t.Context(), localauth.LoginInput{OrganizationSlug: f.admin.Organization.Slug, Email: "member@example.com", Password: "correct horse battery staple"})
				if precision == time.Nanosecond {
					if !errors.Is(err, domain.ErrUnauthenticated) || login.AccessToken != "" {
						t.Fatalf("unrepresentable live deadline issued secret=%t, error=%v", login.AccessToken != "", err)
					}
					f.assertIssuanceCount(t, 1)
				} else {
					if err != nil || login.AccessToken == "" || !login.ExpiresAt.After(now) || !login.IdleExpiresAt.After(now) {
						t.Fatalf("representable live deadline was not admitted: %v", err)
					}
					f.assertIssuanceCount(t, 2)
				}
			})
		}
	}
}
