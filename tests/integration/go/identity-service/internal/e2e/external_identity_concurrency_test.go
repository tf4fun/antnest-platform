package e2e

import (
	"context"
	"errors"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/tf4fun/antnest-platform/services/identity-service/internal/callercontext"
	"github.com/tf4fun/antnest-platform/services/identity-service/internal/externalidentities"
	"github.com/tf4fun/antnest-platform/services/identity-service/internal/oidcflow"
)

func TestExternalIdentityRevalidatesCallerAfterProviderWait(t *testing.T) {
	for _, operation := range []string{"bind", "unbind"} {
		for _, change := range []string{"idle-expired", "revoked", "role-changed"} {
			t.Run(operation+"/"+change, func(t *testing.T) {
				f := newBindingFixture(t)
				bindingID := ""
				if operation == "unbind" {
					bindingID = f.bind(t).ID
				}
				ctx, cancel := context.WithTimeout(f.adminCtx, 15*time.Second)
				var workers sync.WaitGroup
				defer func() { cancel(); workers.Wait() }()
				blocker, err := f.pool.Begin(ctx)
				if err != nil {
					t.Fatal(err)
				}
				defer func() { _ = blocker.Rollback(context.WithoutCancel(ctx)) }()
				if _, err := blocker.Exec(ctx, `SELECT id FROM oidc_providers WHERE id=$1 FOR UPDATE`, f.providerID); err != nil {
					t.Fatal(err)
				}
				atProvider := make(chan uint32, 1)
				var once sync.Once
				store := f.tracedStore(t, func(_ context.Context, conn *pgx.Conn, sql string) {
					if strings.Contains(sql, "FROM oidc_providers") && strings.Contains(sql, "FOR UPDATE") {
						once.Do(func() { atProvider <- conn.PgConn().PID() })
					}
				})
				service := externalidentities.NewService(store.ExternalIdentities())
				done := make(chan error, 1)
				workers.Go(func() {
					var err error
					if operation == "bind" {
						_, err = service.Bind(ctx, f.bindInput())
					} else {
						_, err = service.Unbind(ctx, f.unbindInput(bindingID))
					}
					done <- err
				})
				select {
				case pid := <-atProvider:
					waitForDatabaseLock(t, ctx, f.pool, pid)
				case err := <-done:
					t.Fatalf("did not wait for Provider: %v", err)
				case <-ctx.Done():
					t.Fatal(ctx.Err())
				}
				probe, err := f.pool.Begin(ctx)
				if err != nil {
					t.Fatal(err)
				}
				_, lockErr := probe.Exec(ctx, `SELECT id FROM users WHERE id=$1 FOR UPDATE NOWAIT`, f.admin.User.ID)
				_ = probe.Rollback(context.WithoutCancel(ctx))
				if lockErr != nil {
					t.Fatalf("actor held while waiting for Provider: %v", lockErr)
				}
				caller, err := callercontext.CallerFromContext(f.adminCtx)
				if err != nil {
					t.Fatal(err)
				}
				switch change {
				case "idle-expired":
					_, err = f.pool.Exec(ctx, `UPDATE api_tokens SET idle_expires_at=$2 WHERE id=$1`, caller.Claims().Session, f.clock())
				case "revoked":
					_, err = f.pool.Exec(ctx, `UPDATE api_tokens SET revoked_at=$2 WHERE id=$1`, caller.Claims().Session, f.clock())
				case "role-changed":
					_, err = f.pool.Exec(ctx, `UPDATE organization_memberships SET role='member' WHERE id=$1`, f.admin.Membership.ID)
				}
				if err != nil {
					t.Fatal(err)
				}
				before := f.snapshot(t)
				if err := blocker.Rollback(ctx); err != nil {
					t.Fatal(err)
				}
				select {
				case err := <-done:
					if !errors.Is(err, callercontext.ErrInvalid) {
						t.Fatalf("stale caller admitted: %v", err)
					}
				case <-ctx.Done():
					t.Fatal(ctx.Err())
				}
				if f.snapshot(t) != before {
					t.Fatal("stale caller changed binding, audit, notices or sessions")
				}
			})
		}
	}
}

