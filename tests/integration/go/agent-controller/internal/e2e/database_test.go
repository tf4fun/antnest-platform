package e2e

import (
	"context"
	"strings"
	"testing"

	"github.com/jackc/pgx/v5"
)

// These component suites share one disposable database and run serially.
// Each owns its fixture lifecycle instead of relying on package execution order.
func resetE2ESchema(t *testing.T, ctx context.Context, dsn string) {
	t.Helper()
	config, err := pgx.ParseConfig(dsn)
	if err != nil || !strings.HasSuffix(config.Database, "_test") {
		t.Fatal("Agent Controller component tests require a database name ending in _test")
	}
	connection, err := pgx.ConnectConfig(ctx, config)
	if err != nil {
		t.Fatalf("connect component database: %v", err)
	}
	defer func() {
		if err := connection.Close(context.Background()); err != nil {
			t.Errorf("close component database: %v", err)
		}
	}()
	if _, err := connection.Exec(ctx, `DROP SCHEMA IF EXISTS agent_controller CASCADE`); err != nil {
		t.Fatalf("reset component schema: %v", err)
	}
}
