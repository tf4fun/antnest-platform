package repository

import (
	"context"
	"errors"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/codes"
	sdktrace "go.opentelemetry.io/otel/sdk/trace"
	"go.opentelemetry.io/otel/sdk/trace/tracetest"
	"go.opentelemetry.io/otel/trace"
	"os"
	"testing"
)

func TestTransactionSpanOwnershipAndCompletion(t *testing.T) {
	for _, scenario := range []string{"commit", "rollback", "commit_failure", "cancel", "begin_failure"} {
		t.Run(scenario, func(t *testing.T) {
			recorder := tracetest.NewSpanRecorder()
			provider := sdktrace.NewTracerProvider(sdktrace.WithSpanProcessor(recorder))
			original := otel.GetTracerProvider()
			otel.SetTracerProvider(provider)
			t.Cleanup(func() {
				otel.SetTracerProvider(original)
				if err := provider.Shutdown(context.Background()); err != nil {
					t.Error(err)
				}
			})
			url := os.Getenv("ANTNEST_IDENTITY_TEST_DATABASE_URL")
			if url == "" {
				t.Skip("ANTNEST_IDENTITY_TEST_DATABASE_URL is not set")
			}
			config, err := ParsePoolConfig(url)
			if err != nil {
				t.Fatal(err)
			}
			raw, err := pgxpool.NewWithConfig(t.Context(), config)
			if err != nil {
				t.Fatal(err)
			}
			t.Cleanup(raw.Close)
			pool := &databasePool{raw}
			ctx, parent := provider.Tracer("transaction-test").Start(t.Context(), "request", trace.WithSpanKind(trace.SpanKindServer))
			defer parent.End()
			ctx, cancel := context.WithCancel(ctx)
			defer cancel()
			if scenario == "begin_failure" {
				cancel()
			}
			tx, err := pool.Begin(ctx)
			if scenario == "begin_failure" {
				if tx != nil || !errors.Is(err, context.Canceled) {
					t.Fatalf("begin cancellation changed: %v", err)
				}
				assertTransactionEnvelope(t, recorder, parent, true)
				return
			}
			if err != nil {
				t.Fatal(err)
			}
			defer func() {
				if err := tx.Rollback(context.WithoutCancel(ctx)); err != nil && !errors.Is(err, pgx.ErrTxClosed) {
					t.Error(err)
				}
			}()
			if scenario == "cancel" {
				cancel()
			}
			_, err = tx.Exec(ctx, "SELECT 1")
			if scenario == "cancel" {
				if !errors.Is(err, context.Canceled) {
					t.Fatalf("query lost caller cancellation: %v", err)
				}
			} else if err != nil {
				t.Fatal(err)
			}
			for _, span := range recorder.Ended() {
				if span.Name() == "postgresql transaction" {
					t.Fatal("transaction ended before completion")
				}
			}
			if scenario == "commit_failure" {
				if _, err := tx.Exec(ctx, "CREATE TEMP TABLE transaction_span_probe (value int UNIQUE DEFERRABLE INITIALLY DEFERRED) ON COMMIT DROP"); err != nil {
					t.Fatal(err)
				}
				if _, err := tx.Exec(ctx, "INSERT INTO transaction_span_probe VALUES (1), (1)"); err != nil {
					t.Fatal(err)
				}
			}
			if scenario == "commit" || scenario == "commit_failure" {
				err = tx.Commit(ctx)
			} else {
				err = tx.Rollback(context.WithoutCancel(ctx))
			}
			if scenario == "commit_failure" && err == nil {
				t.Fatal("commit failure was swallowed")
			}
			if (scenario == "commit" || scenario == "rollback") && err != nil {
				t.Fatal(err)
			}
			// A caller's deferred cleanup must not export a second span or overwrite the outcome.
			repeated := tx.Rollback(context.WithoutCancel(ctx))
			if !errors.Is(repeated, pgx.ErrTxClosed) {
				t.Fatalf("repeated rollback changed: %v", repeated)
			}
			assertTransactionEnvelope(t, recorder, parent, err != nil)
		})
	}
}

func assertTransactionEnvelope(t *testing.T, recorder *tracetest.SpanRecorder, parent trace.Span, failed bool) {
	t.Helper()
	var envelope sdktrace.ReadOnlySpan
	for _, span := range recorder.Ended() {
		if span.Name() != "postgresql transaction" {
			continue
		}
		if envelope != nil {
			t.Fatal("duplicate transaction span")
		}
		envelope = span
	}
	if envelope == nil {
		t.Fatal("transaction span was not finished")
	}
	if envelope.SpanKind() != trace.SpanKindInternal || !envelope.Parent().Equal(parent.SpanContext()) {
		t.Fatal("transaction is not an INTERNAL child of its request")
	}
	if (envelope.Status().Code == codes.Error) != failed {
		t.Fatalf("transaction status = %v, failed = %t", envelope.Status(), failed)
	}
	statements := 0
	for _, span := range recorder.Ended() {
		if span.InstrumentationScope().Name != "github.com/exaring/otelpgx" {
			continue
		}
		statement := false
		for _, attr := range span.Attributes() {
			if attr.Key == "db.query.text" {
				statement = true
			}
		}
		if !statement {
			continue
		}
		statements++
		if !span.Parent().Equal(envelope.SpanContext()) {
			t.Fatalf("SQL %s is outside transaction", span.Name())
		}
		if span.StartTime().Before(envelope.StartTime()) || span.EndTime().After(envelope.EndTime()) {
			t.Fatalf("SQL %s lies outside transaction duration", span.Name())
		}
	}
	if !failed && statements < 3 {
		t.Fatalf("transaction has %d SQL spans; require BEGIN, statement, completion", statements)
	}
}