func TestExternalIdentityConcurrentLastMethodRemovalHasOneWinner(t *testing.T) {
	f := newBindingFixture(t)
	first := f.bind(t)
	provider, err := f.store.OIDC().FindProvider(t.Context(), f.admin.Organization.ID, "workforce")
	if err != nil {
		t.Fatal(err)
	}
	provider.ID = f.newID("provider")
	provider.Name = "alternative"
	provider.Issuer += "/alternative"
	provider.Revision = 1
	if _, err := f.store.OIDC().UpsertProvider(t.Context(), oidcflow.UpsertProviderCommand{RequestID: "alternative", ActorPrincipalID: f.admin.User.ID, Provider: provider}); err != nil {
		t.Fatal(err)
	}
	input := f.bindInput()
	input.ProviderID = provider.ID
	second, err := f.controls.Bind(f.adminCtx, input)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := f.pool.Exec(t.Context(), `DELETE FROM local_credentials WHERE user_id=$1`, f.user.User.ID); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(f.adminCtx, 15*time.Second)
	var workers sync.WaitGroup
	defer func() { cancel(); workers.Wait() }()
	blocker, err := f.pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = blocker.Rollback(context.WithoutCancel(ctx)) }()
	if _, err := blocker.Exec(ctx, `SELECT id FROM oidc_providers ORDER BY id FOR UPDATE`); err != nil {
		t.Fatal(err)
	}
	done := make(chan error, 2)
	attempted := make(chan uint32, 2)
	for _, id := range []string{first.ID, second.ID} {
		var once sync.Once
		store := f.tracedStore(t, func(_ context.Context, conn *pgx.Conn, sql string) {
			if strings.Contains(sql, "FROM oidc_providers") && strings.Contains(sql, "FOR UPDATE") {
				once.Do(func() { attempted <- conn.PgConn().PID() })
			}
		})
		workers.Go(func() {
			_, err := externalidentities.NewService(store.ExternalIdentities()).Unbind(ctx, f.unbindInput(id))
			done <- err
		})
	}
	for range 2 {
		select {
		case pid := <-attempted:
			waitForDatabaseLock(t, ctx, f.pool, pid)
		case <-ctx.Done():
			t.Fatal(ctx.Err())
		}
	}
	if err := blocker.Rollback(ctx); err != nil {
		t.Fatal(err)
	}
	winners, denied := 0, 0
	for range 2 {
		select {
		case err := <-done:
			if err == nil {
				winners++
			} else if errorCode(err) == "external_identity_last_method" {
				denied++
			} else {
				t.Fatal(err)
			}
		case <-ctx.Done():
			t.Fatal(ctx.Err())
		}
	}
	var active int
	if err := f.pool.QueryRow(ctx, `SELECT count(*) FROM external_identities WHERE user_id=$1 AND revoked_at IS NULL`, f.user.User.ID).Scan(&active); err != nil {
		t.Fatal(err)
	}
	if winners != 1 || denied != 1 || active != 1 {
		t.Fatalf("concurrent removals bypassed last method: winners=%d denied=%d active=%d", winners, denied, active)
	}
}

