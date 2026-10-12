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
	"github.com/tf4fun/antnest-platform/services/identity-service/internal/directory"
	"github.com/tf4fun/antnest-platform/services/identity-service/internal/domain"
	"github.com/tf4fun/antnest-platform/services/identity-service/internal/localauth"
)

type lifecyclePasswordOutcome struct {
	result browsersessions.PasswordResult
	err    error
}

func awaitBrowserPID(t *testing.T, ctx context.Context, pid <-chan uint32) uint32 {
	t.Helper()
	select {
	case value := <-pid:
		return value
	case <-ctx.Done():
		t.Fatal(ctx.Err())
		return 0
	}
}

func TestBrowserLogoutChecksFreshDeadlineAfterTokenWait(t *testing.T) {
	for _, deadline := range []string{"idle", "absolute"} {
		t.Run(deadline, func(t *testing.T) {
			f := newBrowserControlsFixture(t)
			login := f.login(t, "admission", "member@example.com")
			expires := f.clock().Add(5 * time.Second)
			query := `UPDATE api_tokens SET idle_expires_at = $2 WHERE id = $1`
			if deadline == "absolute" {
				query = `UPDATE api_tokens SET expires_at = $2 WHERE id = $1`
			}
			if _, err := f.pool.Exec(t.Context(), query, login.TokenID, expires); err != nil {
				t.Fatal(err)
			}
			before := revocationStateSnapshot(t, f.localAdmissionFixture)
			ctx, cancel := context.WithTimeout(t.Context(), 10*time.Second)
			var workers sync.WaitGroup
			defer func() { cancel(); workers.Wait() }()
			blocker, err := f.pool.Begin(ctx)
			if err != nil {
				t.Fatal(err)
			}
			defer func() { _ = blocker.Rollback(context.WithoutCancel(ctx)) }()
			if _, err := blocker.Exec(ctx, `SELECT id FROM api_tokens WHERE id = $1 FOR UPDATE`, login.TokenID); err != nil {
				t.Fatal(err)
			}
			pid := make(chan uint32, 1)
			var captured sync.Once
			store := f.tracedStore(t, func(_ context.Context, conn *pgx.Conn, sql string) {
				if strings.Contains(sql, "api_tokens") && strings.Contains(sql, "FOR UPDATE") {
					captured.Do(func() { pid <- conn.PgConn().PID() })
				}
			})
			auth, err := localauth.NewService(t.Context(), store.LocalAuth(), f.newID, f.clock, time.Hour, testPasswordEngine(t))
			if err != nil {
				t.Fatal(err)
			}
			type outcome struct {
				status localauth.RevokeStatus
				err    error
			}
			done := make(chan outcome, 1)
			workers.Go(func() { status, err := auth.RevokeByAccessToken(ctx, login.AccessToken); done <- outcome{status, err} })
			assertBrowserBlocker(t, ctx, f, awaitBrowserPID(t, ctx, pid), blocker.Conn().PgConn().PID())
			f.now.Store(expires.UnixNano())
			if err := blocker.Rollback(ctx); err != nil {
				t.Fatal(err)
			}
			result := <-done
			if result.err != nil || result.status != localauth.RevokeStatusAlreadyInvalid {
				t.Fatalf("logout used a pre-wait deadline: %q %v", result.status, result.err)
			}
			if !reflect.DeepEqual(before, revocationStateSnapshot(t, f.localAdmissionFixture)) {
				t.Fatal("expired waiter mutated token, audit or feed")
			}
		})
	}
}

