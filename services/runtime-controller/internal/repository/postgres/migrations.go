package postgres

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"fmt"
)

const (
	migrationLockID int64 = 0x41544e4553545254
	bootstrapSQL          = `
CREATE SCHEMA IF NOT EXISTS runtime_controller;

CREATE TABLE IF NOT EXISTS runtime_controller.schema_migrations (
    version BIGINT PRIMARY KEY CHECK (version > 0),
    name TEXT NOT NULL UNIQUE,
    checksum TEXT NOT NULL CHECK (checksum ~ '^[0-9a-f]{64}$'),
    applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
`
	initialSchemaSQL = `
CREATE TABLE IF NOT EXISTS runtime_controller.operations (
    request_id TEXT PRIMARY KEY,
    request_digest TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('initialize_runtime', 'update_runtime', 'disable_runtime', 'enable_runtime', 'delete_runtime')),
    agent_id TEXT NOT NULL,
    runtime_revision TEXT NOT NULL CHECK (runtime_revision ~ '^rtv_[0-9a-f]{32}$'),
    expected_revision TEXT NOT NULL DEFAULT '',
    source_state TEXT NOT NULL CHECK (source_state IN ('uninitialized', 'ready', 'disabled')),
    source_revision TEXT NOT NULL DEFAULT '',
    source_generation BIGINT NOT NULL CHECK (source_generation >= 0),
    source_spec_digest TEXT NOT NULL DEFAULT '',
    target_generation BIGINT NOT NULL CHECK (target_generation > 0),
    target_spec_digest TEXT NOT NULL CHECK (target_spec_digest ~ '^sha256:[0-9a-fA-F]{64}$'),
    attempt BIGINT NOT NULL CHECK (attempt > 0),
    state TEXT NOT NULL CHECK (state IN ('running', 'completed', 'failed', 'unknown')),
    effect TEXT NOT NULL CHECK (effect IN ('completed', 'not_started', 'unknown')),
    inspection JSONB,
    error_code TEXT NOT NULL DEFAULT '',
    error_detail TEXT NOT NULL DEFAULT '',
    created_at TIMESTAMPTZ NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL
);

CREATE INDEX IF NOT EXISTS operations_agent_generation_idx
    ON runtime_controller.operations (agent_id, target_generation, updated_at DESC);

CREATE UNIQUE INDEX IF NOT EXISTS operations_agent_nonterminal_unique
    ON runtime_controller.operations (agent_id)
    WHERE state IN ('running', 'unknown');

CREATE TABLE IF NOT EXISTS runtime_controller.runtime_environments (
    agent_id TEXT PRIMARY KEY,
    runtime_revision TEXT NOT NULL CHECK (runtime_revision ~ '^rtv_[0-9a-f]{32}$'),
    lifecycle_state TEXT NOT NULL CHECK (lifecycle_state IN (
        'initializing', 'ready', 'updating', 'disabling', 'disabled',
        'enabling', 'deleting', 'deleted', 'unknown'
    )),
    generation BIGINT NOT NULL CHECK (generation > 0),
    spec_digest TEXT NOT NULL CHECK (spec_digest ~ '^sha256:[0-9a-fA-F]{64}$'),
    operation_id TEXT REFERENCES runtime_controller.operations(request_id),
    updated_at TIMESTAMPTZ NOT NULL
);

CREATE TABLE IF NOT EXISTS runtime_controller.generation_claims (
    agent_id TEXT NOT NULL,
    generation BIGINT NOT NULL CHECK (generation > 0),
    runtime_revision TEXT NOT NULL CHECK (runtime_revision ~ '^rtv_[0-9a-f]{32}$'),
    spec_digest TEXT NOT NULL CHECK (spec_digest ~ '^sha256:[0-9a-fA-F]{64}$'),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (agent_id, generation)
);

CREATE TABLE IF NOT EXISTS runtime_controller.observations (
    sequence BIGSERIAL PRIMARY KEY,
    agent_id TEXT NOT NULL,
    runtime_revision TEXT NOT NULL DEFAULT '',
    generation BIGINT NOT NULL CHECK (generation >= 0),
    spec_digest TEXT NOT NULL DEFAULT '',
    platform_resource_id TEXT NOT NULL DEFAULT '',
    runtime_execution_id TEXT NOT NULL DEFAULT '',
    kind TEXT NOT NULL CHECK (kind IN ('initialized', 'updated', 'disabled', 'enabled', 'healthy', 'unhealthy', 'restarted', 'exited', 'deleted', 'status_unverified', 'observation_gap', 'reconciled')),
    source TEXT NOT NULL,
    diagnostic_summary TEXT NOT NULL DEFAULT '',
    observed_at TIMESTAMPTZ NOT NULL,
    recorded_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CHECK (
        (kind IN ('observation_gap', 'reconciled') AND agent_id = '' AND runtime_revision = '' AND generation = 0 AND spec_digest = '')
        OR
        (kind NOT IN ('observation_gap', 'reconciled') AND agent_id <> '' AND runtime_revision ~ '^rtv_[0-9a-f]{32}$' AND generation > 0 AND spec_digest ~ '^sha256:[0-9a-fA-F]{64}$')
    )
);

CREATE INDEX IF NOT EXISTS observations_agent_generation_idx
    ON runtime_controller.observations (agent_id, generation, sequence DESC);

CREATE INDEX IF NOT EXISTS observations_recorded_at_idx
    ON runtime_controller.observations (recorded_at);
`
)

