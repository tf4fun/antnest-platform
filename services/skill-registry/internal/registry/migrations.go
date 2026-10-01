package registry

import (
	"context"
	"crypto/sha256"
	"embed"
	"encoding/hex"
	"fmt"
	"io/fs"
	"sort"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

//go:embed migrations/*.sql
var migrationFS embed.FS

const migrationLockID int64 = 0x534b494c4c524547

func ApplyMigrations(ctx context.Context, pool *pgxpool.Pool) error {
	names, err := fs.Glob(migrationFS, "migrations/*.sql")
	if err != nil {
		return err
	}
	sort.Strings(names)
	bodies := map[string][]byte{}
	expected := map[string]string{}
	for _, path := range names {
		body, err := migrationFS.ReadFile(path)
		if err != nil {
			return err
		}
		name := path[len("migrations/"):]
		sum := sha256.Sum256(body)
		bodies[name] = body
		expected[name] = hex.EncodeToString(sum[:])
	}
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
	if err := validateMigrationJournal(applied, expected); err != nil {
		return err
	}
	for _, path := range names {
		name := path[len("migrations/"):]
		if _, exists := applied[name]; exists {
			continue
		}
		if _, err := tx.Exec(ctx, string(bodies[name])); err != nil {
			return fmt.Errorf("apply Registry migration: %w", err)
		}
		if _, err := tx.Exec(ctx, `INSERT INTO schema_migrations (name, checksum) VALUES ($1, $2)`, name, expected[name]); err != nil {
			return fmt.Errorf("journal Registry migration: %w", err)
		}
	}
	if err := tx.Commit(ctx); err != nil {
		return fmt.Errorf("commit Registry migration: %w", err)
	}
	return nil
}

func validateMigrationJournal(applied, expected map[string]string) error {
	for name, checksum := range applied {
		want, known := expected[name]
		if !known {
			return fmt.Errorf("registry database has unknown migration %s", name)
		}
		if checksum != want {
			return fmt.Errorf("registry migration checksum changed")
		}
	}
	names := make([]string, 0, len(expected))
	for name := range expected {
		names = append(names, name)
	}
	sort.Strings(names)
	missing := false
	for _, name := range names {
		_, exists := applied[name]
		if exists && missing {
			return fmt.Errorf("registry migration journal has a gap")
		}
		missing = missing || !exists
	}
	return nil
}
