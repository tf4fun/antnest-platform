package repository

import (
	"context"
	"crypto/sha256"
	"embed"
	"encoding/hex"
	"fmt"
	"io/fs"
	"sort"
	"strings"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

const identityMigrationLockID int64 = 0x41544e4553544944

//go:embed migrations/*.sql
var migrationFiles embed.FS

type migration struct {
	name     string
	checksum string
	body     []byte
}

func ApplyMigrations(ctx context.Context, pool *pgxpool.Pool) error {
	plan, err := loadMigrationPlan()
	if err != nil {
		return err
	}
	tx, err := pool.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return fmt.Errorf("begin identity schema migration: %w", err)
	}
	defer func() { _ = tx.Rollback(context.WithoutCancel(ctx)) }()
	if _, err := tx.Exec(ctx, `SELECT pg_advisory_xact_lock($1)`, identityMigrationLockID); err != nil {
		return fmt.Errorf("lock identity schema migration: %w", err)
	}
	if _, err := tx.Exec(ctx, `
		CREATE TABLE IF NOT EXISTS schema_migrations (
			name TEXT PRIMARY KEY,
			checksum TEXT NOT NULL,
			applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
		)`); err != nil {
		return fmt.Errorf("create identity migration journal: %w", err)
	}
	applied, err := readAppliedMigrations(ctx, tx)
	if err != nil {
		return err
	}
	if err := validateAppliedMigrations(plan, applied); err != nil {
		return err
	}
	for _, candidate := range plan {
		if _, exists := applied[candidate.name]; exists {
			continue
		}
		if _, err := tx.Exec(ctx, string(candidate.body)); err != nil {
			return fmt.Errorf("apply identity migration %s: %w", candidate.name, err)
		}
		if _, err := tx.Exec(ctx,
			`INSERT INTO schema_migrations (name, checksum) VALUES ($1, $2)`,
			candidate.name, candidate.checksum,
		); err != nil {
			return fmt.Errorf("journal identity migration %s: %w", candidate.name, err)
		}
	}
	if err := tx.Commit(ctx); err != nil {
		return fmt.Errorf("commit identity schema migration: %w", err)
	}
	return nil
}

func loadMigrationPlan() ([]migration, error) {
	entries, err := fs.ReadDir(migrationFiles, "migrations")
	if err != nil {
		return nil, fmt.Errorf("read identity migrations: %w", err)
	}
	sort.Slice(entries, func(i, j int) bool { return entries[i].Name() < entries[j].Name() })
	plan := make([]migration, 0, len(entries))
	for _, entry := range entries {
		if entry.IsDir() || !strings.HasSuffix(entry.Name(), ".sql") {
			continue
		}
		body, err := migrationFiles.ReadFile("migrations/" + entry.Name())
		if err != nil {
			return nil, fmt.Errorf("read identity migration %s: %w", entry.Name(), err)
		}
		digest := sha256.Sum256(body)
		plan = append(plan, migration{
			name: entry.Name(), checksum: hex.EncodeToString(digest[:]), body: body,
		})
	}
	if len(plan) == 0 {
		return nil, fmt.Errorf("identity migration plan is empty")
	}
	return plan, nil
}

func readAppliedMigrations(ctx context.Context, tx pgx.Tx) (map[string]string, error) {
	rows, err := tx.Query(ctx, `SELECT name, checksum FROM schema_migrations ORDER BY name`)
	if err != nil {
		return nil, fmt.Errorf("read identity migration journal: %w", err)
	}
	defer rows.Close()
	applied := make(map[string]string)
	for rows.Next() {
		var name, checksum string
		if err := rows.Scan(&name, &checksum); err != nil {
			return nil, fmt.Errorf("scan identity migration journal: %w", err)
		}
		applied[name] = checksum
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("iterate identity migration journal: %w", err)
	}
	return applied, nil
}

func validateAppliedMigrations(plan []migration, applied map[string]string) error {
	known := make(map[string]string, len(plan))
	for _, candidate := range plan {
		known[candidate.name] = candidate.checksum
	}
	for name, checksum := range applied {
		expected, exists := known[name]
		if !exists {
			return fmt.Errorf("database migration %s is newer than this Identity Service", name)
		}
		if checksum != expected {
			return fmt.Errorf("identity migration %s checksum changed", name)
		}
	}
	return nil
}