func TestBrowserPasswordAndRoleChangeSerializeWithoutRevivingSessions(t *testing.T) {
	for _, first := range []string{"role", "password"} {
		t.Run(first+"-first", func(t *testing.T) {
			f := newBrowserControlsFixture(t)
			current := f.login(t, "admission", "member@example.com")
			administrator := f.login(t, "admission", "admin@example.com")
			adminCaller, err := callercontext.CallerFromContext(f.caller(t, administrator))
			if err != nil {
				t.Fatal(err)
			}
			ctx, cancel := context.WithTimeout(f.caller(t, current), 15*time.Second)
			roleContext := callercontext.WithCaller(ctx, adminCaller)
			var workers sync.WaitGroup
			defer func() { cancel(); workers.Wait() }()
			ready := make(chan uint32, 1)
			release := make(chan struct{})
			var captured sync.Once
			firstStore := f.tracedStore(t, func(ctx context.Context, conn *pgx.Conn, sql string) {
				pause := first == "role" && strings.Contains(sql, "SELECT source, role") || first == "password" && strings.Contains(sql, "SELECT id FROM api_tokens") && strings.Contains(sql, "ORDER BY id FOR UPDATE")
				if pause {
					captured.Do(func() {
						ready <- conn.PgConn().PID()
						select {
						case <-release:
						case <-ctx.Done():
						}
					})
				}
			})
			waiting := make(chan uint32, 1)
			var waiterCaptured sync.Once
			secondStore := f.tracedStore(t, func(_ context.Context, conn *pgx.Conn, sql string) {
				if strings.Contains(sql, "FROM organizations") && strings.Contains(sql, "FOR ") {
					waiterCaptured.Do(func() { waiting <- conn.PgConn().PID() })
				}
			})
			roleStore, passwordStore := firstStore, secondStore
			if first == "password" {
				roleStore, passwordStore = secondStore, firstStore
			}
			roleDone := make(chan error, 1)
			passwordDone := make(chan lifecyclePasswordOutcome, 1)
			startRole := func() {
				workers.Go(func() {
					_, err := directory.NewService(roleStore.Directory(), f.newID, f.clock, testPasswordEngine(t)).UpdateMembership(roleContext, directory.UpdateMembershipInput{RequestID: "overlap-role-password", ActorPrincipalID: f.admin.User.ID, OrganizationID: f.admin.Organization.ID, MembershipID: f.user.Membership.ID, Email: f.user.Membership.Email, DisplayName: f.user.Membership.DisplayName, Role: domain.OrganizationRoleAdmin, Active: true})
					roleDone <- err
				})
			}
			startPassword := func() {
				workers.Go(func() {
					result, err := browsersessions.NewService(passwordStore.BrowserSessions(), testPasswordEngine(t)).ChangePassword(ctx, browserPasswordInput(f))
					passwordDone <- lifecyclePasswordOutcome{result, err}
				})
			}
			if first == "role" {
				startRole()
			} else {
				startPassword()
			}
			firstPID := awaitBrowserPID(t, ctx, ready)
			if first == "role" {
				startPassword()
			} else {
				startRole()
			}
			assertBrowserBlocker(t, ctx, f, awaitBrowserPID(t, ctx, waiting), firstPID)
			close(release)
			if err := <-roleDone; err != nil {
				t.Fatalf("role mutation failed during password overlap: %v", err)
			}
			password := <-passwordDone
			wantTokens, wantPasswordEvents := 1, 0
			if first == "role" {
				if !errors.Is(password.err, callercontext.ErrInvalid) || password.result != (browsersessions.PasswordResult{}) {
					t.Fatalf("role-revoked waiter changed password: %v", password.err)
				}
			} else {
				wantTokens, wantPasswordEvents = 2, 1
				if password.err != nil || password.result.AccessToken == "" {
					t.Fatalf("earlier password mutation failed: %v", password.err)
				}
				if _, err := f.auth.Resolve(ctx, password.result.AccessToken); !errors.Is(err, domain.ErrUnauthenticated) {
					t.Fatal("role mutation omitted the concurrently rotated session")
				}
			}
			var tokens, revoked, roleEvents, passwordEvents int
			if err := f.pool.QueryRow(ctx, `SELECT (SELECT count(*) FROM api_tokens WHERE user_id=$1), (SELECT count(*) FROM api_tokens WHERE user_id=$1 AND revoked_at IS NOT NULL), (SELECT count(*) FROM session_revocations WHERE user_id=$1 AND reason = 'role_changed'), (SELECT count(*) FROM session_revocations WHERE user_id=$1 AND reason = 'password_changed')`, f.user.User.ID).Scan(&tokens, &revoked, &roleEvents, &passwordEvents); err != nil {
				t.Fatal(err)
			}
			if tokens != wantTokens || revoked != tokens || roleEvents != 1 || passwordEvents != wantPasswordEvents {
				t.Fatal("role/password overlap lost atomic revocations")
			}
			if _, err := f.auth.Resolve(ctx, administrator.AccessToken); err != nil {
				t.Fatal("target mutation revoked the administrator's session")
			}
			if len(readRevocations(t, f.localAdmissionFixture, 0, 500).Events) != 0 {
				t.Fatal("role or password emitted principal offboarding")
			}
		})
	}
}

