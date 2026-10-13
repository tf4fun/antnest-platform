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
	"github.com/tf4fun/antnest-platform/services/identity-service/internal/credentials"
	"github.com/tf4fun/antnest-platform/services/identity-service/internal/domain"
	"github.com/tf4fun/antnest-platform/services/identity-service/internal/externalidentities"
	"github.com/tf4fun/antnest-platform/services/identity-service/internal/scim"
)

func TestSCIMPairingTokenRevalidatesAfterProviderAndSessionWaits(t *testing.T) {
	for _, tc := range []struct{ lock, change string }{{"provider", "revoked"}, {"provider", "role"}, {"provider", "expired"}, {"session", "revoked"}, {"session", "expired"}} {
		t.Run(tc.lock+"/"+tc.change, func(t *testing.T) {
			f := newBindingFixture(t)
			if _, err := f.pool.Exec(t.Context(), `UPDATE users SET system_role='user' WHERE id=$1`, f.admin.User.ID); err != nil {
				t.Fatal(err)
			}
			f.adminCtx = f.browser.caller(t, f.browser.login(t, "admission", "admin@example.com"))
			caller, err := callercontext.CallerFromContext(f.adminCtx)
			if err != nil {
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
			table, id := "oidc_providers", f.providerID
			if tc.lock == "session" {
				table, id = "api_tokens", caller.Claims().Session
			}
			if _, err := blocker.Exec(ctx, `SELECT id FROM `+table+` WHERE id=$1 FOR UPDATE`, id); err != nil {
				t.Fatal(err)
			}
			waiting := make(chan uint32, 1)
			var once sync.Once
			store := f.tracedStore(t, func(_ context.Context, conn *pgx.Conn, sql string) {
				if strings.Contains(sql, "FROM "+table) && strings.Contains(sql, "FOR ") {
					once.Do(func() { waiting <- conn.PgConn().PID() })
				}
			})
			done := make(chan error, 1)
			workers.Go(func() {
				_, err := store.SCIM().IssueToken(ctx, scim.IssueTokenCommand{RequestID: "waiting-pairing", ActorPrincipalID: f.admin.User.ID, OrganizationID: f.admin.Organization.ID, OIDCProviderID: &f.providerID, TokenID: f.newID("scimtoken"), TokenHash: "waiting-pairing-hash", Name: "Waiting", Scopes: []string{domain.SCIMScopeWrite}, CreatedAt: f.clock()})
				done <- err
			})
			select {
			case pid := <-waiting:
				waitForDatabaseLock(t, ctx, f.pool, pid)
			case err := <-done:
				t.Fatalf("issuer bypassed business lock: %v", err)
			case <-ctx.Done():
				t.Fatal(ctx.Err())
			}
			if tc.lock == "provider" {
				probe, err := f.pool.Begin(ctx)
				if err != nil {
					t.Fatal(err)
				}
				for _, row := range []struct{ table, id string }{{"users", f.admin.User.ID}, {"organizations", f.admin.Organization.ID}, {"organization_memberships", f.admin.Membership.ID}, {"api_tokens", caller.Claims().Session}} {
					if _, err := probe.Exec(ctx, `SELECT id FROM `+row.table+` WHERE id=$1 FOR UPDATE NOWAIT`, row.id); err != nil {
						_ = probe.Rollback(context.WithoutCancel(ctx))
						t.Fatalf("issuer held %s while waiting for Provider: %v", row.table, err)
					}
				}
				_ = probe.Rollback(context.WithoutCancel(ctx))
			}
			switch tc.change {
			case "revoked":
				_, err = blocker.Exec(ctx, `UPDATE api_tokens SET revoked_at=$2 WHERE id=$1`, caller.Claims().Session, f.clock())
			case "role":
				_, err = blocker.Exec(ctx, `UPDATE organization_memberships SET role='member' WHERE id=$1`, f.admin.Membership.ID)
			case "expired":
				f.advance(2 * time.Hour)
			}
			if err != nil {
				t.Fatal(err)
			}
			var expected string
			if err := blocker.QueryRow(ctx, scimPairingSnapshotSQL).Scan(&expected); err != nil {
				t.Fatal(err)
			}
			if err := blocker.Commit(ctx); err != nil {
				t.Fatal(err)
			}
			select {
			case err := <-done:
				if err == nil {
					t.Fatal("stale authority issued paired token")
				}
			case <-ctx.Done():
				t.Fatal(ctx.Err())
			}
			if scimPairingSnapshot(t, f) != expected {
				t.Fatal("rejected issuer left token or audit effects")
			}
		})
	}
}

func TestSCIMPairingTokenRevalidatesAfterAuditDelay(t *testing.T) {
	f := newBindingFixture(t)
	var once sync.Once
	store := f.tracedStore(t, func(_ context.Context, _ *pgx.Conn, sql string) {
		if strings.Contains(sql, "INSERT INTO identity_events") {
			once.Do(func() { f.advance(2 * time.Hour) })
		}
	})
	before := scimPairingSnapshot(t, f)
	_, err := store.SCIM().IssueToken(f.adminCtx, scim.IssueTokenCommand{RequestID: "late-pairing", ActorPrincipalID: f.admin.User.ID, OrganizationID: f.admin.Organization.ID, OIDCProviderID: &f.providerID, TokenID: f.newID("scimtoken"), TokenHash: "late-pairing-hash", Name: "Late", Scopes: []string{domain.SCIMScopeWrite}, CreatedAt: f.clock()})
	if !errors.Is(err, callercontext.ErrInvalid) || scimPairingSnapshot(t, f) != before {
		t.Fatalf("audit delay committed after caller expiration: %v", err)
	}
}

func TestSCIMPairingReprovisionLocksRevokedProvidersBeforeParentsAndToken(t *testing.T) {
	for _, revokeToken := range []bool{false, true} {
		name := "still_authorized"
		if revokeToken {
			name = "token_revoked_during_wait"
		}
		t.Run(name, func(t *testing.T) {
			f := newBindingFixture(t)
			s := pairingService(t, f)
			auth := pairingAuthorization(t, f, s, &f.providerID)
			user, err := s.CreateUser(t.Context(), auth, pairedUserInput())
			if err != nil {
				t.Fatal(err)
			}
			other := f.additionalProvider(t, f.admin.Organization.ID, "revoked-method")
			bound, err := f.controls.Bind(f.adminCtx, externalidentities.BindInput{RequestID: "other-method", ActorPrincipalID: f.admin.User.ID, MembershipID: user.Membership.ID, ProviderID: other.ID, Subject: "other-subject"})
			if err != nil {
				t.Fatal(err)
			}
			if _, err := f.controls.Unbind(f.adminCtx, externalidentities.UnbindInput{RequestID: "revoke-method", ActorPrincipalID: f.admin.User.ID, Scope: "organization", MembershipID: user.Membership.ID, BindingID: bound.ID}); err != nil {
				t.Fatal(err)
			}
			if err := s.DeleteUser(t.Context(), auth, user.Membership.ID, nil); err != nil {
				t.Fatal(err)
			}
			ctx, cancel := context.WithTimeout(t.Context(), 15*time.Second)
			var workers sync.WaitGroup
			defer func() { cancel(); workers.Wait() }()
			blocker, err := f.pool.Begin(ctx)
			if err != nil {
				t.Fatal(err)
			}
			defer func() { _ = blocker.Rollback(context.WithoutCancel(ctx)) }()
			if _, err := blocker.Exec(ctx, `SELECT id FROM oidc_providers WHERE id=$1 FOR UPDATE`, other.ID); err != nil {
				t.Fatal(err)
			}
			waiting := make(chan uint32, 1)
			var once sync.Once
			store := f.tracedStore(t, func(_ context.Context, conn *pgx.Conn, sql string) {
				if strings.Contains(sql, "FROM oidc_providers") && strings.Contains(sql, "FOR UPDATE") {
					once.Do(func() { waiting <- conn.PgConn().PID() })
				}
			})
			traced, err := scim.NewService(scim.Config{Repository: store.SCIM(), NewID: f.newID, NewOpaque: credentials.NewOpaqueToken, Now: f.clock})
			if err != nil {
				t.Fatal(err)
			}
			done := make(chan error, 1)
			workers.Go(func() { _, err := traced.CreateUser(ctx, auth, pairedUserInput()); done <- err })
			select {
			case pid := <-waiting:
				waitForDatabaseLock(t, ctx, f.pool, pid)
			case err := <-done:
				t.Fatalf("reprovision skipped revoked Provider lock: %v", err)
			case <-ctx.Done():
				t.Fatal(ctx.Err())
			}
			probe, err := f.pool.Begin(ctx)
			if err != nil {
				t.Fatal(err)
			}
			for _, row := range []struct{ table, id string }{{"users", user.User.ID}, {"organizations", auth.OrganizationID}, {"organization_memberships", user.Membership.ID}, {"scim_tokens", auth.TokenID}} {
				if _, err := probe.Exec(ctx, `SELECT id FROM `+row.table+` WHERE id=$1 FOR UPDATE NOWAIT`, row.id); err != nil {
					_ = probe.Rollback(context.WithoutCancel(ctx))
					t.Fatalf("reprovision held %s before Provider: %v", row.table, err)
				}
			}
			_ = probe.Rollback(context.WithoutCancel(ctx))
			if revokeToken {
				if err := s.RevokeToken(ctx, f.admin.User.ID, auth.TokenID); err != nil {
					t.Fatal(err)
				}
			}
			before := scimPairingSnapshot(t, f)
			if err := blocker.Rollback(ctx); err != nil {
				t.Fatal(err)
			}
			select {
			case err := <-done:
				if revokeToken {
					if !errors.Is(err, domain.ErrUnauthenticated) || scimPairingSnapshot(t, f) != before {
						t.Fatalf("revoked SCIM token reprovisioned after lock wait: %v", err)
					}
				} else if err != nil {
					t.Fatal(err)
				}
			case <-ctx.Done():
				t.Fatal(ctx.Err())
			}
		})
	}
}
