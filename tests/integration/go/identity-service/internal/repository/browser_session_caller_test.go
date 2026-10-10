package repository

import (
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"errors"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/tf4fun/antnest-platform/services/identity-service/internal/callercontext"
	"github.com/tf4fun/antnest-platform/services/identity-service/internal/credentials"
	"github.com/tf4fun/antnest-platform/services/identity-service/internal/identityid"
)

func TestBrowserCallerRevalidationUsesItsTransactionWithOnePoolConnection(t *testing.T) {
	pool := browserMigrationPool(t)
	if err := ApplyMigrations(t.Context(), pool); err != nil {
		t.Fatal(err)
	}
	now := time.Date(2026, 10, 11, 1, 0, 0, 0, time.UTC)
	for _, sql := range []string{
		`INSERT INTO organizations (id, slug, name, created_at, updated_at) VALUES ('org-1', 'transaction', 'Transaction', $1, $1)`,
		`INSERT INTO users (id, system_role, created_at, updated_at) VALUES ('user-1', 'user', $1, $1)`,
		`INSERT INTO organization_memberships (id, organization_id, user_id, email, display_name, role, source, created_at, updated_at) VALUES ('member-1', 'org-1', 'user-1', 'member@example.test', 'Member', 'member', 'local', $1, $1)`,
	} {
		if _, err := pool.Exec(t.Context(), sql, now); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := pool.Exec(t.Context(), `INSERT INTO api_tokens
		(id, token_hash, public_session_id, user_id, organization_id, membership_id, issued_at, last_used_at, idle_expires_at, expires_at)
		VALUES ('sid-1', $1, 'public-1', 'user-1', 'org-1', 'member-1', $2, $2, $3, $4)`, credentials.HashToken("ant_api_transaction"), now, now.Add(30*time.Minute), now.Add(time.Hour)); err != nil {
		t.Fatal(err)
	}
	config := pool.Config()
	config.MaxConns, config.MinConns = 1, 0
	single, err := pgxpool.NewWithConfig(t.Context(), config)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(single.Close)
	store, err := New(single, identityid.MustNew, func() time.Time { return now })
	if err != nil {
		t.Fatal(err)
	}
	public, private, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	authority, err := callercontext.NewAuthority(callercontext.Config{
		KID: "test", PrivateKey: private, Keys: callercontext.Keys{"test": public}, Repository: store.LocalAuth(),
		Now: func() time.Time { return now }, NewID: func() string { return identityid.MustNew("authtoken") },
	})
	if err != nil {
		t.Fatal(err)
	}
	_, token, err := authority.Issue(t.Context(), "ant_api_transaction", "session", "")
	if err != nil {
		t.Fatal(err)
	}
	caller, err := authority.AuthenticateSession(t.Context(), token)
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(t.Context(), 3*time.Second)
	defer cancel()
	tx, err := single.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer func() {
		cleanup, stop := context.WithTimeout(context.Background(), 5*time.Second)
		defer stop()
		_ = tx.Rollback(cleanup)
	}()
	if single.Stat().MaxConns() != 1 || single.Stat().AcquiredConns() != 1 {
		t.Fatal("transaction did not occupy the pool's only connection")
	}
	wantIdle := now.Add(5 * time.Minute)
	if _, err := tx.Exec(ctx, `UPDATE api_tokens SET idle_expires_at = $2 WHERE id = $1`, "sid-1", wantIdle); err != nil {
		t.Fatal(err)
	}
	resolve := func(ctx context.Context, sid string, observed time.Time) (callercontext.Session, error) {
		return store.resolveBrowserSession(ctx, tx, "id", sid, observed)
	}
	live, err := caller.Revalidate(ctx, resolve)
	if err != nil || live.ID != "sid-1" || !live.IdleExpiresAt.Equal(wantIdle) || !live.ExpiresAt.Equal(now.Add(time.Hour)) || live.ActivityIntervalMS != 30000 {
		t.Fatalf("transaction revalidation borrowed another connection or missed its own snapshot: %v", err)
	}
	if _, err := tx.Exec(ctx, `UPDATE api_tokens SET revoked_at = $2 WHERE id = $1`, "sid-1", now); err != nil {
		t.Fatal(err)
	}
	if denied, err := caller.Revalidate(ctx, resolve); !errors.Is(err, callercontext.ErrInvalid) || denied != (callercontext.Session{}) {
		t.Fatalf("transaction's own revocation did not deny authority: %v", err)
	}
}
