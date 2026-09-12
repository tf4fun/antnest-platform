package postgres

import (
	"github.com/exaring/otelpgx"
	"github.com/jackc/pgx/v5"
)

// Expose execution hooks only, not prepare or pool-acquire observations.
type databaseTracer struct {
	pgx.QueryTracer
	pgx.BatchTracer
	pgx.CopyFromTracer
	pgx.ConnectTracer
}

func newDatabaseTracer() pgx.QueryTracer {
	tracer := otelpgx.NewTracer()
	return databaseTracer{tracer, tracer, tracer, tracer}
}
