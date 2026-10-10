package repository

import (
	"context"
	"fmt"
	"os"
	"regexp"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

func browserMigrationPool(t *testing.T) *pgxpool.Pool {
	t.Helper()
	databaseURL := os.Getenv("ANTNEST_IDENTITY_TEST_DATABASE_URL")
	if databaseURL == "" {
		t.Skip("ANTNEST_IDENTITY_TEST_DATABASE_URL is not set")
	}
	admin, err := pgxpool.New(t.Context(), databaseURL)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(admin.Close)
	schema := pgx.Identifier{fmt.Sprintf("browser_migration_%d", time.Now().UnixNano())}.Sanitize()
	if _, err := admin.Exec(t.Context(), "CREATE SCHEMA "+schema); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		if _, err := admin.Exec(ctx, "DROP SCHEMA "+schema+" CASCADE"); err != nil {
			t.Errorf("remove migration schema: %v", err)
		}
	})
	config, err := ParsePoolConfig(databaseURL)
	if err != nil {
		t.Fatal(err)
	}
	config.ConnConfig.RuntimeParams["search_path"] = schema
	pool, err := pgxpool.NewWithConfig(t.Context(), config)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)
	return pool
}

func TestBrowserSessionMigrationPreservesOldAuthorityAndStablePublicReferences(t *testing.T) {
	pool := browserMigrationPool(t)
	ctx := t.Context()
	plan, err := loadMigrationPlan()
	if err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `CREATE TABLE schema_migrations (name TEXT PRIMARY KEY, checksum TEXT NOT NULL, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())`); err != nil {
		t.Fatal(err)
	}
	for _, migration := range plan {
		if migration.name > "0003_encryption_key_rotation.sql" {
			continue
		}
		if _, err := pool.Exec(ctx, string(migration.body)); err != nil {
			t.Fatal(err)
		}
		if _, err := pool.Exec(ctx, `INSERT INTO schema_migrations (name, checksum) VALUES ($1, $2)`, migration.name, migration.checksum); err != nil {
			t.Fatal(err)
		}
	}
	now := time.Date(2026, 10, 10, 12, 0, 0, 0, time.UTC)
	for _, statement := range []string{
		`INSERT INTO organizations (id, slug, name, created_at, updated_at) VALUES ('org-1', 'legacy', 'Legacy', $1, $1)`,
		`INSERT INTO users (id, system_role, created_at, updated_at) VALUES ('user-1', 'user', $1, $1)`,
		`INSERT INTO organization_memberships (id, organization_id, user_id, email, display_name, role, source, created_at, updated_at) VALUES ('member-1', 'org-1', 'user-1', 'legacy@example.test', 'Legacy', 'member', 'local', $1, $1)`,
	} {
		if _, err := pool.Exec(ctx, statement, now); err != nil {
			t.Fatal(err)
		}
	}
	type legacyToken struct {
		id                string
		lastUsed, revoked *time.Time
	}
	lastUsed, revoked := now.Add(10*time.Minute), now.Add(20*time.Minute)
	tokens := []legacyToken{{id: "legacy-1"}, {id: "legacy-2", lastUsed: &lastUsed}, {id: "legacy-3", lastUsed: &lastUsed, revoked: &revoked}}
	for _, token := range tokens {
		if _, err := pool.Exec(ctx, `INSERT INTO api_tokens (id, token_hash, user_id, organization_id, membership_id, issued_at, expires_at, last_used_at, revoked_at) VALUES ($1, $2, 'user-1', 'org-1', 'member-1', $3, $4, $5, $6)`, token.id, token.id+"-hash", now, now.Add(time.Hour), token.lastUsed, token.revoked); err != nil {
			t.Fatal(err)
		}
	}
	if err := ApplyMigrations(ctx, pool); err != nil {
		t.Fatal(err)
	}
	references := make(map[string]string)
	pattern := regexp.MustCompile(`^browsersession_[0-9a-f]{32}$`)
	for _, token := range tokens {
		var id, hash, kind, hint string
		var issued, absolute, idle, used time.Time
		var revokedAt *time.Time
		if err := pool.QueryRow(ctx, `SELECT public_session_id, token_hash, kind, user_agent_hint, issued_at, expires_at, idle_expires_at, last_used_at, revoked_at FROM api_tokens WHERE id = $1`, token.id).Scan(&id, &hash, &kind, &hint, &issued, &absolute, &idle, &used, &revokedAt); err != nil {
			t.Fatal(err)
		}
		if !pattern.MatchString(id) || id == token.id || id == hash || references[id] != "" {
			t.Fatal("migration reused a private or duplicate public reference")
		}
		references[id] = token.id
		wantUsed := now
		if token.lastUsed != nil {
			wantUsed = *token.lastUsed
		}
		if hash != token.id+"-hash" || kind != "browser" || hint != "" || !issued.Equal(now) || !absolute.Equal(now.Add(time.Hour)) || !idle.Equal(absolute) || !used.Equal(wantUsed) || (revokedAt == nil) != (token.revoked == nil) || revokedAt != nil && !revokedAt.Equal(*token.revoked) {
			t.Fatal("migration changed authority or did not initialize legacy metadata")
		}
	}
	if err := ApplyMigrations(ctx, pool); err != nil {
		t.Fatal(err)
	}
	for publicID, privateID := range references {
		var got string
		if err := pool.QueryRow(ctx, `SELECT public_session_id FROM api_tokens WHERE id = $1`, privateID).Scan(&got); err != nil || got != publicID {
			t.Fatalf("reapplying migration changed a public reference: %v", err)
		}
	}
}
