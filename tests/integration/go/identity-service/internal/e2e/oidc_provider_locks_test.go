package e2e

import (
	"context"
	"os"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/tf4fun/antnest-platform/services/identity-service/internal/oidcflow"
)

func TestOIDCProviderMutationsLockProviderBeforeActor(t *testing.T) {
	databaseURL := os.Getenv("ANTNEST_IDENTITY_TEST_DATABASE_URL")
	if databaseURL == "" {
		t.Skip("ANTNEST_IDENTITY_TEST_DATABASE_URL is not set")
	}
	for _, operation := range []string{"upsert", "disable"} {
		t.Run(operation, func(t *testing.T) {
			f := newOIDCAdmissionFixture(t, databaseURL)
			provider, err := f.store.OIDC().FindProvider(t.Context(), f.admin.Organization.ID, "workforce")
			if err != nil {
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
			if _, err := blocker.Exec(ctx, `SELECT id FROM oidc_providers WHERE id=$1 FOR UPDATE`, provider.ID); err != nil {
				t.Fatal(err)
			}
			atProvider := make(chan uint32, 1)
			var captured sync.Once
			store := f.tracedStore(t, func(_ context.Context, conn *pgx.Conn, sql string) {
				if strings.Contains(sql, "FROM oidc_providers") && strings.Contains(sql, "FOR UPDATE") || strings.Contains(sql, "INSERT INTO oidc_providers") {
					captured.Do(func() { atProvider <- conn.PgConn().PID() })
				}
			})
			done := make(chan error, 1)
			workers.Go(func() {
				var err error
				if operation == "disable" {
					_, err = store.OIDC().SetProviderEnabled(ctx, oidcflow.SetProviderEnabledCommand{RequestID: "lock-order", ActorPrincipalID: f.admin.User.ID, OrganizationID: provider.OrganizationID, Name: provider.Name, Enabled: false, UpdatedAt: f.time()})
				} else {
					provider.Revision++
					_, err = store.OIDC().UpsertProvider(ctx, oidcflow.UpsertProviderCommand{RequestID: "lock-order", ActorPrincipalID: f.admin.User.ID, Provider: provider})
				}
				done <- err
			})
			select {
			case pid := <-atProvider:
				waitForDatabaseLock(t, ctx, f.pool, pid)
			case err := <-done:
				t.Fatalf("mutation bypassed Provider lock: %v", err)
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
				t.Fatalf("mutation held actor while waiting for Provider, reversing callback order: %v", lockErr)
			}
			if err := blocker.Rollback(ctx); err != nil {
				t.Fatal(err)
			}
			select {
			case err := <-done:
				if err != nil {
					t.Fatal(err)
				}
			case <-ctx.Done():
				t.Fatal(ctx.Err())
			}
		})
	}
}
