package postgres

import (
	"context"
	"database/sql"
	"embed"
	"fmt"
)

//go:embed migrations/*.sql
var migrations embed.FS

func Migrate(ctx context.Context, database *sql.DB) error {
	if database == nil {
		return fmt.Errorf("database is required")
	}
	schema, err := migrations.ReadFile("migrations/0001_runtime.sql")
	if err != nil {
		return fmt.Errorf("read runtime schema: %w", err)
	}
	if _, err := database.ExecContext(ctx, string(schema)); err != nil {
		return fmt.Errorf("apply runtime schema: %w", err)
	}
	return nil
}
