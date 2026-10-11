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
	"github.com/tf4fun/antnest-platform/services/identity-service/internal/callercontext"
	"github.com/tf4fun/antnest-platform/services/identity-service/internal/externalidentities"
)

func TestExternalIdentityIdempotentBindRechecksDeadlineAfterProjection(t *testing.T) {
	f := newBindingFixture(t)
	f.bind(t)
	caller, err := callercontext.CallerFromContext(f.adminCtx)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := f.pool.Exec(t.Context(), `UPDATE api_tokens SET idle_expires_at=$2 WHERE id=$1`, caller.Claims().Session, f.clock().Add(5*time.Second)); err != nil {
		t.Fatal(err)
	}
	var once sync.Once
	store := f.tracedStore(t, func(_ context.Context, _ *pgx.Conn, sql string) {
		if strings.Contains(sql, "FROM external_identities e JOIN") && strings.Contains(sql, "WHERE e.id=$1") && !strings.Contains(sql, "FOR UPDATE") {
			once.Do(func() { f.advance(5 * time.Second) })
		}
	})
	before := f.snapshot(t)
	if _, err := externalidentities.NewService(store.ExternalIdentities()).Bind(f.adminCtx, f.bindInput()); !errors.Is(err, callercontext.ErrInvalid) || f.snapshot(t) != before {
		t.Fatalf("idempotent bind returned after caller expiry: %v", err)
	}
}

func TestExternalIdentityRevalidatesAfterCallerSessionLockWait(t *testing.T) {
	for _, operation := range []string{"bind", "unbind", "acknowledge"} {
		for _, change := range []string{"revoked", "idle-expired"} {
			t.Run(operation+"/"+change, func(t *testing.T) {
				f := newBindingFixture(t)
				ctxSource := f.adminCtx
				bindingID, noticeID := "", ""
				if operation != "bind" {
					bindingID = f.bind(t).ID
				}
				if operation == "acknowledge" {
					ctxSource = f.selfCtx
					page, err := f.controls.List(f.selfCtx, externalidentities.ListInput{ActorPrincipalID: f.user.User.ID, Scope: "self", Limit: 1})
					if err != nil || page.Notices == nil || len(*page.Notices) != 1 {
						t.Fatalf("notice setup: %v", err)
					}
					noticeID = (*page.Notices)[0].ID
				}
				caller, err := callercontext.CallerFromContext(ctxSource)
				if err != nil {
					t.Fatal(err)
				}
				ctx, cancel := context.WithTimeout(ctxSource, 15*time.Second)
				var workers sync.WaitGroup
				defer func() { cancel(); workers.Wait() }()
				blocker, err := f.pool.Begin(ctx)
				if err != nil {
					t.Fatal(err)
				}
				defer func() { _ = blocker.Rollback(context.WithoutCancel(ctx)) }()
				if _, err := blocker.Exec(ctx, `SELECT id FROM api_tokens WHERE id=$1 FOR UPDATE`, caller.Claims().Session); err != nil {
					t.Fatal(err)
				}
				waiting := make(chan uint32, 1)
				var once sync.Once
				store := f.tracedStore(t, func(_ context.Context, conn *pgx.Conn, sql string) {
					if strings.Contains(sql, "FROM api_tokens") && (strings.Contains(sql, "FOR SHARE") || strings.Contains(sql, "FOR UPDATE")) {
						once.Do(func() { waiting <- conn.PgConn().PID() })
					}
				})
				service := externalidentities.NewService(store.ExternalIdentities())
				done := make(chan error, 1)
				workers.Go(func() {
					var err error
					switch operation {
					case "bind":
						_, err = service.Bind(ctx, f.bindInput())
					case "unbind":
						_, err = service.Unbind(ctx, f.unbindInput(bindingID))
					case "acknowledge":
						_, err = service.Acknowledge(ctx, externalidentities.AcknowledgeInput{RequestID: "ack-after-wait", ActorPrincipalID: f.user.User.ID, NoticeIDs: []string{noticeID}})
					}
					done <- err
				})
				select {
				case pid := <-waiting:
					waitForDatabaseLock(t, ctx, f.pool, pid)
				case err := <-done:
					t.Fatalf("operation never waited for SID: %v", err)
				case <-ctx.Done():
					t.Fatal(ctx.Err())
				}
				column := "revoked_at"
				if change == "idle-expired" {
					column = "idle_expires_at"
				}
				if _, err := blocker.Exec(ctx, `UPDATE api_tokens SET `+column+`=$2 WHERE id=$1`, caller.Claims().Session, f.clock()); err != nil {
					t.Fatal(err)
				}
				var expected string
				if err := blocker.QueryRow(ctx, externalIdentitySnapshotSQL).Scan(&expected); err != nil {
					t.Fatal(err)
				}
				if err := blocker.Commit(ctx); err != nil {
					t.Fatal(err)
				}
				select {
				case err := <-done:
					if !errors.Is(err, callercontext.ErrInvalid) {
						t.Fatalf("stale SID authorized effects: %v", err)
					}
				case <-ctx.Done():
					t.Fatal(ctx.Err())
				}
				if f.snapshot(t) != expected {
					t.Fatal("stale SID changed bindings, notices, tokens, audits or either feed")
				}
			})
		}
	}
}

