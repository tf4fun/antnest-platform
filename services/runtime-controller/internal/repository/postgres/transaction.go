package postgres

import (
	"context"
	"database/sql/driver"
	"errors"
	"fmt"
	"sync"

	"github.com/jackc/pgx/v5/stdlib"
	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/codes"
	"go.opentelemetry.io/otel/trace"
)

type transactionConnector struct{ driver.Connector }

func (c transactionConnector) Connect(ctx context.Context) (driver.Conn, error) {
	connection, err := c.Connector.Connect(ctx)
	if err != nil {
		return nil, err
	}
	native, ok := connection.(*stdlib.Conn)
	if !ok {
		return nil, errors.Join(fmt.Errorf("transaction connector requires pgx stdlib"), connection.Close())
	}
	return &transactionConnection{Conn: native}, nil
}

// database/sql serializes use of each driver connection, including automatic rollback.
type transactionConnection struct {
	*stdlib.Conn
	transaction trace.Span
}

func (c *transactionConnection) context(ctx context.Context) context.Context {
	if c.transaction == nil || !c.transaction.SpanContext().IsValid() {
		return ctx
	}
	return trace.ContextWithSpan(ctx, c.transaction)
}

func (c *transactionConnection) Begin() (driver.Tx, error) {
	return c.BeginTx(context.Background(), driver.TxOptions{})
}

func (c *transactionConnection) BeginTx(ctx context.Context, options driver.TxOptions) (driver.Tx, error) {
	span := trace.SpanFromContext(context.Background())
	if trace.SpanFromContext(ctx).IsRecording() {
		ctx, span = otel.Tracer("runtime_controller.database").Start(ctx, "postgresql transaction",
			trace.WithAttributes(attribute.String("db.system.name", "postgresql")))
	}
	tx := &transactionDriver{span: span, release: func() { c.transaction = nil }}
	inner, err := c.Conn.BeginTx(ctx, options)
	if err != nil {
		tx.finish("failed", err)
		return nil, err
	}
	tx.inner = inner
	c.transaction = span
	return tx, nil
}

func (c *transactionConnection) ExecContext(ctx context.Context, query string, args []driver.NamedValue) (driver.Result, error) {
	return c.Conn.ExecContext(c.context(ctx), query, args)
}

func (c *transactionConnection) QueryContext(ctx context.Context, query string, args []driver.NamedValue) (driver.Rows, error) {
	return c.Conn.QueryContext(c.context(ctx), query, args)
}

func (c *transactionConnection) Prepare(query string) (driver.Stmt, error) {
	return c.PrepareContext(context.Background(), query)
}

func (c *transactionConnection) PrepareContext(ctx context.Context, query string) (driver.Stmt, error) {
	prepared, err := c.Conn.PrepareContext(c.context(ctx), query)
	if err != nil {
		return nil, err
	}
	native, ok := prepared.(*stdlib.Stmt)
	if !ok {
		return nil, errors.Join(fmt.Errorf("transaction statement requires pgx stdlib"), prepared.Close())
	}
	return &transactionStatement{Stmt: native, connection: c}, nil
}

type transactionStatement struct {
	*stdlib.Stmt
	connection *transactionConnection
}

func (s *transactionStatement) ExecContext(ctx context.Context, args []driver.NamedValue) (driver.Result, error) {
	return s.Stmt.ExecContext(s.connection.context(ctx), args)
}

func (s *transactionStatement) QueryContext(ctx context.Context, args []driver.NamedValue) (driver.Rows, error) {
	return s.Stmt.QueryContext(s.connection.context(ctx), args)
}

type transactionDriver struct {
	inner   driver.Tx
	span    trace.Span
	release func()
	ended   sync.Once
}

func (t *transactionDriver) Commit() error {
	err := t.inner.Commit()
	t.finish("committed", err)
	return err
}

func (t *transactionDriver) Rollback() error {
	err := t.inner.Rollback()
	t.finish("rolled_back", err)
	return err
}

func (t *transactionDriver) finish(outcome string, err error) {
	t.ended.Do(func() {
		if err != nil {
			t.span.SetStatus(codes.Error, "transaction did not complete successfully")
			t.span.SetAttributes(attribute.String("error.type", "transaction_error"))
			outcome = "failed"
		}
		t.span.SetAttributes(attribute.String("antnest.transaction.outcome", outcome))
		t.span.End()
		t.release()
	})
}