func TestExternalIdentityCallbackAndUnbindSerializeInBothOrders(t *testing.T) {
	for _, callbackFirst := range []bool{true, false} {
		name := "unbind-first"
		if callbackFirst {
			name = "callback-first"
		}
		t.Run(name, func(t *testing.T) {
			f := newBindingFixture(t)
			binding := f.bind(t)
			callback := f.start(t)
			ctx, cancel := context.WithTimeout(f.adminCtx, 15*time.Second)
			var workers sync.WaitGroup
			defer func() { cancel(); workers.Wait() }()
			held := make(chan struct{})
			release := make(chan struct{})
			var heldOnce sync.Once
			firstStore := f.tracedStore(t, func(ctx context.Context, _ *pgx.Conn, sql string) {
				if strings.Contains(sql, "FROM users") && strings.Contains(sql, "FOR ") {
					heldOnce.Do(func() {
						close(held)
						select {
						case <-release:
						case <-ctx.Done():
						}
					})
				}
			})
			waiting := make(chan uint32, 1)
			var waitOnce sync.Once
			secondStore := f.tracedStore(t, func(_ context.Context, conn *pgx.Conn, sql string) {
				if strings.Contains(sql, "FROM oidc_providers") && strings.Contains(sql, "FOR UPDATE") {
					waitOnce.Do(func() { waiting <- conn.PgConn().PID() })
				}
			})
			callbackStore, unbindStore := secondStore, firstStore
			if callbackFirst {
				callbackStore, unbindStore = firstStore, secondStore
			}
			f.repository.Repository = callbackStore.OIDC()
			callbackDone := make(chan error, 1)
			unbindDone := make(chan error, 1)
			call := func() { _, err := f.flow.CompleteLogin(ctx, callback); callbackDone <- err }
			unbind := func() {
				_, err := externalidentities.NewService(unbindStore.ExternalIdentities()).Unbind(ctx, f.unbindInput(binding.ID))
				unbindDone <- err
			}
			if callbackFirst {
				workers.Go(call)
			} else {
				workers.Go(unbind)
			}
			select {
			case <-held:
			case <-ctx.Done():
				t.Fatal(ctx.Err())
			}
			if callbackFirst {
				workers.Go(unbind)
			} else {
				workers.Go(call)
			}
			select {
			case pid := <-waiting:
				waitForDatabaseLock(t, ctx, f.pool, pid)
			case <-ctx.Done():
				t.Fatal(ctx.Err())
			}
			close(release)
			if err := <-unbindDone; err != nil {
				t.Fatalf("unbind: %v", err)
			}
			callbackErr := <-callbackDone
			if callbackFirst && callbackErr != nil || !callbackFirst && errorCode(callbackErr) != "oidc_membership_required" {
				t.Fatalf("callback admission order: %v", callbackErr)
			}
			var activeTokens, revoked, feed int
			if err := f.pool.QueryRow(ctx, `SELECT (SELECT count(*) FROM api_tokens WHERE user_id=$1 AND revoked_at IS NULL),(SELECT count(*) FROM external_identities WHERE revoked_at IS NOT NULL),(SELECT count(*) FROM session_revocations WHERE user_id=$1)`, f.user.User.ID).Scan(&activeTokens, &revoked, &feed); err != nil {
				t.Fatal(err)
			}
			wantFeed := 1
			if callbackFirst {
				wantFeed = 2
			}
			if activeTokens != 0 || revoked != 1 || feed != wantFeed {
				t.Fatalf("callback escaped revocation: active=%d revoked=%d feed=%d", activeTokens, revoked, feed)
			}
		})
	}
}

func TestExternalIdentitySelfUnbindRechecksDeadlineAfterFeedWait(t *testing.T) {
	f := newBindingFixture(t)
	bound := f.bind(t)
	if _, err := f.pool.Exec(t.Context(), `UPDATE api_tokens SET idle_expires_at=$2 WHERE id=$1`, f.selfTokenID, f.clock().Add(5*time.Second)); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(f.selfCtx, 15*time.Second)
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
	before := f.snapshot(t)
	waiting := make(chan uint32, 1)
	var once sync.Once
	store := f.tracedStore(t, func(_ context.Context, conn *pgx.Conn, sql string) {
		if strings.Contains(sql, "LOCK TABLE session_revocations") {
			once.Do(func() { waiting <- conn.PgConn().PID() })
		}
	})
	done := make(chan error, 1)
	workers.Go(func() {
		_, err := externalidentities.NewService(store.ExternalIdentities()).Unbind(ctx, externalidentities.UnbindInput{RequestID: "self-unbind-wait", ActorPrincipalID: f.user.User.ID, BindingID: bound.ID, Scope: "self"})
		done <- err
	})
	select {
	case pid := <-waiting:
		waitForDatabaseLock(t, ctx, f.pool, pid)
	case err := <-done:
		t.Fatalf("unbind never reached feed: %v", err)
	case <-ctx.Done():
		t.Fatal(ctx.Err())
	}
	f.advance(5 * time.Second)
	if err := blocker.Rollback(ctx); err != nil {
		t.Fatal(err)
	}
	select {
	case err := <-done:
		if !errors.Is(err, callercontext.ErrInvalid) {
			t.Fatalf("expired self authority committed: %v", err)
		}
	case <-ctx.Done():
		t.Fatal(ctx.Err())
	}
	if f.snapshot(t) != before {
		t.Fatal("expired self revocation committed binding/session/audit/feed effects")
	}
}
