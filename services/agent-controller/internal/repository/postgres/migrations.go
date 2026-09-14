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

const migrationJournalSQL = `
CREATE SCHEMA IF NOT EXISTS agent_controller;
CREATE TABLE IF NOT EXISTS agent_controller.schema_migrations (
    version BIGINT PRIMARY KEY CHECK (version > 0),
    name TEXT NOT NULL UNIQUE,
    checksum TEXT NOT NULL CHECK (checksum ~ '^[0-9a-f]{64}$'),
    applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
)`

type schemaMigration struct {
	version int64
	name    string
	sql     string
}

var (
	initialSchemaSQL = mustMigration("migrations/0001_initial.sql")
	ownerBindingSQL  = mustMigration("migrations/0002_enforce_owner_binding.sql")
	schemaMigrations = []schemaMigration{
		{version: 1, name: "initial_agent_controller_schema", sql: initialSchemaSQL},
		{version: 2, name: "enforce_owner_binding", sql: ownerBindingSQL},
		{version: 4, name: "identity_revocations", sql: mustMigration("migrations/0004_identity_revocations.sql")},
		{version: 5, name: "agent_authorization", sql: mustMigration("migrations/0005_agent_authorization.sql")},
		{version: 6, name: "resolve_delete_runtime_source", sql: mustMigration("migrations/0006_resolve_delete_runtime_source.sql")},
		{version: 8, name: "runtime_missing_event", sql: mustMigration("migrations/0008_runtime_missing_event.sql")},
		{version: 9, name: "temporal_lifecycles", sql: mustMigration("migrations/0009_temporal_lifecycles.sql")},
		{version: 10, name: "runtime_availability", sql: mustMigration("migrations/0010_runtime_availability.sql")},
		{version: 11, name: "agent_state_hierarchy", sql: mustMigration("migrations/0011_agent_state_hierarchy.sql")},
		{version: 12, name: "execution_configuration_sync", sql: mustMigration("migrations/0012_execution_configuration_sync.sql")},
		{version: 13, name: "lifecycle_settlement", sql: mustMigration("migrations/0013_lifecycle_settlement.sql")},
	}
)

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
	applied, err := readMigrationRecords(ctx, transaction)
	if err != nil {
		return err
	}
	if err := validateMigrationHistory(applied); err != nil {
		return err
	}
	for _, candidate := range schemaMigrations[len(applied):] {
		if _, err := transaction.Exec(ctx, candidate.sql); err != nil {
			return fmt.Errorf("apply Agent Controller migration %d (%s): %w", candidate.version, candidate.name, err)
		}
		if _, err := transaction.Exec(ctx, `
INSERT INTO agent_controller.schema_migrations (version, name, checksum)
VALUES ($1, $2, $3)`, candidate.version, candidate.name, migrationChecksum(candidate.sql)); err != nil {
			return fmt.Errorf("record Agent Controller migration %d (%s): %w", candidate.version, candidate.name, err)
		}
	}
	return transaction.Commit(ctx)
}

type migrationRecord struct {
	version  int64
	name     string
	checksum string
}

func readMigrationRecords(ctx context.Context, transaction *databaseTransaction) ([]migrationRecord, error) {
	rows, err := transaction.Query(ctx, `
SELECT version, name, checksum
FROM agent_controller.schema_migrations
ORDER BY version`)
	if err != nil {
		return nil, fmt.Errorf("read Agent Controller migration journal: %w", err)
	}
	defer rows.Close()
	records := make([]migrationRecord, 0, len(schemaMigrations))
	for rows.Next() {
		var record migrationRecord
		if err := rows.Scan(&record.version, &record.name, &record.checksum); err != nil {
			return nil, fmt.Errorf("scan Agent Controller migration journal: %w", err)
		}
		records = append(records, record)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("iterate Agent Controller migration journal: %w", err)
	}
	return records, nil
}

func validateMigrationHistory(applied []migrationRecord) error {
	if len(applied) > len(schemaMigrations) {
		return fmt.Errorf("agent controller database has migrations newer than this service")
	}
	for index, record := range applied {
		candidate := schemaMigrations[index]
		if record.version != candidate.version {
			return fmt.Errorf("agent controller migration history is not a prefix at version %d", record.version)
		}
		if err := validateMigrationRecord(
			candidate.version,
			candidate.name,
			migrationChecksum(candidate.sql),
			record.name,
			record.checksum,
		); err != nil {
			return err
		}
	}
	return nil
}

func validateMigrationRecord(
	version int64,
	expectedName string,
	expectedChecksum string,
	storedName string,
	storedChecksum string,
) error {
	if storedName != expectedName || storedChecksum != expectedChecksum {
		return fmt.Errorf(
			"agent controller migration drift: version %d stores name=%q checksum=%q, expected name=%q checksum=%q",
			version, storedName, storedChecksum, expectedName, expectedChecksum,
		)
	}
	return nil
}

func migrationChecksum(statement string) string {
	checksum := sha256.Sum256([]byte(statement))
	return hex.EncodeToString(checksum[:])
}

func mustMigration(path string) string {
	payload, err := migrationFiles.ReadFile(path)
	if err != nil {
		panic(err)
	}
	return string(payload)
}
