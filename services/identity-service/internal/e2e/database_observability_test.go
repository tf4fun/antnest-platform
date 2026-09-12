package e2e

import (
	"context"
	"errors"
	"os"
	"strings"
	"testing"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/codes"
	sdktrace "go.opentelemetry.io/otel/sdk/trace"
	"go.opentelemetry.io/otel/sdk/trace/tracetest"
	"go.opentelemetry.io/otel/trace"
)

func TestPostgresDriverObservationAutomaticExecution(t *testing.T) {
	databaseURL := os.Getenv("ANTNEST_IDENTITY_TEST_DATABASE_URL")
	if databaseURL == "" {
		t.Skip("ANTNEST_IDENTITY_TEST_DATABASE_URL is not set")
	}
	provider, recorder := recordDatabaseSpans(t)
	pool := newIsolatedPool(t, databaseURL)
	if _, err := pool.Exec(t.Context(), `CREATE TABLE driver_observation (value TEXT NOT NULL)`); err != nil {
		t.Fatal(err)
	}
	const query = `SELECT $1::text`
	const canary = "DB-BIND-RESULT-CANARY"
	if value, err := unwrappedDatabaseQuery(t.Context(), pool, canary); err != nil || value != canary {
		t.Fatalf("unparented query: value matches=%v, err=%v", value == canary, err)
	}
	remote := trace.NewSpanContext(trace.SpanContextConfig{
		TraceID: trace.TraceID{1}, SpanID: trace.SpanID{2}, TraceFlags: trace.FlagsSampled, Remote: true,
	})
	nonRecording := trace.ContextWithRemoteSpanContext(t.Context(), remote)
	if value, err := unwrappedDatabaseQuery(nonRecording, pool, canary); err != nil || value != canary {
		t.Fatalf("non-recording parent query: value matches=%v, err=%v", value == canary, err)
	}
	if spans := recorder.Ended(); len(spans) != 0 {
		t.Fatalf("unparented database work created %d root spans", len(spans))
	}

	ctx, parent := provider.Tracer("identity-driver-test").Start(t.Context(), "database execution")
	defer parent.End()
	if value, err := unwrappedDatabaseQuery(ctx, pool, canary); err != nil || value != canary {
		t.Fatalf("unwrapped query: value matches=%v, err=%v", value == canary, err)
	}
	const rowsSQL = `SELECT $1::text UNION ALL SELECT $2::text`
	rows, err := pool.Query(ctx, rowsSQL, canary, canary)
	if err != nil {
		t.Fatal(err)
	}
	values, err := pgx.CollectRows(rows, pgx.RowTo[string])
	if err != nil || len(values) != 2 || values[0] != canary || values[1] != canary {
		t.Fatalf("query rows: count=%d, err=%v", len(values), err)
	}

	const insertSQL = `INSERT INTO driver_observation (value) VALUES ($1)`
	for _, commit := range []bool{true, false} {
		tx, err := pool.BeginTx(ctx, pgx.TxOptions{})
		if err != nil {
			t.Fatal(err)
		}
		if _, err := tx.Exec(ctx, insertSQL, canary); err != nil {
			if rollbackErr := tx.Rollback(context.WithoutCancel(ctx)); rollbackErr != nil {
				t.Errorf("rollback failed insert: %v", rollbackErr)
			}
			t.Fatal(err)
		}
		if commit {
			err = tx.Commit(ctx)
		} else {
			err = tx.Rollback(context.WithoutCancel(ctx))
		}
		if err != nil {
			t.Fatal(err)
		}
	}
	var count int
	if err := pool.QueryRow(t.Context(), `SELECT count(*) FROM driver_observation`).Scan(&count); err != nil || count != 1 {
		t.Fatalf("commit/rollback rows=%d, err=%v", count, err)
	}

	batch := &pgx.Batch{}
	batch.Queue(query, canary)
	batch.Queue(insertSQL, canary)
	results := pool.SendBatch(ctx, batch)
	var value string
	scanErr := results.QueryRow().Scan(&value)
	_, execErr := results.Exec()
	closeErr := results.Close()
	if err := errors.Join(scanErr, execErr, closeErr); err != nil || value != canary {
		t.Fatalf("batch: value matches=%v, err=%v", value == canary, err)
	}

	connection, err := pgx.ConnectConfig(ctx, pool.Config().ConnConfig)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if err := connection.Close(context.Background()); err != nil {
			t.Errorf("close dedicated connection: %v", err)
		}
	})
	if value, err := unwrappedDatabaseQuery(ctx, connection, canary); err != nil || value != canary {
		t.Fatalf("dedicated query: value matches=%v, err=%v", value == canary, err)
	}
	const errorSQL = `SELECT 1 / $1::integer`
	_, err = pool.Exec(ctx, errorSQL, 0)
	var postgres *pgconn.PgError
	if !errors.As(err, &postgres) || postgres.Code != "22012" {
		t.Fatalf("database error=%v, want division-by-zero SQLSTATE", err)
	}
	parent.End()
	assertDriverQuerySpans(t, recorder.Ended(), parent.SpanContext(), map[string]int{
		query: 3, rowsSQL: 1, insertSQL: 3, "begin": 2, "commit": 1, "rollback": 1, errorSQL: 1,
	})
}

// New call sites need only the pgx execution API, not a repository observation wrapper.
func unwrappedDatabaseQuery(ctx context.Context, queryer interface {
	QueryRow(context.Context, string, ...any) pgx.Row
}, value string) (string, error) {
	var result string
	err := queryer.QueryRow(ctx, `SELECT $1::text`, value).Scan(&result)
	return result, err
}

