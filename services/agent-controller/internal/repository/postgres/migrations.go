package postgres

import (
	"context"
	"crypto/sha256"
	"embed"
	"encoding/hex"
	"fmt"
)

//go:embed migrations/*.sql
var migrationFiles embed.FS

const migrationLockID int64 = 0x41544e4553544147

var initialSchemaSQL = mustMigration("migrations/0001_initial.sql")

func (repository *Repository) Migrate(ctx context.Context) error {
	transaction, err := repository.pool.Begin(ctx)
	if err != nil {
		return fmt.Errorf("begin Agent Controller migration: %w", err)
	}
	defer func() { _ = transaction.Rollback(ctx) }()
	if _, err := transaction.Exec(ctx, "SELECT pg_advisory_xact_lock($1)", migrationLockID); err != nil {
		return fmt.Errorf("lock Agent Controller migration: %w", err)
	}
	if _, err := transaction.Exec(ctx, initialSchemaSQL); err != nil {
		return fmt.Errorf("apply Agent Controller initial schema: %w", err)
	}
	checksum := sha256.Sum256([]byte(initialSchemaSQL))
	if _, err := transaction.Exec(ctx, `
INSERT INTO agent_controller.schema_migrations (version, name, checksum)
VALUES (1, 'initial_agent_controller_schema', $1)
ON CONFLICT (version) DO UPDATE
SET checksum = agent_controller.schema_migrations.checksum
WHERE agent_controller.schema_migrations.name = EXCLUDED.name
  AND agent_controller.schema_migrations.checksum = EXCLUDED.checksum`, hex.EncodeToString(checksum[:])); err != nil {
		return fmt.Errorf("record Agent Controller migration: %w", err)
	}
	return transaction.Commit(ctx)
}

func mustMigration(path string) string {
	payload, err := migrationFiles.ReadFile(path)
	if err != nil {
		panic(err)
	}
	return string(payload)
}
