package postgres

import (
	"context"
	"errors"
	"fmt"
	"github.com/tf4fun/antnest-platform/services/agent-controller/internal/ports"
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

func TestRepositoryDriverObservationQueryTransactionAndError(t *testing.T) {
	recorder := installDatabaseSpanRecorder(t)
	repository := providerTestRepository(t)
	record := integrationModelRecord(t)
	seedProviderForModel(t, repository, record)

	ctx, parent := otel.Tracer("database-test").Start(context.Background(), "request")
	defer parent.End()
	created, err := repository.PutModelProfile(ctx, record)
	if err != nil || created.ModelProfileID != record.ModelProfileID {
		t.Fatalf("create model: id=%s err=%v", created.ModelProfileID, err)
	}
	replayed, err := repository.PutModelProfile(ctx, record)
	if err != nil || replayed.Revision.ID() != created.Revision.ID() {
		t.Fatalf("replay model: revision=%s err=%v", replayed.Revision.ID(), err)
	}
	if _, err := repository.GetModelProfile(ctx, record.ModelProfileID); err != nil {
		t.Fatal(err)
	}
	if _, err := repository.GetModelProfile(ctx, "missing-model-bind"); !errors.Is(err, ports.ErrNotFound) {
		t.Fatalf("missing model error = %v", err)
	}

	const probeSQL = "SELECT upper($1::text)"
	const privateBind = "private-probe-bind"
	value, err := repository.observationProbe(ctx, privateBind)
	if err != nil || value != strings.ToUpper(privateBind) {
		t.Fatalf("probe result mismatch: %v", err)
	}

	const failureSQL = "SELECT 1 / $1::integer"
	var quotient int
	err = repository.pool.QueryRow(ctx, failureSQL, 0).Scan(&quotient)
	var databaseError *pgconn.PgError
	if !errors.As(err, &databaseError) || databaseError.Code != "22012" {
		t.Fatalf("database error = %v", err)
	}

	spans := recorder.Ended()
	assertDatabaseTrace(t, spans, parent.SpanContext(), privateBind, value, "missing-model-bind")
	assertDirectDatabaseQuery(t, spans, parent.SpanContext(), probeSQL, "SELECT", codes.Unset)
	failure := assertDirectDatabaseQuery(t, spans, parent.SpanContext(), failureSQL, "SELECT", codes.Error)
	if databaseSpanAttribute(failure, "pgx.sql_state") != "22012" || len(failure.Events()) == 0 {
		t.Fatal("database failure is missing SQLSTATE or exception event")
	}
	operations := map[string]int{}
	for _, span := range spans {
		if span.Status().Code == codes.Error && span.SpanContext().SpanID() != failure.SpanContext().SpanID() {
			t.Fatalf("successful SQL or not-found result reported as a database fault: %s", span.Name())
		}
		operations[span.Name()]++
	}
	if operations["BEGIN"] != 2 || operations["COMMIT"] != 1 || operations["ROLLBACK"] != 1 {
		t.Fatalf("transaction boundaries = %+v", operations)
	}
}

// A new repository method needs only the existing pool, not a telemetry wrapper.
func (repository *Repository) observationProbe(ctx context.Context, value string) (string, error) {
	var result string
	err := repository.pool.QueryRow(ctx, "SELECT upper($1::text)", value).Scan(&result)
	return result, err
}

func TestRepositoryDriverObservationBatchAndNoParent(t *testing.T) {
	recorder := installDatabaseSpanRecorder(t)
	repository := providerTestRepository(t)
	background := context.Background()
	if _, err := repository.observationProbe(background, "unparented-bind"); err != nil {
		t.Fatal(err)
	}
	nonRecording := trace.ContextWithSpanContext(background, trace.NewSpanContext(trace.SpanContextConfig{
		TraceID: trace.TraceID{1}, SpanID: trace.SpanID{1}, TraceFlags: trace.FlagsSampled,
	}))
	if _, err := repository.observationProbe(nonRecording, "nonrecording-parent-bind"); err != nil {
		t.Fatal(err)
	}
	if spans := recorder.Ended(); len(spans) != 0 {
		t.Fatalf("SQL without a recording parent emitted %d spans", len(spans))
	}

	ctx, parent := otel.Tracer("database-test").Start(background, "batch request")
	defer parent.End()
	batch := &pgx.Batch{}
	const firstSQL = "SELECT upper($1::text)"
	const secondSQL = "SELECT lower($1::text)"
	batch.Queue(firstSQL, "private-batch-first")
	batch.Queue(secondSQL, "PRIVATE-BATCH-SECOND")
	results := repository.pool.SendBatch(ctx, batch)
	var first, second string
	firstErr := results.QueryRow().Scan(&first)
	secondErr := results.QueryRow().Scan(&second)
	closeErr := results.Close()
	if err := errors.Join(firstErr, secondErr, closeErr); err != nil {
		t.Fatal(err)
	}
	if first != "PRIVATE-BATCH-FIRST" || second != "private-batch-second" {
		t.Fatal("batch results changed")
	}
	spans := recorder.Ended()
	assertDatabaseTrace(t, spans, parent.SpanContext(), "private-batch-first", "PRIVATE-BATCH-SECOND", first, second)
	var batchSpan sdktrace.ReadOnlySpan
	for _, span := range spans {
		if span.Name() == "batch start" {
			if batchSpan != nil || span.Parent().SpanID() != parent.SpanContext().SpanID() {
				t.Fatal("duplicate or detached batch span")
			}
			batchSpan = span
		}
	}
	if batchSpan == nil {
		t.Fatal("missing driver batch span")
	}
	assertDirectDatabaseQuery(t, spans, batchSpan.SpanContext(), firstSQL, "SELECT", codes.Unset)
	assertDirectDatabaseQuery(t, spans, batchSpan.SpanContext(), secondSQL, "SELECT", codes.Unset)
}

func TestEventNotifierDriverObservationConstructorAndReconnectConfig(t *testing.T) {
	databaseURL := os.Getenv("ANTNEST_AGENT_CONTROLLER_TEST_DATABASE_URL")
	if databaseURL == "" {
		t.Skip("ANTNEST_AGENT_CONTROLLER_TEST_DATABASE_URL is not set")
	}
	recorder := installDatabaseSpanRecorder(t)
	ctx, parent := otel.Tracer("database-test").Start(context.Background(), "listener startup")
	defer parent.End()
	notifier, err := OpenEventNotifier(ctx, databaseURL)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(notifier.Close)
	spans := recorder.Ended()
	assertDatabaseTrace(t, spans, parent.SpanContext())
	assertDirectDatabaseQuery(t, spans, parent.SpanContext(), "LISTEN "+agentEventNotificationChannel, "LISTEN", codes.Unset)

	// Reconnect uses the saved config copy, not the repository pool.
	reconnectCtx, reconnect := otel.Tracer("database-test").Start(context.Background(), "listener reconnect")
	defer reconnect.End()
	connection, err := connectEventListener(reconnectCtx, notifier.config.Copy())
	if err != nil {
		t.Fatal(err)
	}
	closeEventListener(connection)
	resumed := recorder.Ended()[len(spans):]
	assertDatabaseTrace(t, resumed, reconnect.SpanContext())
	assertDirectDatabaseQuery(t, resumed, reconnect.SpanContext(), "LISTEN "+agentEventNotificationChannel, "LISTEN", codes.Unset)
}

func installDatabaseSpanRecorder(t *testing.T) *tracetest.SpanRecorder {
	t.Helper()
	previous := otel.GetTracerProvider()
	recorder := tracetest.NewSpanRecorder()
	provider := sdktrace.NewTracerProvider(sdktrace.WithSpanProcessor(recorder))
	otel.SetTracerProvider(provider)
	t.Cleanup(func() {
		otel.SetTracerProvider(previous)
		if err := provider.Shutdown(context.Background()); err != nil {
			t.Errorf("shutdown tracer provider: %v", err)
		}
	})
	return recorder
}

func assertDatabaseTrace(t *testing.T, spans []sdktrace.ReadOnlySpan, parent trace.SpanContext, privateValues ...string) {
	t.Helper()
	if len(spans) == 0 {
		t.Fatal("production constructor emitted no database spans")
	}
	known := map[trace.SpanID]bool{parent.SpanID(): true}
	for _, span := range spans {
		known[span.SpanContext().SpanID()] = true
	}
	for _, span := range spans {
		transaction := span.Name() == "postgresql transaction" && span.SpanKind() == trace.SpanKindInternal &&
			span.InstrumentationScope().Name == "agent_controller.database"
		if span.Name() == "pool.acquire" || databaseSpanAttribute(span, "pgx.prepare_stmt.name") != "" {
			t.Fatal("prepare or pool acquisition span adds execution noise")
		}
		if !transaction && (span.InstrumentationScope().Name != "github.com/exaring/otelpgx" || span.SpanKind() != trace.SpanKindClient) {
			t.Fatalf("unexpected non-driver span: %s (%s)", span.Name(), span.InstrumentationScope().Name)
		}
		if span.SpanContext().TraceID() != parent.TraceID() || !known[span.Parent().SpanID()] {
			t.Fatalf("detached database span: %s", span.Name())
		}
		for _, attr := range span.Attributes() {
			if attr.Key == "pgx.query.parameters" || attr.Key == "db.connection_string" || attr.Key == "antnest.repository.operation" {
				t.Fatalf("unexpected database attribute: %s", attr.Key)
			}
		}
		serialized := fmt.Sprint(span.Name(), span.Attributes(), span.Events(), span.Status())
		for _, value := range privateValues {
			if strings.Contains(serialized, value) {
				t.Fatal("database span contains bind parameter or result content")
			}
		}
	}
}

func assertDirectDatabaseQuery(
	t *testing.T, spans []sdktrace.ReadOnlySpan, parent trace.SpanContext,
	statement, operation string, status codes.Code,
) sdktrace.ReadOnlySpan {
	t.Helper()
	var found sdktrace.ReadOnlySpan
	for _, span := range spans {
		if span.Parent().SpanID() != parent.SpanID() || databaseSpanAttribute(span, "db.query.text") != statement {
			continue
		}
		if found != nil {
			t.Fatalf("duplicate query span for %q", statement)
		}
		found = span
	}
	if found == nil {
		t.Fatalf("missing query span for %q", statement)
	}
	if found.Name() != operation || databaseSpanAttribute(found, "db.operation.name") != operation ||
		databaseSpanAttribute(found, "db.system.name") != "postgresql" || found.Status().Code != status {
		t.Fatalf("unexpected query span: name=%s status=%v attributes=%v", found.Name(), found.Status(), found.Attributes())
	}
	return found
}

func databaseSpanAttribute(span sdktrace.ReadOnlySpan, key string) string {
	for _, attr := range span.Attributes() {
		if string(attr.Key) == key {
			return attr.Value.AsString()
		}
	}
	return ""
}