func TestBrowserConcurrentPasswordChangeRejectsRevokedWaiter(t *testing.T) {
	f := newBrowserControlsFixture(t)
	first, second := f.login(t, "admission", "member@example.com"), f.login(t, "admission", "member@example.com")
	firstCtx, cancel := context.WithTimeout(f.caller(t, first), 15*time.Second)
	secondCtx, cancelSecond := context.WithTimeout(f.caller(t, second), 15*time.Second)
	var workers sync.WaitGroup
	defer func() { cancel(); cancelSecond(); workers.Wait() }()
	ready, waiting := make(chan uint32, 1), make(chan uint32, 1)
	release := make(chan struct{})
	var firstCaptured, secondCaptured sync.Once
	firstStore := f.tracedStore(t, func(ctx context.Context, conn *pgx.Conn, sql string) {
		if strings.Contains(sql, "SELECT id FROM api_tokens") && strings.Contains(sql, "ORDER BY id FOR UPDATE") {
			firstCaptured.Do(func() {
				ready <- conn.PgConn().PID()
				select {
				case <-release:
				case <-ctx.Done():
				}
			})
		}
	})
	secondStore := f.tracedStore(t, func(_ context.Context, conn *pgx.Conn, sql string) {
		if strings.Contains(sql, "INSERT INTO credential_attempts") {
			secondCaptured.Do(func() { waiting <- conn.PgConn().PID() })
		}
	})
	firstDone, secondDone := make(chan lifecyclePasswordOutcome, 1), make(chan lifecyclePasswordOutcome, 1)
	workers.Go(func() {
		result, err := browsersessions.NewService(firstStore.BrowserSessions(), testPasswordEngine(t)).ChangePassword(firstCtx, browserPasswordInput(f))
		firstDone <- lifecyclePasswordOutcome{result, err}
	})
	firstPID := awaitBrowserPID(t, firstCtx, ready)
	workers.Go(func() {
		input := browserPasswordInput(f)
		input.NewPassword = "another replacement password"
		result, err := browsersessions.NewService(secondStore.BrowserSessions(), testPasswordEngine(t)).ChangePassword(secondCtx, input)
		secondDone <- lifecyclePasswordOutcome{result, err}
	})
	assertBrowserBlocker(t, firstCtx, f, awaitBrowserPID(t, firstCtx, waiting), firstPID)
	close(release)
	winner, loser := <-firstDone, <-secondDone
	if winner.err != nil || winner.result.AccessToken == "" {
		t.Fatalf("admitted password change failed: %v", winner.err)
	}
	if !errors.Is(loser.err, callercontext.ErrInvalid) || loser.result != (browsersessions.PasswordResult{}) {
		t.Fatalf("revoked waiting browser changed password: %v", loser.err)
	}
	if _, err := f.auth.Resolve(firstCtx, winner.result.AccessToken); err != nil {
		t.Fatal("losing request revoked winner's replacement")
	}
	var tokens, revoked, events int
	if err := f.pool.QueryRow(firstCtx, `SELECT (SELECT count(*) FROM api_tokens), (SELECT count(*) FROM api_tokens WHERE revoked_at IS NOT NULL), (SELECT count(*) FROM session_revocations WHERE reason='password_changed')`).Scan(&tokens, &revoked, &events); err != nil {
		t.Fatal(err)
	}
	if tokens != 3 || revoked != 2 || events != 2 {
		t.Fatal("concurrent password changes committed more than one replacement")
	}
	credential, err := f.store.Directory().GetLocalCredential(firstCtx, f.user.User.ID)
	if err != nil {
		t.Fatal(err)
	}
	valid, err := testPasswordEngine(t).VerifyPassword(t.Context(), credential.PasswordHash, browserPasswordInput(f).NewPassword)
	if err != nil || !valid {
		t.Fatal("losing request replaced the committed password")
	}
}

