package repository

import (
	"encoding/json"
	"testing"
	"time"
)

func TestOIDCPolicyMigrationPreservesLegacyAuthorityAndReviewState(t *testing.T) {
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
		if migration.name > "0005_session_revocations.sql" {
			continue
		}
		if _, err := pool.Exec(ctx, string(migration.body)); err != nil {
			t.Fatal(err)
		}
		if _, err := pool.Exec(ctx, `INSERT INTO schema_migrations (name, checksum) VALUES ($1, $2)`, migration.name, migration.checksum); err != nil {
			t.Fatal(err)
		}
	}
	now := time.Date(2026, 10, 11, 1, 0, 0, 0, time.UTC)
	for _, statement := range []string{
		`INSERT INTO organizations (id, slug, name, created_at, updated_at) VALUES ('org-1', 'legacy', 'Legacy', $1, $1)`,
		`INSERT INTO users (id, system_role, created_at, updated_at) VALUES ('user-1', 'user', $1, $1)`,
		`INSERT INTO organization_memberships (id, organization_id, user_id, email, display_name, role, source, created_at, updated_at) VALUES ('member-1', 'org-1', 'user-1', 'legacy@example.test', 'Legacy', 'member', 'local', $1, $1)`,
		`INSERT INTO oidc_providers (id, organization_id, name, display_name, issuer, client_id, client_secret_ciphertext, client_secret_nonce, scopes, enabled, revision, authorization_endpoint, token_endpoint, token_endpoint_auth_method, id_token_signing_algs, jwks_uri, created_at, updated_at) VALUES ('provider-1', 'org-1', 'legacy', 'Legacy', 'https://id.example.test', 'client', decode('abcd', 'hex'), decode('ef01', 'hex'), '{openid,email}', true, 7, 'https://id.example.test/auth', 'https://id.example.test/token', 'client_secret_basic', '{RS256}', 'https://id.example.test/jwks', $1, $1)`,
		`INSERT INTO external_identities (id, organization_id, provider_id, user_id, membership_id, subject, created_at, updated_at) VALUES ('binding-1', 'org-1', 'provider-1', 'user-1', 'member-1', ' legacy subject ', $1, $1)`,
		`INSERT INTO api_tokens (id, token_hash, user_id, organization_id, membership_id, issued_at, expires_at, public_session_id, idle_expires_at, last_used_at) VALUES ('token-1', 'hash', 'user-1', 'org-1', 'member-1', $1, $1::timestamptz + interval '1 hour', 'public-1', $1::timestamptz + interval '15 minutes', $1)`,
	} {
		if _, err := pool.Exec(ctx, statement, now); err != nil {
			t.Fatal(err)
		}
	}
	snapshot := func() string {
		t.Helper()
		var raw []byte
		if err := pool.QueryRow(ctx, `SELECT jsonb_build_object(
			'provider', (SELECT to_jsonb(p) - '{link_policy,link_domains,authoritative,link_policy_review_required}'::text[] FROM oidc_providers p WHERE id='provider-1'),
			'binding', (SELECT to_jsonb(e) FROM external_identities e WHERE id='binding-1'),
			'token', (SELECT to_jsonb(t) FROM api_tokens t WHERE id='token-1'))`).Scan(&raw); err != nil {
			t.Fatal(err)
		}
		var value any
		if err := json.Unmarshal(raw, &value); err != nil {
			t.Fatal(err)
		}
		canonical, _ := json.Marshal(value)
		return string(canonical)
	}
	before := snapshot()
	if err := ApplyMigrations(ctx, pool); err != nil {
		t.Fatal(err)
	}
	if snapshot() != before {
		t.Fatal("migration changed legacy registration, binding or session authority")
	}
	var policy string
	var domains []string
	var authoritative, review bool
	read := func() {
		t.Helper()
		if err := pool.QueryRow(ctx, `SELECT link_policy, link_domains, authoritative, link_policy_review_required FROM oidc_providers WHERE id='provider-1'`).Scan(&policy, &domains, &authoritative, &review); err != nil {
			t.Fatal(err)
		}
	}
	read()
	if policy != "verified_email" || len(domains) != 0 || authoritative || !review {
		t.Fatalf("legacy policy=%s domains=%v authoritative=%t review=%t", policy, domains, authoritative, review)
	}
	if _, err := pool.Exec(ctx, `UPDATE oidc_providers SET link_policy='none', link_policy_review_required=false WHERE id='provider-1'`); err != nil {
		t.Fatal(err)
	}
	if err := ApplyMigrations(ctx, pool); err != nil {
		t.Fatal(err)
	}
	read()
	if policy != "none" || review {
		t.Fatal("restart reset reviewed policy")
	}
	var policyDefault, reviewDefault string
	if err := pool.QueryRow(ctx, `SELECT
		(SELECT column_default FROM information_schema.columns WHERE table_schema=current_schema() AND table_name='oidc_providers' AND column_name='link_policy'),
		(SELECT column_default FROM information_schema.columns WHERE table_schema=current_schema() AND table_name='oidc_providers' AND column_name='link_policy_review_required')`).Scan(&policyDefault, &reviewDefault); err != nil {
		t.Fatal(err)
	}
	if policyDefault != "'none'::text" || reviewDefault != "false" {
		t.Fatalf("new defaults=%q/%q", policyDefault, reviewDefault)
	}
}