type migration struct {
	version  int64
	name     string
	checksum string
	sql      string
}

var schemaMigrations = []migration{
	{
		version: 1, name: "initial_runtime_controller_schema",
		checksum: "0a7a7162403e43319291d6e23edd02b87cbb462283e96a3f7cb56172e868ed97",
		sql:      initialSchemaSQL,
	},
}

func Migrate(ctx context.Context, database *sql.DB) error {
	if database == nil {
		return fmt.Errorf("database is required")
	}
	if err := validateMigrationPlan(); err != nil {
		return err
	}
	tx, err := database.BeginTx(ctx, nil)
	if err != nil {
		return fmt.Errorf("begin Runtime Controller schema migration: %w", err)
	}
	defer func() { _ = tx.Rollback() }()
	if _, err := tx.ExecContext(ctx, `SELECT pg_advisory_xact_lock($1)`, migrationLockID); err != nil {
		return fmt.Errorf("lock Runtime Controller schema migration: %w", err)
	}
	if _, err := tx.ExecContext(ctx, bootstrapSQL); err != nil {
		return fmt.Errorf("bootstrap Runtime Controller schema migration journal: %w", err)
	}
	applied, err := appliedMigrations(ctx, tx)
	if err != nil {
		return err
	}
	if err := applyMigrations(ctx, tx, applied); err != nil {
		return err
	}
	if err := tx.Commit(); err != nil {
		return fmt.Errorf("commit Runtime Controller schema migration: %w", err)
	}
	return nil
}

type appliedMigration struct {
	name     string
	checksum string
}

func appliedMigrations(ctx context.Context, tx *sql.Tx) (map[int64]appliedMigration, error) {
	rows, err := tx.QueryContext(ctx, `
SELECT version, name, checksum
FROM runtime_controller.schema_migrations
ORDER BY version`)
	if err != nil {
		return nil, fmt.Errorf("read Runtime Controller schema migration journal: %w", err)
	}
	defer rows.Close()
	applied := make(map[int64]appliedMigration)
	for rows.Next() {
		var version int64
		var value appliedMigration
		if err := rows.Scan(&version, &value.name, &value.checksum); err != nil {
			return nil, fmt.Errorf("scan Runtime Controller schema migration journal: %w", err)
		}
		applied[version] = value
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("iterate Runtime Controller schema migration journal: %w", err)
	}
	return applied, nil
}

func applyMigrations(ctx context.Context, tx *sql.Tx, applied map[int64]appliedMigration) error {
	known := make(map[int64]migration, len(schemaMigrations))
	for _, candidate := range schemaMigrations {
		known[candidate.version] = candidate
	}
	for version, value := range applied {
		candidate, ok := known[version]
		if !ok {
			return fmt.Errorf("database schema migration %d (%s) is newer than this Runtime Controller", version, value.name)
		}
		if candidate.name != value.name {
			return fmt.Errorf("database schema migration %d has name %q, expected %q", version, value.name, candidate.name)
		}
		if candidate.checksum != value.checksum {
			return fmt.Errorf("database schema migration %d (%s) checksum does not match this Runtime Controller",
				version, candidate.name)
		}
	}
	for _, candidate := range schemaMigrations {
		if _, ok := applied[candidate.version]; ok {
			continue
		}
		if _, err := tx.ExecContext(ctx, candidate.sql); err != nil {
			return fmt.Errorf("apply Runtime Controller schema migration %d (%s): %w",
				candidate.version, candidate.name, err)
		}
		if _, err := tx.ExecContext(ctx, `
INSERT INTO runtime_controller.schema_migrations (version, name, checksum)
VALUES ($1, $2, $3)`, candidate.version, candidate.name, candidate.checksum); err != nil {
			return fmt.Errorf("record Runtime Controller schema migration %d (%s): %w",
				candidate.version, candidate.name, err)
		}
	}
	return nil
}

func validateMigrationPlan() error {
	var previous int64
	names := make(map[string]struct{}, len(schemaMigrations))
	for _, candidate := range schemaMigrations {
		if candidate.version <= previous {
			return fmt.Errorf("schema migration version %d is not strictly ordered after %d",
				candidate.version, previous)
		}
		if candidate.name == "" || candidate.sql == "" {
			return fmt.Errorf("schema migration %d is incomplete", candidate.version)
		}
		if _, exists := names[candidate.name]; exists {
			return fmt.Errorf("schema migration name %q is duplicated", candidate.name)
		}
		if actual := migrationChecksum(candidate.sql); candidate.checksum != actual {
			return fmt.Errorf("schema migration %d (%s) checksum is %s, expected %s",
				candidate.version, candidate.name, candidate.checksum, actual)
		}
		names[candidate.name] = struct{}{}
		previous = candidate.version
	}
	return nil
}

func migrationChecksum(statement string) string {
	sum := sha256.Sum256([]byte(statement))
	return hex.EncodeToString(sum[:])
}