func recordDatabaseSpans(t *testing.T) (*sdktrace.TracerProvider, *tracetest.SpanRecorder) {
	t.Helper()
	recorder := tracetest.NewSpanRecorder()
	provider := sdktrace.NewTracerProvider(sdktrace.WithSpanProcessor(recorder))
	previous := otel.GetTracerProvider()
	otel.SetTracerProvider(provider)
	t.Cleanup(func() {
		otel.SetTracerProvider(previous)
		if err := provider.Shutdown(context.Background()); err != nil {
			t.Errorf("shutdown tracer provider: %v", err)
		}
	})
	return provider, recorder
}

func spanAttribute(span sdktrace.ReadOnlySpan, key string) string {
	for _, attr := range span.Attributes() {
		if string(attr.Key) == key {
			return attr.Value.AsString()
		}
	}
	return ""
}

func assertDriverQuerySpans(t *testing.T, spans []sdktrace.ReadOnlySpan, parent trace.SpanContext, want map[string]int) {
	t.Helper()
	byID := make(map[trace.SpanID]sdktrace.ReadOnlySpan)
	for _, span := range spans {
		byID[span.SpanContext().SpanID()] = span
	}
	counts := make(map[string]int)
	for _, span := range spans {
		assertNoRepositoryObservation(t, span)
		assertNoDatabaseContent(t, span)
		query := spanAttribute(span, "db.query.text")
		if span.Name() == "pool.acquire" || spanAttribute(span, "pgx.prepare_stmt.name") != "" {
			t.Fatal("prepare or pool acquisition span adds execution noise")
		}
		if query == "" {
			continue
		}
		counts[query]++
		if span.InstrumentationScope().Name != "github.com/exaring/otelpgx" || span.SpanKind() != trace.SpanKindClient {
			t.Fatalf("query instrumented by %q with kind %v", span.InstrumentationScope().Name, span.SpanKind())
		}
		operation := strings.ToUpper(strings.Fields(query)[0])
		if span.Name() != operation || spanAttribute(span, "db.operation.name") != operation {
			t.Fatalf("query span name=%q, want default operation %q", span.Name(), operation)
		}
		if spanAttribute(span, "db.system.name") != "postgresql" || span.SpanContext().TraceID() != parent.TraceID() {
			t.Fatal("query lost database metadata or parent trace")
		}
		if span.Parent().SpanID() != parent.SpanID() {
			batchParent := byID[span.Parent().SpanID()]
			if batchParent == nil || (batchParent.Name() != "batch start" && batchParent.Name() != "postgresql transaction") || batchParent.Parent().SpanID() != parent.SpanID() {
				t.Fatalf("query %q has unexpected parent", query)
			}
		}
		if query == `SELECT 1 / $1::integer` {
			if span.Status().Code != codes.Error || spanAttribute(span, "pgx.sql_state") != "22012" || len(span.Events()) == 0 {
				t.Fatal("database error span lost status, SQLSTATE or exception")
			}
		} else if span.Status().Code == codes.Error {
			t.Fatalf("successful query %q marked as error", query)
		}
	}
	for query, expected := range want {
		if counts[query] != expected {
			t.Errorf("query %q spans=%d, want %d", query, counts[query], expected)
		}
	}
	if len(counts) != len(want) {
		t.Errorf("query statement count=%d, want %d", len(counts), len(want))
	}
}

func assertNoRepositoryObservation(t *testing.T, span sdktrace.ReadOnlySpan) {
	t.Helper()
	if strings.HasPrefix(span.Name(), "identity.repository.") || spanAttribute(span, "antnest.repository.operation") != "" {
		t.Fatalf("legacy repository observation remains: %s", span.Name())
	}
}

func assertNoDatabaseContent(t *testing.T, span sdktrace.ReadOnlySpan) {
	t.Helper()
	for _, attr := range span.Attributes() {
		if string(attr.Key) == "pgx.query.parameters" || string(attr.Key) == "db.connection_string" || strings.Contains(attr.Value.String(), "DB-BIND-RESULT-CANARY") {
			t.Fatalf("database span contains bind values, results or connection string: %s", attr.Key)
		}
	}
	if strings.Contains(span.Name()+span.Status().Description, "DB-BIND-RESULT-CANARY") {
		t.Fatal("database span name/status contains bind values or results")
	}
	for _, event := range span.Events() {
		for _, attr := range event.Attributes {
			if strings.Contains(attr.Value.String(), "DB-BIND-RESULT-CANARY") {
				t.Fatal("database event contains bind values or results")
			}
		}
	}
}

func assertProtocolDatabaseSpans(t *testing.T, spans []sdktrace.ReadOnlySpan, route string) {
	t.Helper()
	servers := make(map[trace.SpanID]bool)
	for _, span := range spans {
		assertNoRepositoryObservation(t, span)
		if span.SpanKind() == trace.SpanKindServer && spanAttribute(span, "http.route") == route {
			servers[span.SpanContext().SpanID()] = true
		}
	}
	for _, span := range spans {
		if span.Name() == "postgresql transaction" && span.SpanKind() == trace.SpanKindInternal && servers[span.Parent().SpanID()] {
			servers[span.SpanContext().SpanID()] = true
		}
	}
	for _, span := range spans {
		if span.InstrumentationScope().Name == "github.com/exaring/otelpgx" && spanAttribute(span, "db.query.text") != "" && servers[span.Parent().SpanID()] {
			return
		}
	}
	t.Fatalf("no driver query directly parented by protocol route %q", route)
}
