package registry

import (
	"context"
	"crypto/sha256"
	"embed"
	"encoding/hex"
	"fmt"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

//go:embed migrations/0001_registry.sql
var migrationFS embed.FS

const migrationLockID int64 = 0x534b494c4c524547

func ApplyMigrations(ctx context.Context, pool *pgxpool.Pool) error {
	body, err := migrationFS.ReadFile("migrations/0001_registry.sql")
	if err != nil {
		return err
	}
	sum := sha256.Sum256(body)
	checksum := hex.EncodeToString(sum[:])
	tx, err := pool.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return fmt.Errorf("begin Registry migration: %w", err)
	}
	defer func() { _ = tx.Rollback(context.WithoutCancel(ctx)) }()
	if _, err := tx.Exec(ctx, `SELECT pg_advisory_xact_lock($1)`, migrationLockID); err != nil {
		return fmt.Errorf("lock Registry migration: %w", err)
	}
	if _, err := tx.Exec(ctx, `CREATE TABLE IF NOT EXISTS schema_migrations (
        name TEXT PRIMARY KEY, checksum TEXT NOT NULL, applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )`); err != nil {
		return fmt.Errorf("create Registry migration journal: %w", err)
	}
	rows, err := tx.Query(ctx, `SELECT name, checksum FROM schema_migrations`)
	if err != nil {
		return fmt.Errorf("read Registry migration journal: %w", err)
	}
	applied := map[string]string{}
	for rows.Next() {
		var name, value string
		if err := rows.Scan(&name, &value); err != nil {
			rows.Close()
			return fmt.Errorf("scan Registry migration journal: %w", err)
		}
		applied[name] = value
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return fmt.Errorf("iterate Registry migration journal: %w", err)
	}
	if err := validateMigrationJournal(applied, checksum); err != nil {
		return err
	}
	if _, exists := applied["0001_registry.sql"]; !exists {
		if _, err := tx.Exec(ctx, string(body)); err != nil {
			return fmt.Errorf("apply Registry migration: %w", err)
		}
		if _, err := tx.Exec(ctx, `INSERT INTO schema_migrations (name, checksum) VALUES ($1, $2)`, "0001_registry.sql", checksum); err != nil {
			return fmt.Errorf("journal Registry migration: %w", err)
		}
	}
	if err := tx.Commit(ctx); err != nil {
		return fmt.Errorf("commit Registry migration: %w", err)
	}
	return nil
}

func validateMigrationJournal(applied map[string]string, expected string) error {
	for name, checksum := range applied {
		if name != "0001_registry.sql" {
			return fmt.Errorf("registry database has unknown migration %s", name)
		}
		if checksum != expected {
			return fmt.Errorf("registry migration checksum changed")
		}
	}
	return nil
}
