package postgres

import (
	"context"
	"os"
	"testing"
)

func TestLegacySystemSkillsMigrationBackfillsOnlyPreCutoverAgents(t *testing.T) {
	databaseURL := os.Getenv("ANTNEST_AGENT_CONTROLLER_TEST_DATABASE_URL")
	if databaseURL == "" {
		t.Skip("ANTNEST_AGENT_CONTROLLER_TEST_DATABASE_URL is not set")
	}
	ctx := context.Background()
	repository, err := Open(ctx, databaseURL)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(repository.Close)
	resetCatalogSchema(t, ctx, repository)
	tx, err := repository.pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx, migrationJournalSQL); err != nil {
		t.Fatal(err)
	}
	for _, migration := range schemaMigrations {
		if migration.version >= 18 {
			break
		}
		if _, err := tx.Exec(ctx, migration.sql); err != nil {
			t.Fatalf("apply migration %d: %v", migration.version, err)
		}
		if _, err := tx.Exec(ctx, `INSERT INTO agent_controller.schema_migrations(version,name,checksum) VALUES ($1,$2,$3)`,
			migration.version, migration.name, migrationChecksum(migration.sql)); err != nil {
			t.Fatal(err)
		}
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	insertAgent := func(id, desired, lifecycle, activation string) {
		t.Helper()
		_, err := repository.pool.Exec(ctx, `INSERT INTO agent_controller.agents
		(id,organization_id,owner_user_id,name,desired_state,lifecycle_state,activation_state,access_revision,created_at,updated_at)
		VALUES($1,'org-legacy','user-legacy','Legacy Agent',$2,$3,$4,'access-legacy',NOW(),NOW())`, id, desired, lifecycle, activation)
		if err != nil {
			t.Fatal(err)
		}
	}
	insertAgent("agent-pre-cutover", "enabled", "created", "enabled")
	insertAgent("agent-deleted", "deleted", "deleted", "")
	if err := repository.Migrate(ctx); err != nil {
		t.Fatal(err)
	}
	for id, want := range map[string]bool{"agent-pre-cutover": true, "agent-deleted": false} {
		got, err := repository.LegacySystemSkillsMigrationRequired(ctx, id)
		if err != nil || got != want {
			t.Fatalf("legacy gate for %s = %t, %v, want %t", id, got, err, want)
		}
	}
	insertAgent("agent-after-cutover", "enabled", "created", "enabled")
	if got, err := repository.LegacySystemSkillsMigrationRequired(ctx, "agent-after-cutover"); err != nil || got {
		t.Fatalf("new Agent classified as legacy: %t %v", got, err)
	}
}
