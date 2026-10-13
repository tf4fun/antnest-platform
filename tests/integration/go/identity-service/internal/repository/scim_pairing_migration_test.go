package repository

import (
	"errors"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgconn"
)

func TestSCIMPairingMigrationKeepsLegacyDirectoryOnlyAndEnforcesOrganization(t *testing.T) {
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
		if migration.name > "0007_external_identity_controls.sql" {
			continue
		}
		if _, err := pool.Exec(ctx, string(migration.body)); err != nil {
			t.Fatal(err)
		}
		if _, err := pool.Exec(ctx, `INSERT INTO schema_migrations (name,checksum) VALUES ($1,$2)`, migration.name, migration.checksum); err != nil {
			t.Fatal(err)
		}
	}
	now := time.Date(2026, 10, 11, 1, 0, 0, 0, time.UTC)
	for _, sql := range []string{
		`INSERT INTO organizations (id,slug,name,created_at,updated_at) VALUES ('org-1','one','One',$1,$1),('org-2','two','Two',$1,$1)`,
		`INSERT INTO users (id,system_role,created_at,updated_at) VALUES ('user-1','user',$1,$1)`,
		`INSERT INTO organization_memberships (id,organization_id,user_id,email,display_name,role,source,scim_external_id,scim_user_name,created_at,updated_at) VALUES ('member-1','org-1','user-1','legacy@example.test','Legacy','member','scim','legacy-subject','legacy@example.test',$1,$1)`,
		`INSERT INTO oidc_providers (id,organization_id,name,display_name,issuer,client_id,client_secret_ciphertext,client_secret_nonce,scopes,enabled,revision,authorization_endpoint,token_endpoint,token_endpoint_auth_method,id_token_signing_algs,jwks_uri,created_at,updated_at) VALUES ('provider-1','org-1','one','One','https://id.one.test','client',decode('abcd','hex'),decode('ef01','hex'),'{openid,email}',true,1,'https://id.one.test/auth','https://id.one.test/token','client_secret_basic','{RS256}','https://id.one.test/jwks',$1,$1),('provider-2','org-2','two','Two','https://id.two.test','client',decode('abcd','hex'),decode('ef01','hex'),'{openid,email}',true,1,'https://id.two.test/auth','https://id.two.test/token','client_secret_basic','{RS256}','https://id.two.test/jwks',$1,$1)`,
		`INSERT INTO scim_tokens (id,organization_id,token_hash,name,scopes,created_at) VALUES ('token-1','org-1','legacy-hash','Legacy','{scim:read,scim:write}',$1)`,
	} {
		if _, err := pool.Exec(ctx, sql, now); err != nil {
			t.Fatal(err)
		}
	}
	snapshot := func() string {
		t.Helper()
		var state string
		// Later lifecycle columns have their own migration/backfill gate. Keep
		// this historical assertion strict about every pre-pairing token field.
		if err := pool.QueryRow(ctx, `SELECT jsonb_build_object(
			'membership',(SELECT to_jsonb(m)-'scim_oidc_provider_id' FROM organization_memberships m WHERE id='member-1'),
			'token',(SELECT to_jsonb(t)-ARRAY['oidc_provider_id','expires_at','issued_by','issuer_review_required'] FROM scim_tokens t WHERE id='token-1'),
			'bindings',(SELECT jsonb_agg(to_jsonb(e)) FROM external_identities e),
			'notices',(SELECT jsonb_agg(to_jsonb(n)) FROM external_identity_notices n),
			'events',(SELECT jsonb_agg(to_jsonb(e)) FROM identity_events e))::text`).Scan(&state); err != nil {
			t.Fatal(err)
		}
		return state
	}
	before := snapshot()
	if err := ApplyMigrations(ctx, pool); err != nil {
		t.Fatal(err)
	}
	var tokenPair, memberPair *string
	if err := pool.QueryRow(ctx, `SELECT t.oidc_provider_id,m.scim_oidc_provider_id FROM scim_tokens t CROSS JOIN organization_memberships m WHERE t.id='token-1' AND m.id='member-1'`).Scan(&tokenPair, &memberPair); err != nil {
		t.Fatal(err)
	}
	if tokenPair != nil || memberPair != nil || snapshot() != before {
		t.Fatal("migration invented pairing or changed legacy business state")
	}
	for _, table := range []struct{ name, column, id string }{{"scim_tokens", "oidc_provider_id", "token-1"}, {"organization_memberships", "scim_oidc_provider_id", "member-1"}} {
		_, err := pool.Exec(ctx, `UPDATE `+table.name+` SET `+table.column+`='provider-2' WHERE id=$1`, table.id)
		var pgerr *pgconn.PgError
		if !errors.As(err, &pgerr) || pgerr.Code != "23503" {
			t.Fatalf("%s accepted cross-organization pairing: %v", table.name, err)
		}
		if _, err := pool.Exec(ctx, `UPDATE `+table.name+` SET `+table.column+`='provider-1' WHERE id=$1`, table.id); err != nil {
			t.Fatal(err)
		}
	}
	if err := ApplyMigrations(ctx, pool); err != nil {
		t.Fatal(err)
	}
	if err := pool.QueryRow(ctx, `SELECT t.oidc_provider_id,m.scim_oidc_provider_id FROM scim_tokens t CROSS JOIN organization_memberships m WHERE t.id='token-1' AND m.id='member-1'`).Scan(&tokenPair, &memberPair); err != nil {
		t.Fatal(err)
	}
	if tokenPair == nil || *tokenPair != "provider-1" || memberPair == nil || *memberPair != "provider-1" || snapshot() != before {
		t.Fatal("migration replay changed paired authorization or state")
	}
}
