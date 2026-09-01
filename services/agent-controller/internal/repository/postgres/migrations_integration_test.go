package postgres

import (
	"context"
	"os"
	"testing"
)

func TestMigrationUpgradesAnUnchangedVersionOneDatabase(t *testing.T) {
	databaseURL := os.Getenv("ANTNEST_AGENT_CONTROLLER_TEST_DATABASE_URL")
	if databaseURL == "" {
		t.Skip("ANTNEST_AGENT_CONTROLLER_TEST_DATABASE_URL is not set")
	}
	ctx := context.Background()
	repository, err := Open(ctx, databaseURL)
	if err != nil {
		t.Fatalf("open repository: %v", err)
	}
	t.Cleanup(repository.Close)
	if _, err := repository.pool.Exec(ctx, "DROP SCHEMA IF EXISTS agent_controller CASCADE"); err != nil {
		t.Fatalf("drop Agent Controller schema: %v", err)
	}
	if _, err := repository.pool.Exec(ctx, initialSchemaSQL); err != nil {
		t.Fatalf("apply version-one schema: %v", err)
	}
	if _, err := repository.pool.Exec(ctx, `
INSERT INTO agent_controller.schema_migrations (version, name, checksum)
VALUES (1, $1, $2)`, schemaMigrations[0].name, migrationChecksum(initialSchemaSQL)); err != nil {
		t.Fatalf("record version-one schema: %v", err)
	}

	if err := repository.Migrate(ctx); err != nil {
		t.Fatalf("upgrade Agent Controller schema: %v", err)
	}
	if err := repository.Migrate(ctx); err != nil {
		t.Fatalf("replay Agent Controller migrations: %v", err)
	}
	var count int
	if err := repository.pool.QueryRow(ctx,
		"SELECT count(*) FROM agent_controller.schema_migrations",
	).Scan(&count); err != nil {
		t.Fatalf("count applied migrations: %v", err)
	}
	if count != len(schemaMigrations) {
		t.Fatalf("applied migrations = %d, want %d", count, len(schemaMigrations))
	}
}