func TestBrowserPasswordLocksCredentialThroughRotation(t *testing.T) {
	f := newBrowserControlsFixture(t)
	current := f.login(t, "admission", "member@example.com")
	ctx, cancel := context.WithTimeout(f.caller(t, current), 15*time.Second)
	var workers sync.WaitGroup
	defer func() { cancel(); workers.Wait() }()
	ready, release := make(chan uint32, 1), make(chan struct{})
	var captured sync.Once
	store := f.tracedStore(t, func(ctx context.Context, conn *pgx.Conn, sql string) {
		if strings.Contains(sql, "SELECT id FROM api_tokens") && strings.Contains(sql, "ORDER BY id FOR UPDATE") {
			captured.Do(func() {
				ready <- conn.PgConn().PID()
				select {
				case <-release:
				case <-ctx.Done():
				}
			})
		}
	})
	done := make(chan lifecyclePasswordOutcome, 1)
	workers.Go(func() {
		result, err := browsersessions.NewService(store.BrowserSessions(), testPasswordEngine(t)).ChangePassword(ctx, browserPasswordInput(f))
		done <- lifecyclePasswordOutcome{result, err}
	})
	firstPID := awaitBrowserPID(t, ctx, ready)
	hash, err := testPasswordEngine(t).HashPassword(t.Context(), "external credential update")
	if err != nil {
		t.Fatal(err)
	}
	writer, err := f.pool.Acquire(ctx)
	if err != nil {
		t.Fatal(err)
	}
	writeDone := make(chan error, 1)
	writerPID := writer.Conn().PgConn().PID()
	workers.Go(func() {
		defer writer.Release()
		_, err := writer.Exec(ctx, `UPDATE local_credentials SET password_hash=$2 WHERE user_id=$1`, f.user.User.ID, hash)
		writeDone <- err
	})
	assertBrowserBlocker(t, ctx, f, writerPID, firstPID)
	close(release)
	result := <-done
	if result.err != nil || result.result.AccessToken == "" {
		t.Fatalf("locked credential did not admit rotation before the external writer: %v", result.err)
	}
	if err := <-writeDone; err != nil {
		t.Fatal(err)
	}
	credential, err := f.store.Directory().GetLocalCredential(ctx, f.user.User.ID)
	if err != nil || credential.PasswordHash != hash {
		t.Fatal("rotation overwrote the serialized external password update")
	}
	if _, err := f.auth.Resolve(ctx, current.AccessToken); !errors.Is(err, domain.ErrUnauthenticated) {
		t.Fatal("rotation retained the original browser session")
	}
	if _, err := f.auth.Resolve(ctx, result.result.AccessToken); err != nil {
		t.Fatal("serialized credential writer changed the replacement session")
	}
}

func TestBrowserPasswordCompareAndSwapFailureRollsBackAttemptsAndAuthority(t *testing.T) {
	f := newBrowserControlsFixture(t)
	current := f.login(t, "admission", "member@example.com")
	ctx := f.caller(t, current)
	before := passwordMutationState(t, f)
	if _, err := f.pool.Exec(t.Context(), `CREATE FUNCTION reject_password_cas() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN RETURN NULL; END$$;
		CREATE TRIGGER reject_password_cas BEFORE UPDATE ON local_credentials FOR EACH ROW EXECUTE FUNCTION reject_password_cas()`); err != nil {
		t.Fatal(err)
	}
	result, err := f.service.ChangePassword(ctx, browserPasswordInput(f))
	if !errors.Is(err, domain.ErrConflict) || result != (browsersessions.PasswordResult{}) {
		t.Fatalf("zero-row password CAS admitted rotation: %v", err)
	}
	if !reflect.DeepEqual(before, passwordMutationState(t, f)) {
		t.Fatal("failed password CAS changed counters, credentials, sessions or events")
	}
}
