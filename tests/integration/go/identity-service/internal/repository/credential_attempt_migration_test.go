package repository

import (
	"bytes"
	"errors"
	"reflect"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgconn"
)

func TestCredentialAttemptMigrationPreservesAuthorityAndHasOnlyBoundedHashedState(t *testing.T) {
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
		if migration.name > "0008_scim_oidc_pairing.sql" {
			continue
		}
		if _, err := pool.Exec(ctx, string(migration.body)); err != nil {
			t.Fatal(err)
		}
		if _, err := pool.Exec(ctx, `INSERT INTO schema_migrations (name, checksum) VALUES ($1, $2)`, migration.name, migration.checksum); err != nil {
			t.Fatal(err)
		}
	}
	now := time.Date(2026, 10, 13, 0, 0, 0, 0, time.UTC)
	for _, statement := range []string{
		`INSERT INTO organizations (id, slug, name, created_at, updated_at) VALUES ('org-1', 'legacy', 'Legacy', $1, $1)`,
		`INSERT INTO users (id, system_role, created_at, updated_at) VALUES ('user-1', 'user', $1, $1)`,
		`INSERT INTO organization_memberships (id, organization_id, user_id, email, display_name, role, source, created_at, updated_at) VALUES ('member-1', 'org-1', 'user-1', 'legacy@example.test', 'Legacy', 'member', 'local', $1, $1)`,
		`INSERT INTO local_credentials (user_id, password_hash, created_at, updated_at) VALUES ('user-1', 'existing-opaque-hash', $1, $1)`,
		`INSERT INTO api_tokens (id, token_hash, user_id, organization_id, membership_id, issued_at, expires_at, public_session_id, idle_expires_at, last_used_at) VALUES ('token-1', 'existing-token-hash', 'user-1', 'org-1', 'member-1', $1, $1::timestamptz + interval '1 hour', 'public-1', $1::timestamptz + interval '15 minutes', $1)`,
	} {
		if _, err := pool.Exec(ctx, statement, now); err != nil {
			t.Fatal(err)
		}
	}
	snapshot := func() []byte {
		t.Helper()
		var value []byte
		if err := pool.QueryRow(ctx, `SELECT jsonb_build_object(
			'users', (SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM users t),
			'organizations', (SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM organizations t),
			'memberships', (SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM organization_memberships t),
			'credentials', (SELECT jsonb_agg(to_jsonb(t) ORDER BY user_id) FROM local_credentials t),
			'tokens', (SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM api_tokens t))`).Scan(&value); err != nil {
			t.Fatal(err)
		}
		return value
	}
	before := snapshot()
	if err := ApplyMigrations(ctx, pool); err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(before, snapshot()) {
		t.Fatal("credential attempt migration changed existing authority")
	}
	var columns []string
	if err := pool.QueryRow(ctx, `SELECT array_agg(column_name::text ORDER BY ordinal_position)
		FROM information_schema.columns WHERE table_schema=current_schema() AND table_name='credential_attempts'`).Scan(&columns); err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(columns, []string{"scope", "key_hash", "window_start", "failures", "locked_until"}) {
		t.Fatalf("missing bounded attempt state or unexpected identity columns: %v", columns)
	}
	key := bytes.Repeat([]byte{7}, 32)
	for _, scope := range []string{"organization", "login_account", "password_change_user"} {
		if _, err := pool.Exec(ctx, `INSERT INTO credential_attempts (scope,key_hash,window_start,failures,locked_until) VALUES ($1,$2,$3,CASE WHEN $1='organization' THEN 100 ELSE 5 END,$4)`, scope, key, now, now.Add(time.Second)); err != nil {
			t.Fatal(err)
		}
	}
	if err := ApplyMigrations(ctx, pool); err != nil {
		t.Fatal(err)
	}
	var preserved int
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM credential_attempts WHERE key_hash=$1 AND window_start=$2 AND failures=CASE WHEN scope='organization' THEN 100 ELSE 5 END AND locked_until=$3`, key, now, now.Add(time.Second)).Scan(&preserved); err != nil || preserved != 3 {
		t.Fatalf("migration restart changed attempt state: count=%d error=%v", preserved, err)
	}
	for _, invalid := range []struct {
		name, scope string
		key         []byte
		failures    int
	}{
		{"raw scope", "email", key, 0},
		{"short digest", "login_account", key[:31], 0},
		{"long digest", "login_account", append(bytes.Clone(key), 1), 0},
		{"negative counter", "login_account", bytes.Repeat([]byte{8}, 32), -1},
		{"account saturation", "login_account", bytes.Repeat([]byte{8}, 32), 16},
		{"user saturation", "password_change_user", bytes.Repeat([]byte{8}, 32), 16},
		{"organization saturation", "organization", bytes.Repeat([]byte{8}, 32), 111},
	} {
		t.Run(invalid.name, func(t *testing.T) {
			_, err := pool.Exec(ctx, `INSERT INTO credential_attempts (scope,key_hash,window_start,failures) VALUES ($1,$2,$3,$4)`, invalid.scope, invalid.key, now, invalid.failures)
			var constraint *pgconn.PgError
			if !errors.As(err, &constraint) || constraint.Code != "23514" {
				t.Fatalf("invalid attempt state escaped constraints: %v", err)
			}
		})
	}
	_, err = pool.Exec(ctx, `INSERT INTO credential_attempts (scope,key_hash,window_start,failures) VALUES ('login_account',$1,$2,0)`, key, now)
	var duplicate *pgconn.PgError
	if !errors.As(err, &duplicate) || duplicate.Code != "23505" {
		t.Fatalf("scope/digest pair is not unique: %v", err)
	}
}
