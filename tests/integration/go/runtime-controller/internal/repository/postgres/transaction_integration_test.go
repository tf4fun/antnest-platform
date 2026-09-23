package postgres

import (
	"context"
	"database/sql"
	"errors"
	"testing"
	"time"

	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/codes"
	sdktrace "go.opentelemetry.io/otel/sdk/trace"
	"go.opentelemetry.io/otel/sdk/trace/tracetest"
	"go.opentelemetry.io/otel/trace"
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
			repository, _, _ := integrationRepository(t)
			pool := repository.database
			ctx, parent := provider.Tracer("transaction-test").Start(t.Context(), "request", trace.WithSpanKind(trace.SpanKindServer))
			defer parent.End()
			ctx, cancel := context.WithCancel(ctx)
			defer cancel()
			if scenario == "begin_failure" {
				cancel()
			}
			tx, err := pool.BeginTx(ctx, nil)
			if scenario == "begin_failure" {
				if tx != nil || !errors.Is(err, context.Canceled) {
					t.Fatalf("begin cancellation changed: %v", err)
				}
				if len(recorder.Ended()) != 0 {
					t.Fatal("cancelled request should not enter the driver transaction")
				}
				return
			}
			if err != nil {
				t.Fatal(err)
			}
			defer func() {
				if err := tx.Rollback(); err != nil && !errors.Is(err, sql.ErrTxDone) {
					t.Error(err)
				}
			}()
			if scenario == "cancel" {
				cancel()
			}
			_, err = tx.ExecContext(ctx, "SELECT 1")
			if scenario == "cancel" {
				if !errors.Is(err, context.Canceled) {
					t.Fatalf("query lost caller cancellation: %v", err)
				}
			} else if err != nil {
				t.Fatal(err)
			}
			for _, span := range recorder.Ended() {
				if scenario != "cancel" && span.Name() == "postgresql transaction" {
					t.Fatal("transaction ended before completion")
				}
			}
			if scenario == "commit_failure" {
				if _, err := tx.ExecContext(ctx, "CREATE TEMP TABLE transaction_span_probe (value int UNIQUE DEFERRABLE INITIALLY DEFERRED) ON COMMIT DROP"); err != nil {
					t.Fatal(err)
				}
				if _, err := tx.ExecContext(ctx, "INSERT INTO transaction_span_probe VALUES (1), (1)"); err != nil {
					t.Fatal(err)
				}
			}
			if scenario == "commit" || scenario == "commit_failure" {
				err = tx.Commit()
			} else {
				err = tx.Rollback()
			}
			if scenario == "commit_failure" && err == nil {
				t.Fatal("commit failure was swallowed")
			}
			if (scenario == "commit" || scenario == "rollback") && err != nil {
				t.Fatal(err)
			}
			// A caller's deferred cleanup must not export a second span or overwrite the outcome.
			repeated := tx.Rollback()
			if !errors.Is(repeated, sql.ErrTxDone) {
				t.Fatalf("repeated rollback changed: %v", repeated)
			}
			if scenario == "cancel" {
				waitForTransactionSpan(t, recorder)
				assertTransactionEnvelope(t, recorder, parent, true)
				return
			}
			assertTransactionEnvelope(t, recorder, parent, err != nil)
		})
	}
}

func waitForTransactionSpan(t *testing.T, recorder *tracetest.SpanRecorder) {
	t.Helper()
	deadline := time.NewTimer(5 * time.Second)
	defer deadline.Stop()
	ticker := time.NewTicker(time.Millisecond)
	defer ticker.Stop()
	for {
		for _, span := range recorder.Ended() {
			if span.Name() == "postgresql transaction" {
				return
			}
		}
		select {
		case <-ticker.C:
		case <-deadline.C:
			t.Fatal("native transaction did not finish its span")
		}
	}
}

func TestUnobservedTransactionPreservesQueryParent(t *testing.T) {
	recorder := recordDatabaseSpans(t)
	_, database, ctx := integrationRepository(t)
	tx, err := database.BeginTx(ctx, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer func() {
		if err := tx.Rollback(); err != nil && !errors.Is(err, sql.ErrTxDone) {
			t.Error(err)
		}
	}()
	queryCtx, parent := otel.Tracer("test").Start(ctx, "late request")
	defer parent.End()
	if _, err := tx.ExecContext(queryCtx, "SELECT 42"); err != nil {
		t.Fatal(err)
	}
	if err := tx.Commit(); err != nil {
		t.Fatal(err)
	}
	requireDatabaseStatement(t, recorder.Ended(), "SELECT 42", "SELECT", parent.SpanContext())
	for _, span := range recorder.Ended() {
		if span.Name() == "postgresql transaction" {
			t.Fatal("unparented transaction manufactured a trace root")
		}
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
