package e2e

import (
	"context"
	"errors"
	"reflect"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/tf4fun/antnest-platform/services/identity-service/internal/browsersessions"
	"github.com/tf4fun/antnest-platform/services/identity-service/internal/callercontext"
	"github.com/tf4fun/antnest-platform/services/identity-service/internal/domain"
	"github.com/tf4fun/antnest-platform/services/identity-service/internal/localauth"
)

func TestBrowserPasswordAttemptsLogoutDuringKDFCommitsOnlyLogout(t *testing.T) {
	for _, phase := range []string{"verify-wrong", "verify-correct", "hash"} {
		t.Run(phase, func(t *testing.T) {
			f := newBrowserControlsFixture(t)
			login := f.login(t, "admission", "member@example.com")
			ctx, cancel := context.WithTimeout(f.caller(t, login), 10*time.Second)
			defer cancel()
			var afterLogout map[string]string
			logout := func(actual context.Context) error {
				if actual != ctx {
					t.Error("KDF replaced the original request context")
				}
				status, err := f.auth.RevokeByAccessToken(actual, login.AccessToken)
				if err != nil || status != localauth.RevokeStatusRevoked {
					t.Fatalf("logout could not commit while password KDF was in progress: %v", err)
				}
				afterLogout = passwordMutationState(t, f)
				return nil
			}
			passwords := &loginPasswordProbe{LoginPasswords: testPasswordEngine(t), beforeVerify: logout}
			wantHashes := int32(0)
			if phase == "hash" {
				passwords.beforeVerify, passwords.beforeHash, wantHashes = nil, logout, 1
			}
			input := browserPasswordInput(f)
			if phase == "verify-wrong" {
				input.CurrentPassword = "incorrect current password"
			}
			result, err := browsersessions.NewService(f.store.BrowserSessions(), passwords).ChangePassword(ctx, input)
			if !errors.Is(err, callercontext.ErrInvalid) || result != (browsersessions.PasswordResult{}) || passwords.verifications.Load() != 1 || passwords.hashes.Load() != wantHashes {
				t.Fatalf("logged-out Caller committed a password outcome: verifies=%d hashes=%d error=%v", passwords.verifications.Load(), passwords.hashes.Load(), err)
			}
			if afterLogout == nil || !reflect.DeepEqual(afterLogout, passwordMutationState(t, f)) {
				t.Fatal("rejected Caller changed counters or authority after logout")
			}
		})
	}
}

func TestBrowserPasswordAttemptsKDFErrorsPreserveCountersAndAuthority(t *testing.T) {
	for _, phase := range []string{"verify", "hash"} {
		for _, failure := range []error{domain.ErrCredentialBusy, context.Canceled, errors.New("injected KDF operation failure")} {
			t.Run(phase+"/"+failure.Error(), func(t *testing.T) {
				f := newBrowserControlsFixture(t)
				login := f.login(t, "admission", "member@example.com")
				ctx := f.caller(t, login)
				input := browserPasswordInput(f)
				input.CurrentPassword = "incorrect current password"
				if _, err := f.service.ChangePassword(ctx, input); !errors.Is(err, domain.ErrInvalidCurrentPassword) {
					t.Fatal(err)
				}
				before := passwordMutationState(t, f)
				fail := func(actual context.Context) error {
					if actual != ctx {
						t.Error("KDF replaced the original request context")
					}
					return failure
				}
				passwords := &loginPasswordProbe{LoginPasswords: testPasswordEngine(t), beforeVerify: fail}
				wantHashes := int32(0)
				if phase == "hash" {
					passwords.beforeVerify, passwords.beforeHash, wantHashes = nil, fail, 1
				}
				result, err := browsersessions.NewService(f.store.BrowserSessions(), passwords).ChangePassword(ctx, browserPasswordInput(f))
				if !errors.Is(err, failure) || result != (browsersessions.PasswordResult{}) || passwords.verifications.Load() != 1 || passwords.hashes.Load() != wantHashes || !reflect.DeepEqual(before, passwordMutationState(t, f)) {
					t.Fatalf("KDF error changed durable state or was counted as a wrong password: %v", err)
				}
			})
		}
	}
}

func TestBrowserPasswordAttemptsRevalidateAfterBucketWait(t *testing.T) {
	f := newBrowserControlsFixture(t)
	login := f.login(t, "admission", "member@example.com")
	ctx, cancel := context.WithTimeout(f.caller(t, login), 10*time.Second)
	var workers sync.WaitGroup
	defer func() { cancel(); workers.Wait() }()
	caller, err := callercontext.CallerFromContext(ctx)
	if err != nil {
		t.Fatal(err)
	}
	before := passwordMutationState(t, f)
	blocker, err := f.pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = blocker.Rollback(context.WithoutCancel(ctx)) }()
	if _, err := blocker.Exec(ctx, `SELECT key_hash FROM credential_attempts WHERE scope='organization' FOR UPDATE`); err != nil {
		t.Fatal(err)
	}
	ready := make(chan uint32, 1)
	var captured sync.Once
	store := f.tracedStore(t, func(_ context.Context, conn *pgx.Conn, sql string) {
		if strings.Contains(sql, "INSERT INTO credential_attempts") {
			captured.Do(func() { ready <- conn.PgConn().PID() })
		}
	})
	passwords := &loginPasswordProbe{LoginPasswords: testPasswordEngine(t)}
	done := make(chan lifecyclePasswordOutcome, 1)
	workers.Go(func() {
		result, err := browsersessions.NewService(store.BrowserSessions(), passwords).ChangePassword(ctx, browserPasswordInput(f))
		done <- lifecyclePasswordOutcome{result, err}
	})
	assertBrowserBlocker(t, ctx, f, awaitBrowserPID(t, ctx, ready), blocker.Conn().PgConn().PID())
	f.now.Store(time.Unix(caller.Claims().ExpiresAt+31, 0).UnixNano())
	if err := blocker.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	outcome := <-done
	if !errors.Is(outcome.err, callercontext.ErrInvalid) || outcome.result != (browsersessions.PasswordResult{}) || passwords.verifications.Load() != 0 || passwords.hashes.Load() != 0 || !reflect.DeepEqual(before, passwordMutationState(t, f)) {
		t.Fatalf("Caller expired during bucket wait reached KDF or committed state: %v", outcome.err)
	}
}

