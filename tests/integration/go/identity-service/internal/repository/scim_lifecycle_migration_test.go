package repository

import (
	"errors"
	"fmt"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgconn"
)

func TestSCIMLifecycleMigrationBackfillsOnlyUnambiguousIssuerEvidence(t *testing.T) {
	pool := browserMigrationPool(t)
	ctx := t.Context()
	plan, err := loadMigrationPlan()
	if err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `CREATE TABLE schema_migrations (name TEXT PRIMARY KEY, checksum TEXT NOT NULL, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())`); err != nil {
		t.Fatal(err)
	}
	for _, step := range plan {
		if step.name > "0009_credential_attempts.sql" {
			continue
		}
		if _, err := pool.Exec(ctx, string(step.body)); err != nil {
			t.Fatal(err)
		}
		if _, err := pool.Exec(ctx, `INSERT INTO schema_migrations (name,checksum) VALUES ($1,$2)`, step.name, step.checksum); err != nil {
			t.Fatal(err)
		}
	}
	created := time.Date(2024, 2, 29, 11, 22, 33, 456789000, time.UTC)
	expires := time.Date(2025, 2, 28, 11, 22, 33, 456789000, time.UTC)
	for _, query := range []string{
		`INSERT INTO organizations (id,slug,name,created_at,updated_at) VALUES ('org-1','one','One',$1,$1),('org-2','two','Two',$1,$1)`,
		`INSERT INTO users (id,system_role,created_at,updated_at) VALUES ('issuer-a','user',$1,$1),('issuer-b','user',$1,$1)`,
	} {
		if _, err := pool.Exec(ctx, query, created); err != nil {
			t.Fatal(err)
		}
	}
	cases := []struct {
		id, wantIssuer string
		actors         []string
		eventType      string
		foreignOrg     bool
		wrongType      bool
		revoked        bool
	}{
		{id: "known", wantIssuer: "issuer-a", actors: []string{"issuer-a"}},
		{id: "repeated", wantIssuer: "issuer-a", actors: []string{"issuer-a", "issuer-a"}},
		{id: "ambiguous", actors: []string{"issuer-a", "issuer-b"}},
		{id: "missing"},
		{id: "deleted-issuer", actors: []string{"missing-user"}},
		{id: "mixed-ambiguity", actors: []string{"issuer-a", "missing-user"}},
		{id: "foreign-audit", actors: []string{"issuer-a"}, foreignOrg: true},
		{id: "wrong-subject", actors: []string{"issuer-a"}, wrongType: true},
		{id: "wrong-event", actors: []string{"issuer-a"}, eventType: "scim_token.revoked"},
		{id: "revoked", wantIssuer: "issuer-a", actors: []string{"issuer-a"}, revoked: true},
	}
	for _, tc := range cases {
		var revokedAt *time.Time
		if tc.revoked {
			value := created.Add(time.Hour)
			revokedAt = &value
		}
		if _, err := pool.Exec(ctx, `INSERT INTO scim_tokens
			(id,organization_id,token_hash,name,scopes,created_at,revoked_at,last_used_at)
			VALUES ($1,'org-1',$2,'Legacy','{scim:read,scim:write}',$3,$4,$3)`, tc.id, "hash-"+tc.id, created, revokedAt); err != nil {
			t.Fatal(err)
		}
		org, subject, eventType := "org-1", "scim_token", tc.eventType
		if eventType == "" {
			eventType = "scim_token.issued"
		}
		if tc.foreignOrg {
			org = "org-2"
		}
		if tc.wrongType {
			subject = "user"
		}
		for i, actor := range tc.actors {
			if _, err := pool.Exec(ctx, `INSERT INTO identity_events
				(id,organization_id,actor_principal_id,event_type,subject_type,subject_id,created_at)
				VALUES ($1,$2,$3,$4,$5,$6,$7)`, fmt.Sprintf("event-%s-%d", tc.id, i), org, actor, eventType, subject, tc.id, created); err != nil {
				t.Fatal(err)
			}
		}
	}
	snapshot := func(full bool) string {
		t.Helper()
		projection := "to_jsonb(t)-ARRAY['expires_at','issued_by','issuer_review_required']"
		if full {
			projection = "to_jsonb(t)"
		}
		var state string
		if err := pool.QueryRow(ctx, `SELECT jsonb_build_object(
			'tokens',(SELECT jsonb_agg(`+projection+` ORDER BY id) FROM scim_tokens t),
			'events',(SELECT jsonb_agg(to_jsonb(e) ORDER BY id) FROM identity_events e))::text`).Scan(&state); err != nil {
			t.Fatal(err)
		}
		return state
	}
	before := snapshot(false)
	if _, err := pool.Exec(ctx, `CREATE FUNCTION reject_scim_migration_journal() RETURNS trigger LANGUAGE plpgsql AS $$
		BEGIN IF NEW.name='0010_scim_lifecycle.sql' THEN RAISE EXCEPTION 'SCIM migration receipt rollback'; END IF; RETURN NEW; END $$;
		CREATE TRIGGER reject_scim_migration_journal BEFORE INSERT ON schema_migrations FOR EACH ROW EXECUTE FUNCTION reject_scim_migration_journal()`); err != nil {
		t.Fatal(err)
	}
	report, err := ApplyMigrationsWithSummary(ctx, pool)
	var migrationError *pgconn.PgError
	if !errors.As(err, &migrationError) || migrationError.Code != "P0001" || migrationError.Message != "SCIM migration receipt rollback" || report != (MigrationSummary{}) || snapshot(false) != before {
		t.Fatalf("failed migration exposed successful backfill or changed state: %+v %v", report, err)
	}
	var hasExpiry bool
	if err := pool.QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid='scim_tokens'::regclass AND attname='expires_at' AND NOT attisdropped)`).Scan(&hasExpiry); err != nil || hasExpiry {
		t.Fatalf("failed migration retained partial schema: %v", err)
	}
	if _, err := pool.Exec(ctx, `DROP TRIGGER reject_scim_migration_journal ON schema_migrations; DROP FUNCTION reject_scim_migration_journal()`); err != nil {
		t.Fatal(err)
	}
	report, err = ApplyMigrationsWithSummary(ctx, pool)
	if err != nil {
		t.Fatal(err)
	}
	if report.SCIMTokens != len(cases) || report.UnknownSCIMIssuers != 7 {
		t.Errorf("committed migration lost exact aggregate backfill counts: %+v", report)
	}
	for _, tc := range cases {
		t.Run(tc.id, func(t *testing.T) {
			var expiration time.Time
			var issuer *string
			var review bool
			var revokedAt *time.Time
			if err := pool.QueryRow(ctx, `SELECT expires_at,issued_by,issuer_review_required,revoked_at FROM scim_tokens WHERE id=$1`, tc.id).
				Scan(&expiration, &issuer, &review, &revokedAt); err != nil {
				t.Fatal(err)
			}
			if !expiration.Equal(expires) || (issuer == nil) != (tc.wantIssuer == "") || issuer != nil && *issuer != tc.wantIssuer || review != (tc.wantIssuer == "") || (revokedAt != nil) != tc.revoked {
				t.Fatalf("migration expiry=%s issuer=%v review=%v revoked=%v", expiration, issuer, review, revokedAt)
			}
		})
	}
	if snapshot(false) != before {
		t.Fatal("migration changed legacy credential, revocation, usage or audit history")
	}
	after := snapshot(true)
	if replay, err := ApplyMigrationsWithSummary(ctx, pool); err != nil || replay != (MigrationSummary{}) || snapshot(true) != after {
		t.Fatalf("migration replay changed lifecycle metadata: %v", err)
	}
	for _, tc := range []struct{ assignment, code string }{
		{"expires_at=NULL", "23502"},
		{"expires_at=created_at", "23514"},
		{"expires_at='infinity'", "23514"},
		{"expires_at='-infinity'", "23514"},
		{"issued_by=NULL,issuer_review_required=FALSE", "23514"},
		{"issued_by='nonexistent-user'", "23503"},
	} {
		_, err := pool.Exec(ctx, `UPDATE scim_tokens SET `+tc.assignment+` WHERE id='known'`)
		var pgError *pgconn.PgError
		if !errors.As(err, &pgError) || pgError.Code != tc.code {
			t.Errorf("invalid lifecycle shape %s error=%v want=%s", tc.assignment, err, tc.code)
		}
	}
	if snapshot(true) != after {
		t.Fatal("invalid lifecycle update changed persisted metadata")
	}
}
