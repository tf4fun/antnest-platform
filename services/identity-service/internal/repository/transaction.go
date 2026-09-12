package repository

import (
	"context"
	"sync"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"
	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/codes"
	"go.opentelemetry.io/otel/trace"
)

type databasePool struct{ *pgxpool.Pool }

// Transactions own their trace context; callers keep using their original deadlines.
type databaseTransaction struct {
	inner pgx.Tx
	span  trace.Span
	ended sync.Once
}

func (p *databasePool) Begin(ctx context.Context) (*databaseTransaction, error) {
	return p.BeginTx(ctx, pgx.TxOptions{})
}

func (p *databasePool) BeginTx(ctx context.Context, options pgx.TxOptions) (*databaseTransaction, error) {
	span := trace.SpanFromContext(context.Background())
	if trace.SpanFromContext(ctx).IsRecording() {
		ctx, span = otel.Tracer("identity_service.database").Start(ctx, "postgresql transaction",
			trace.WithAttributes(attribute.String("db.system.name", "postgresql")))
	}
	tx := &databaseTransaction{span: span}
	inner, err := p.Pool.BeginTx(ctx, options)
	if err != nil {
		tx.finish("begin_failed", err)
		return nil, err
	}
	tx.inner = inner
	return tx, nil
}

func (t *databaseTransaction) context(ctx context.Context) context.Context {
	if !t.span.SpanContext().IsValid() {
		return ctx
	}
	return trace.ContextWithSpan(ctx, t.span)
}

func (t *databaseTransaction) Exec(ctx context.Context, sql string, args ...any) (pgconn.CommandTag, error) {
	return t.inner.Exec(t.context(ctx), sql, args...)
}

func (t *databaseTransaction) Query(ctx context.Context, sql string, args ...any) (pgx.Rows, error) {
	return t.inner.Query(t.context(ctx), sql, args...)
}

func (t *databaseTransaction) QueryRow(ctx context.Context, sql string, args ...any) pgx.Row {
	return t.inner.QueryRow(t.context(ctx), sql, args...)
}

func (t *databaseTransaction) Commit(ctx context.Context) error {
	err := t.inner.Commit(t.context(ctx))
	t.finish("committed", err)
	return err
}

func (t *databaseTransaction) Rollback(ctx context.Context) error {
	err := t.inner.Rollback(t.context(ctx))
	t.finish("rolled_back", err)
	return err
}

func (t *databaseTransaction) finish(outcome string, err error) {
	t.ended.Do(func() {
		if err != nil {
			t.span.SetStatus(codes.Error, "transaction did not complete successfully")
			t.span.SetAttributes(attribute.String("error.type", "transaction_error"))
			outcome = "failed"
		}
		t.span.SetAttributes(attribute.String("antnest.transaction.outcome", outcome))
		t.span.End()
	})
}