func TestBrowserPasswordAttemptsSIDWaitPreservesBusyAndCancellation(t *testing.T) {
	for _, cancellation := range []bool{false, true} {
		name := "database-budget"
		if cancellation {
			name = "request-cancellation"
		}
		t.Run(name, func(t *testing.T) {
			f := newBrowserControlsFixture(t)
			login := f.login(t, "admission", "member@example.com")
			ctx, cancel := context.WithTimeout(f.caller(t, login), 10*time.Second)
			var workers sync.WaitGroup
			defer func() { cancel(); workers.Wait() }()
			before := passwordMutationState(t, f)
			blocker, err := f.pool.Begin(ctx)
			if err != nil {
				t.Fatal(err)
			}
			defer func() { _ = blocker.Rollback(context.WithoutCancel(ctx)) }()
			if _, err := blocker.Exec(ctx, `SELECT id FROM api_tokens WHERE id=$1 FOR UPDATE`, login.TokenID); err != nil {
				t.Fatal(err)
			}
			ready := make(chan uint32, 1)
			var captured sync.Once
			store := f.tracedStore(t, func(_ context.Context, conn *pgx.Conn, sql string) {
				if strings.Contains(sql, "SELECT id FROM api_tokens") && strings.Contains(sql, "ORDER BY id FOR UPDATE") {
					captured.Do(func() { ready <- conn.PgConn().PID() })
				}
			})
			passwords := &loginPasswordProbe{LoginPasswords: testPasswordEngine(t)}
			done := make(chan lifecyclePasswordOutcome, 1)
			workers.Go(func() {
				result, err := browsersessions.NewService(store.BrowserSessions(), passwords).ChangePassword(ctx, browserPasswordInput(f))
				done <- lifecyclePasswordOutcome{result, err}
			})
			assertBrowserBlocker(t, ctx, f, awaitBrowserPID(t, ctx, ready), blocker.Conn().PgConn().PID())
			want := error(domain.ErrCredentialBusy)
			if cancellation {
				want = context.Canceled
				cancel()
			}
			outcome := <-done
			if !errors.Is(outcome.err, want) || outcome.result != (browsersessions.PasswordResult{}) || passwords.verifications.Load() != 1 || passwords.hashes.Load() != 1 {
				t.Fatalf("SID wait lost admission/cancellation classification: %v", outcome.err)
			}
			if err := blocker.Rollback(t.Context()); err != nil {
				t.Fatal(err)
			}
			if !reflect.DeepEqual(before, passwordMutationState(t, f)) {
				t.Fatal("failed SID wait changed counters, credentials, sessions or events")
			}
		})
	}
}

func TestBrowserPasswordAttemptsCallerExpiryAfterFailureWriteRollsBack(t *testing.T) {
	f := newBrowserControlsFixture(t)
	login := f.login(t, "admission", "member@example.com")
	ctx := f.caller(t, login)
	caller, err := callercontext.CallerFromContext(ctx)
	if err != nil {
		t.Fatal(err)
	}
	before := passwordMutationState(t, f)
	writes := 0
	store := f.tracedStore(t, func(_ context.Context, _ *pgx.Conn, sql string) {
		if strings.Contains(sql, "UPDATE credential_attempts") {
			writes++
			f.now.Store(time.Unix(caller.Claims().ExpiresAt+31, 0).UnixNano())
		}
	})
	input := browserPasswordInput(f)
	input.CurrentPassword = "incorrect current password"
	result, err := browsersessions.NewService(store.BrowserSessions(), testPasswordEngine(t)).ChangePassword(ctx, input)
	if writes != 2 || !errors.Is(err, callercontext.ErrInvalid) || result != (browsersessions.PasswordResult{}) || !reflect.DeepEqual(before, passwordMutationState(t, f)) {
		t.Fatalf("Caller expiry at failure writes committed counters: writes=%d error=%v", writes, err)
	}
}

func TestBrowserPasswordAttemptsMissingCredentialDoesNotCountOrRunKDF(t *testing.T) {
	f := newBrowserControlsFixture(t)
	login := f.login(t, "admission", "member@example.com")
	ctx := f.caller(t, login)
	if _, err := f.pool.Exec(ctx, `DELETE FROM local_credentials WHERE user_id=$1`, f.user.User.ID); err != nil {
		t.Fatal(err)
	}
	before := passwordMutationState(t, f)
	passwords := &loginPasswordProbe{LoginPasswords: testPasswordEngine(t)}
	result, err := browsersessions.NewService(f.store.BrowserSessions(), passwords).ChangePassword(ctx, browserPasswordInput(f))
	if !errors.Is(err, domain.ErrInvalidArgument) || result != (browsersessions.PasswordResult{}) || passwords.verifications.Load() != 0 || passwords.hashes.Load() != 0 || !reflect.DeepEqual(before, passwordMutationState(t, f)) {
		t.Fatalf("missing password credential ran KDF or changed counters: %v", err)
	}
}
