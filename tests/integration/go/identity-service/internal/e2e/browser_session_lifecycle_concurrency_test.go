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
	"github.com/tf4fun/antnest-platform/services/identity-service/internal/credentials"
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
			auth, err := localauth.NewService(store.LocalAuth(), f.newID, f.clock, time.Hour)
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
					_, err := directory.NewService(roleStore.Directory(), f.newID, f.clock).UpdateMembership(roleContext, directory.UpdateMembershipInput{RequestID: "overlap-role-password", ActorPrincipalID: f.admin.User.ID, OrganizationID: f.admin.Organization.ID, MembershipID: f.user.Membership.ID, Email: f.user.Membership.Email, DisplayName: f.user.Membership.DisplayName, Role: domain.OrganizationRoleAdmin, Active: true})
					roleDone <- err
				})
			}
			startPassword := func() {
				workers.Go(func() {
					result, err := browsersessions.NewService(passwordStore.BrowserSessions()).ChangePassword(ctx, browserPasswordInput(f))
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
		if strings.Contains(sql, "FROM users") && strings.Contains(sql, "FOR UPDATE") {
			secondCaptured.Do(func() { waiting <- conn.PgConn().PID() })
		}
	})
	firstDone, secondDone := make(chan lifecyclePasswordOutcome, 1), make(chan lifecyclePasswordOutcome, 1)
	workers.Go(func() {
		result, err := browsersessions.NewService(firstStore.BrowserSessions()).ChangePassword(firstCtx, browserPasswordInput(f))
		firstDone <- lifecyclePasswordOutcome{result, err}
	})
	firstPID := awaitBrowserPID(t, firstCtx, ready)
	workers.Go(func() {
		input := browserPasswordInput(f)
		input.NewPassword = "another replacement password"
		result, err := browsersessions.NewService(secondStore.BrowserSessions()).ChangePassword(secondCtx, input)
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
	valid, err := credentials.VerifyPassword(credential.PasswordHash, browserPasswordInput(f).NewPassword)
	if err != nil || !valid {
		t.Fatal("losing request replaced the committed password")
	}
}

func TestBrowserPasswordRejectsChangedExpectedHash(t *testing.T) {
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
		result, err := browsersessions.NewService(store.BrowserSessions()).ChangePassword(ctx, browserPasswordInput(f))
		done <- lifecyclePasswordOutcome{result, err}
	})
	awaitBrowserPID(t, ctx, ready)
	hash, err := credentials.HashPassword("external credential update")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := f.pool.Exec(ctx, `UPDATE local_credentials SET password_hash=$2 WHERE user_id=$1`, f.user.User.ID, hash); err != nil {
		t.Fatal(err)
	}
	before := revocationStateSnapshot(t, f.localAdmissionFixture)
	close(release)
	result := <-done
	if !errors.Is(result.err, domain.ErrConflict) || result.result != (browsersessions.PasswordResult{}) {
		t.Fatalf("stale expected hash admitted rotation: %v", result.err)
	}
	if !reflect.DeepEqual(before, revocationStateSnapshot(t, f.localAdmissionFixture)) {
		t.Fatal("expected-hash conflict left session or audit effects")
	}
	credential, err := f.store.Directory().GetLocalCredential(ctx, f.user.User.ID)
	if err != nil || credential.PasswordHash != hash {
		t.Fatal("stale request overwrote concurrent password hash")
	}
}
