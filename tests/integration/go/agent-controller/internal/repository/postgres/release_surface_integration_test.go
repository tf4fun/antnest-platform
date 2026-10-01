package postgres

import (
	"context"
	"os"
	"testing"
)

func TestFreshReleaseSchemaHasCurrentSkillsWithoutLegacyMigration(t *testing.T) {
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
	for attempt := 0; attempt < 2; attempt++ {
		if err := repository.Migrate(ctx); err != nil {
			t.Fatalf("fresh release startup %d: %v", attempt, err)
		}
	}
	var legacyTables, legacyMigrations, currentTables int
	if err := repository.pool.QueryRow(ctx, `SELECT count(*) FROM information_schema.tables
WHERE table_schema = 'agent_controller' AND table_name LIKE '%legacy%'`).Scan(&legacyTables); err != nil {
		t.Fatal(err)
	}
	if err := repository.pool.QueryRow(ctx, `SELECT count(*) FROM agent_controller.schema_migrations
WHERE name LIKE '%legacy%'`).Scan(&legacyMigrations); err != nil {
		t.Fatal(err)
	}
	if err := repository.pool.QueryRow(ctx, `SELECT count(*) FROM information_schema.tables
WHERE table_schema = 'agent_controller' AND table_name IN
('agent_template_revisions', 'agent_skill_preparation_intents', 'skill_learning_policies')`).Scan(&currentTables); err != nil {
		t.Fatal(err)
	}
	if legacyTables != 0 || legacyMigrations != 0 || currentTables != 3 {
		t.Fatalf("fresh schema: legacy tables=%d, migrations=%d, current Skill tables=%d", legacyTables, legacyMigrations, currentTables)
	}
}
