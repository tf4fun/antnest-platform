package postgres

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/stdlib"
)

// OpenDatabase configures both query and dedicated lock pools. Raw pgx
// connections reserved for LISTEN inherit the same driver tracer.
func OpenDatabase(
	ctx context.Context, databaseURL string, maxOpenConnections, maxIdleConnections int,
) (*sql.DB, error) {
	configuration, err := pgx.ParseConfig(databaseURL)
	if err != nil {
		return nil, fmt.Errorf("open Runtime Controller database: %w", err)
	}
	configuration.Tracer = newDatabaseTracer()
	database := sql.OpenDB(transactionConnector{stdlib.GetConnector(*configuration)})
	database.SetMaxOpenConns(maxOpenConnections)
	database.SetMaxIdleConns(maxIdleConnections)
	database.SetConnMaxLifetime(30 * time.Minute)
	if err := database.PingContext(ctx); err != nil {
		return nil, fmt.Errorf("connect Runtime Controller database: %w", errors.Join(err, database.Close()))
	}
	return database, nil
}