func TestExternalIdentityRetriesWholeTransactionWhenProviderSetGrows(t *testing.T) {
	f := newBindingFixture(t)
	first := f.bind(t)
	p := f.additionalProvider(t, f.admin.Organization.ID, "second")
	if _, err := f.pool.Exec(t.Context(), `DELETE FROM local_credentials WHERE user_id=$1`, f.user.User.ID); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(f.adminCtx, 15*time.Second)
	var workers sync.WaitGroup
	defer func() { cancel(); workers.Wait() }()
	held, release := make(chan struct{}), make(chan struct{})
	var once sync.Once
	bindStore := f.tracedStore(t, func(ctx context.Context, _ *pgx.Conn, sql string) {
		if strings.Contains(sql, "FROM api_tokens") && strings.Contains(sql, "FOR SHARE") {
			once.Do(func() {
				close(held)
				select {
				case <-release:
				case <-ctx.Done():
				}
			})
		}
	})
	bindDone := make(chan error, 1)
	input := f.bindInput()
	input.ProviderID = p.ID
	workers.Go(func() {
		_, err := externalidentities.NewService(bindStore.ExternalIdentities()).Bind(ctx, input)
		bindDone <- err
	})
	select {
	case <-held:
	case err := <-bindDone:
		t.Fatalf("bind never locked target: %v", err)
	case <-ctx.Done():
		t.Fatal(ctx.Err())
	}
	var providerAttempts atomic.Int32
	retried, retryRelease := make(chan struct{}), make(chan struct{})
	waiting := make(chan uint32, 1)
	var waitOnce sync.Once
	unbindStore := f.tracedStore(t, func(ctx context.Context, conn *pgx.Conn, sql string) {
		if strings.Contains(sql, "FROM oidc_providers") && strings.Contains(sql, "FOR UPDATE") {
			if providerAttempts.Add(1) == 2 {
				close(retried)
				select {
				case <-retryRelease:
				case <-ctx.Done():
				}
			}
		}
		if strings.Contains(sql, "FROM organization_memberships") && strings.Contains(sql, "FOR UPDATE") {
			waitOnce.Do(func() { waiting <- conn.PgConn().PID() })
		}
	})
	unbindDone := make(chan error, 1)
	workers.Go(func() {
		_, err := externalidentities.NewService(unbindStore.ExternalIdentities()).Unbind(ctx, f.unbindInput(first.ID))
		unbindDone <- err
	})
	select {
	case pid := <-waiting:
		waitForDatabaseLock(t, ctx, f.pool, pid)
	case err := <-unbindDone:
		t.Fatalf("unbind never waited for target: %v", err)
	case <-ctx.Done():
		t.Fatal(ctx.Err())
	}
	close(release)
	if err := <-bindDone; err != nil {
		t.Fatal(err)
	}
	select {
	case <-retried:
	case err := <-unbindDone:
		t.Fatalf("unbind did not retry: %v", err)
	case <-ctx.Done():
		t.Fatal(ctx.Err())
	}
	probe, err := f.pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = probe.Rollback(context.WithoutCancel(ctx)) }()
	for _, check := range []struct {
		sql string
		ids []string
	}{
		{`SELECT id FROM oidc_providers WHERE id=ANY($1::text[]) ORDER BY id FOR UPDATE NOWAIT`, []string{f.providerID}},
		{`SELECT id FROM users WHERE id=ANY($1::text[]) ORDER BY id FOR UPDATE NOWAIT`, []string{f.admin.User.ID, f.user.User.ID}},
		{`SELECT id FROM organization_memberships WHERE id=ANY($1::text[]) ORDER BY id FOR UPDATE NOWAIT`, []string{f.admin.Membership.ID, f.user.Membership.ID}},
	} {
		if _, err := probe.Exec(ctx, check.sql, check.ids); err != nil {
			t.Fatalf("retry retained previous transaction locks: %v", err)
		}
	}
	if err := probe.Rollback(ctx); err != nil {
		t.Fatal(err)
	}
	close(retryRelease)
	if err := <-unbindDone; err != nil {
		t.Fatal(err)
	}
	var active, revoked, unbound, notices int
	if err := f.pool.QueryRow(ctx, `SELECT (SELECT count(*) FROM external_identities WHERE revoked_at IS NULL),(SELECT count(*) FROM external_identities WHERE revoked_at IS NOT NULL),(SELECT count(*) FROM identity_events WHERE event_type='external_identity.unbound'),(SELECT count(*) FROM external_identity_notices)`).Scan(&active, &revoked, &unbound, &notices); err != nil {
		t.Fatal(err)
	}
	if providerAttempts.Load() != 2 || active != 1 || revoked != 1 || unbound != 1 || notices != 2 {
		t.Fatalf("Provider set retry lost atomicity: attempts=%d active=%d revoked=%d unbound=%d notices=%d", providerAttempts.Load(), active, revoked, unbound, notices)
	}
}
