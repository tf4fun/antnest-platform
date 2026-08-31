package postgres

import (
	"context"
	"crypto/sha256"
	"embed"
	"encoding/hex"
	"errors"
	"fmt"

	"github.com/jackc/pgx/v5"
)

//go:embed migrations/*.sql
var migrationFiles embed.FS

const migrationLockID int64 = 0x41544e4553544147

const (
	initialMigrationName = "initial_agent_controller_schema"
	migrationJournalSQL  = `
CREATE SCHEMA IF NOT EXISTS agent_controller;
CREATE TABLE IF NOT EXISTS agent_controller.schema_migrations (
    version BIGINT PRIMARY KEY CHECK (version > 0),
    name TEXT NOT NULL UNIQUE,
    checksum TEXT NOT NULL CHECK (checksum ~ '^[0-9a-f]{64}$'),
    applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
)`
)

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
	if _, err := transaction.Exec(ctx, migrationJournalSQL); err != nil {
		return fmt.Errorf("initialize Agent Controller migration journal: %w", err)
	}
	checksum := sha256.Sum256([]byte(initialSchemaSQL))
	expectedChecksum := hex.EncodeToString(checksum[:])
	var storedName, storedChecksum string
	err = transaction.QueryRow(ctx, `
SELECT name, checksum
FROM agent_controller.schema_migrations
WHERE version = 1`).Scan(&storedName, &storedChecksum)
	switch {
	case errors.Is(err, pgx.ErrNoRows):
		if _, err := transaction.Exec(ctx, initialSchemaSQL); err != nil {
			return fmt.Errorf("apply Agent Controller initial schema: %w", err)
		}
		if _, err := transaction.Exec(ctx, `
INSERT INTO agent_controller.schema_migrations (version, name, checksum)
VALUES (1, $1, $2)`, initialMigrationName, expectedChecksum); err != nil {
			return fmt.Errorf("record Agent Controller migration: %w", err)
		}
	case err != nil:
		return fmt.Errorf("read Agent Controller migration journal: %w", err)
	default:
		if err := validateMigrationRecord(initialMigrationName, expectedChecksum, storedName, storedChecksum); err != nil {
			return err
		}
	}
	return transaction.Commit(ctx)
}

func validateMigrationRecord(expectedName string, expectedChecksum string, storedName string, storedChecksum string) error {
	if storedName != expectedName || storedChecksum != expectedChecksum {
		return fmt.Errorf(
			"agent controller migration drift: version 1 stores name=%q checksum=%q, expected name=%q checksum=%q",
			storedName, storedChecksum, expectedName, expectedChecksum,
		)
	}
	return nil
}

func mustMigration(path string) string {
	payload, err := migrationFiles.ReadFile(path)
	if err != nil {
		panic(err)
	}
	return string(payload)
}
