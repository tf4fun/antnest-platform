package repository

import (
	"context"
	"testing"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"
	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/codes"
	sdktrace "go.opentelemetry.io/otel/sdk/trace"
	"go.opentelemetry.io/otel/sdk/trace/tracetest"
	"go.opentelemetry.io/otel/trace"
)

func TestDatabaseTracerExecutionOnlyHooks(t *testing.T) {
	tracer := newDatabaseTracer()
	if _, ok := tracer.(pgx.PrepareTracer); ok {
		t.Fatal("prepare must not create a second SQL observation")
	}
	if _, ok := tracer.(pgxpool.AcquireTracer); ok {
		t.Fatal("pool acquisition must not create a span")
	}
	if _, ok := tracer.(pgx.BatchTracer); !ok {
		t.Fatal("batch execution observation missing")
	}
	if _, ok := tracer.(pgx.CopyFromTracer); !ok {
		t.Fatal("COPY observation missing")
	}
	if _, ok := tracer.(pgx.ConnectTracer); !ok {
		t.Fatal("connection failure observation missing")
	}
}

func TestDatabaseTracerDefaultOperations(t *testing.T) {
	for _, test := range []struct{ name, sql, operation string }{
		{"select", `SELECT * FROM users WHERE id = $1`, "SELECT"},
		{"insert", `INSERT INTO api_tokens (id) VALUES ($1)`, "INSERT"},
		{"update", `UPDATE users SET active = $1`, "UPDATE"},
		{"delete", `DELETE FROM api_tokens WHERE id = $1`, "DELETE"},
		{"join", `SELECT u.id FROM users u JOIN organizations o ON o.id = u.id`, "SELECT"},
		{"constant", `SELECT $1::text`, "SELECT"},
		{"begin", `begin`, "BEGIN"},
		{"commit", `commit`, "COMMIT"},
		{"rollback", `rollback`, "ROLLBACK"},
	} {
		t.Run(test.name, func(t *testing.T) {
			ctx, recorder := databaseTracerRecorder(t)
			tracer := newDatabaseTracer()
			ctx = tracer.TraceQueryStart(ctx, nil, pgx.TraceQueryStartData{SQL: test.sql, Args: []any{"SECRET-BIND"}})
			tracer.TraceQueryEnd(ctx, nil, pgx.TraceQueryEndData{})
			spans := recorder.Ended()
			if len(spans) != 1 {
				t.Fatalf("execution spans=%d, want exactly one", len(spans))
			}
			span := spans[0]
			if span.Name() != test.operation || databaseTracerAttribute(span, "db.operation.name") != test.operation {
				t.Fatalf("title=%q operation=%q, want %q", span.Name(), databaseTracerAttribute(span, "db.operation.name"), test.operation)
			}
			if databaseTracerAttribute(span, "db.query.summary") != "" || databaseTracerAttribute(span, "db.query.text") != test.sql {
				t.Fatal("unexpected derived summary or original SQL missing")
			}
			if databaseTracerAttribute(span, "pgx.query.parameters") != "" {
				t.Fatal("bind arguments must not be recorded")
			}
		})
	}
}

func TestDatabaseTracerBatchAndErrors(t *testing.T) {
	ctx, recorder := databaseTracerRecorder(t)
	parent := trace.SpanFromContext(ctx).SpanContext()
	tracer := newDatabaseTracer()
	batch := tracer.(pgx.BatchTracer)
	batchCtx := batch.TraceBatchStart(ctx, nil, pgx.TraceBatchStartData{})
	batch.TraceBatchQuery(batchCtx, nil, pgx.TraceBatchQueryData{SQL: "SELECT * FROM users"})
	batch.TraceBatchEnd(batchCtx, nil, pgx.TraceBatchEndData{})
	ctx = tracer.TraceQueryStart(ctx, nil, pgx.TraceQueryStartData{SQL: "SELECT * FROM missing_table"})
	tracer.TraceQueryEnd(ctx, nil, pgx.TraceQueryEndData{Err: &pgconn.PgError{Code: "42P01", Message: "relation does not exist"}})
	spans := recorder.Ended()
	if len(spans) != 3 || spans[0].Name() != "SELECT" || spans[1].Name() != "batch start" || spans[2].Name() != "SELECT" {
		t.Fatalf("unexpected batch/execution spans: %v", spans)
	}
	if spans[0].Parent().SpanID() != spans[1].SpanContext().SpanID() || spans[1].Parent().SpanID() != parent.SpanID() || spans[2].Parent().SpanID() != parent.SpanID() {
		t.Fatal("driver parent relationships changed")
	}
	if spans[2].Status().Code != codes.Error || databaseTracerAttribute(spans[2], "pgx.sql_state") != "42P01" || len(spans[2].Events()) == 0 {
		t.Fatal("SQL error observation lost")
	}
}

func databaseTracerRecorder(t *testing.T) (context.Context, *tracetest.SpanRecorder) {
	t.Helper()
	recorder := tracetest.NewSpanRecorder()
	provider := sdktrace.NewTracerProvider(sdktrace.WithSpanProcessor(recorder))
	previous := otel.GetTracerProvider()
	otel.SetTracerProvider(provider)
	ctx, parent := provider.Tracer("test").Start(t.Context(), "request")
	t.Cleanup(func() {
		parent.End()
		otel.SetTracerProvider(previous)
		if err := provider.Shutdown(context.Background()); err != nil {
			t.Errorf("shutdown provider: %v", err)
		}
	})
	return ctx, recorder
}

func databaseTracerAttribute(span sdktrace.ReadOnlySpan, key string) string {
	for _, value := range span.Attributes() {
		if string(value.Key) == key {
			return value.Value.AsString()
		}
	}
	return ""
}
