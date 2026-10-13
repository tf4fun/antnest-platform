package e2e

import (
	"context"
	"errors"
	"net"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/multitracer"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/tf4fun/antnest-platform/services/identity-service/internal/browsersessions"
	"github.com/tf4fun/antnest-platform/services/identity-service/internal/callercontext"
	"github.com/tf4fun/antnest-platform/services/identity-service/internal/domain"
	"github.com/tf4fun/antnest-platform/services/identity-service/internal/repository"
)

func TestBrowserPasswordAttemptsLostCommitAcknowledgementDoesNotReplayOrExposeCredentials(t *testing.T) {
	for _, success := range []bool{false, true} {
		name := "failed-guess"
		if success {
			name = "successful-rotation"
		}
		t.Run(name, func(t *testing.T) {
			f := newBrowserControlsFixture(t)
			login := f.login(t, "admission", "member@example.com")
			ctx, cancel := context.WithTimeout(f.caller(t, login), 10*time.Second)
			defer cancel()
			input := browserPasswordInput(f)
			input.CurrentPassword = "incorrect current password"
			if _, err := f.service.ChangePassword(ctx, input); !errors.Is(err, domain.ErrInvalidCurrentPassword) {
				t.Fatal(err)
			}
			original, err := f.store.Directory().GetLocalCredential(ctx, f.user.User.ID)
			if err != nil {
				t.Fatal(err)
			}
			// Reuse the real PostgreSQL protocol fault: consume COMMIT's response
			// and close the socket before pgx can observe the acknowledgement.
			fault := &localLoginCommitFault{}
			config := f.pool.Config()
			config.MaxConns, config.MinConns = 1, 0
			config.ConnConfig.Tracer = fault
			dial := config.ConnConfig.DialFunc
			config.ConnConfig.DialFunc = func(ctx context.Context, network, address string) (net.Conn, error) {
				connection, err := dial(ctx, network, address)
				if err != nil {
					return nil, err
				}
				return &lostLocalLoginCommitConn{Conn: connection, fault: fault}, nil
			}
			pool, err := pgxpool.NewWithConfig(t.Context(), config)
			if err != nil {
				t.Fatal(err)
			}
			t.Cleanup(pool.Close)
			store, err := repository.New(pool, f.newID, f.clock)
			if err != nil {
				t.Fatal(err)
			}
			passwords := &loginPasswordProbe{LoginPasswords: testPasswordEngine(t)}
			if success {
				input = browserPasswordInput(f)
			}
			result, err := browsersessions.NewService(store.BrowserSessions(), passwords).ChangePassword(ctx, input)
			code, _, _ := domain.ErrorDetails(err)
			if err == nil || code != "internal_error" || result != (browsersessions.PasswordResult{}) || !fault.observedCommit.Load() || fault.begins.Load() != 1 || fault.commits.Load() != 1 || passwords.verifications.Load() != 1 {
				t.Fatalf("lost password ACK exposed a result, replayed, or became a confirmed denial: begins=%d commits=%d error=%v", fault.begins.Load(), fault.commits.Load(), err)
			}
			var userFailures, organizationFailures, tokens, revoked, events int
			var hash string
			if err := f.pool.QueryRow(t.Context(), `SELECT
				(SELECT failures FROM credential_attempts WHERE scope='password_change_user'),
				(SELECT failures FROM credential_attempts WHERE scope='organization'),
				(SELECT count(*) FROM api_tokens),
				(SELECT count(*) FROM api_tokens WHERE revoked_at IS NOT NULL),
				(SELECT count(*) FROM session_revocations),
				(SELECT password_hash FROM local_credentials WHERE user_id=$1)`, f.user.User.ID).
				Scan(&userFailures, &organizationFailures, &tokens, &revoked, &events, &hash); err != nil {
				t.Fatal(err)
			}
			if success {
				valid, err := testPasswordEngine(t).VerifyPassword(t.Context(), hash, input.NewPassword)
				if err != nil || !valid || hash == original.PasswordHash || userFailures != 0 || organizationFailures != 1 || tokens != 2 || revoked != 1 || events != 1 || passwords.hashes.Load() != 1 {
					t.Fatalf("committed rotation was replayed or compensated: user=%d org=%d tokens=%d revoked=%d events=%d error=%v", userFailures, organizationFailures, tokens, revoked, events, err)
				}
				if _, err := f.auth.Resolve(t.Context(), login.AccessToken); !errors.Is(err, domain.ErrUnauthenticated) {
					t.Fatal("lost rotation ACK retained the original session")
				}
			} else {
				if hash != original.PasswordHash || userFailures != 2 || organizationFailures != 2 || tokens != 1 || revoked != 0 || events != 0 || passwords.hashes.Load() != 0 {
					t.Fatal("committed failed guess was replayed or compensated")
				}
				if _, err := f.auth.Resolve(t.Context(), login.AccessToken); err != nil {
					t.Fatal("lost failed-guess ACK invalidated the original session")
				}
			}
		})
	}
}

func TestBrowserPasswordAttemptsCallerExpiresAfterCommitWithoutCompensation(t *testing.T) {
	for _, success := range []bool{false, true} {
		name := "failed-guess"
		if success {
			name = "successful-rotation"
		}
		t.Run(name, func(t *testing.T) {
			f := newBrowserControlsFixture(t)
			login := f.login(t, "admission", "member@example.com")
			ctx := f.caller(t, login)
			caller, err := callercontext.CallerFromContext(ctx)
			if err != nil {
				t.Fatal(err)
			}
			expires := time.Unix(caller.Claims().ExpiresAt+31, 0)
			if !login.ExpiresAt.After(expires) || !login.IdleExpiresAt.After(expires) {
				t.Fatal("probe must expire only the original signed Caller, not the browser session")
			}
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
			input := browserPasswordInput(f)
			if !success {
				input.CurrentPassword = "incorrect current password"
			}
			result, err := browsersessions.NewService(store.BrowserSessions(), testPasswordEngine(t)).ChangePassword(ctx, input)
			if commits != 1 || !errors.Is(err, callercontext.ErrInvalid) || result != (browsersessions.PasswordResult{}) {
				t.Fatalf("expired original Caller received a committed password result: commits=%d error=%v", commits, err)
			}
			var failures, tokens, revoked int
			if err := f.pool.QueryRow(t.Context(), `SELECT
				(SELECT failures FROM credential_attempts WHERE scope='password_change_user'),
				(SELECT count(*) FROM api_tokens), (SELECT count(*) FROM api_tokens WHERE revoked_at IS NOT NULL)`).Scan(&failures, &tokens, &revoked); err != nil {
				t.Fatal(err)
			}
			if success && (failures != 0 || tokens != 2 || revoked != 1) || !success && (failures != 1 || tokens != 1 || revoked != 0) {
				t.Fatal("postcommit Caller expiry compensated durable state")
			}
		})
	}
}
