package postgres

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/codes"
	sdktrace "go.opentelemetry.io/otel/sdk/trace"
	"go.opentelemetry.io/otel/trace"

	"soft/antnest-platform/services/runtime-controller/internal/deployment"
	"soft/antnest-platform/services/runtime-controller/internal/observation"
	repositoryport "soft/antnest-platform/services/runtime-controller/internal/repository"
)

const telemetryEchoSQL = "SELECT $1::text AS telemetry_echo"

func TestRepositoryTelemetryQueryAndError(t *testing.T) {
	recorder := recordDatabaseSpans(t)
	repository, database, ctx := integrationRepository(t)
	ctx, parent := otel.Tracer("postgres-integration").Start(ctx, "request")
	defer parent.End()
	store, err := observation.NewRepository(repository, observation.NewHub(), &observation.Health{})
	if err != nil {
		t.Fatal(err)
	}
	const privateValue = "runtime-telemetry-private-query-value"
	if _, err := store.GetEnvironment(ctx, privateValue); !errors.Is(err, repositoryport.ErrNotFound) {
		t.Fatalf("missing environment error = %v", err)
	}
	missing := requireDatabaseStatement(t, recorder.Ended(), selectEnvironmentSQL, "SELECT", parent.SpanContext())
	if missing.Status().Code == codes.Error {
		t.Fatal("a missing row became a database execution error")
	}
	value, err := queryTelemetryEcho(ctx, database, privateValue)
	if err != nil || value != privateValue {
		t.Fatalf("new query result = %q, error = %v", value, err)
	}
	requireDatabaseStatement(t, recorder.Ended(), telemetryEchoSQL, "SELECT", parent.SpanContext())

	const failureSQL = "SELECT 1 / $1::int"
	var result int
	err = database.QueryRowContext(ctx, failureSQL, 0).Scan(&result)
	var databaseError *pgconn.PgError
	if !errors.As(err, &databaseError) || databaseError.Code != "22012" {
		t.Fatalf("database error was not preserved: %v", err)
	}
	failure := requireDatabaseStatement(t, recorder.Ended(), failureSQL, "SELECT", parent.SpanContext())
	if failure.Status().Code != codes.Error || databaseSpanAttribute(failure, "pgx.sql_state") != "22012" {
		t.Fatalf("database error telemetry = %v, %v", failure.Status(), failure.Attributes())
	}
	if len(failure.Events()) != 1 || failure.Events()[0].Name != "exception" {
		t.Fatalf("database exception events = %v", failure.Events())
	}
	requireDatabasePrivacy(t, recorder.Ended(), privateValue)
}

func TestRepositoryTelemetryRequiresRecordingParent(t *testing.T) {
	recorder := recordDatabaseSpans(t)
	_, database, ctx := integrationRepository(t)
	remote := trace.NewSpanContext(trace.SpanContextConfig{
		TraceID: trace.TraceID{1}, SpanID: trace.SpanID{2}, TraceFlags: trace.FlagsSampled, Remote: true,
	})
	for _, queryCtx := range []context.Context{ctx, trace.ContextWithRemoteSpanContext(ctx, remote)} {
		if _, err := queryTelemetryEcho(queryCtx, database, "unparented-value"); err != nil {
			t.Fatal(err)
		}
	}
	if spans := recorder.Started(); len(spans) != 0 {
		t.Fatalf("constructor or queries without a recording parent created %d spans", len(spans))
	}
}

func TestRepositoryTelemetryTransactions(t *testing.T) {
	recorder := recordDatabaseSpans(t)
	repository, _, ctx := integrationRepository(t)
	ctx, parent := otel.Tracer("postgres-integration").Start(ctx, "mutation")
	defer parent.End()
	operation := integrationOperation("telemetry-private-request", deployment.OperationInitializeRuntime, time.Now().UTC())
	operation.Transition = deployment.LifecycleInitializing
	stored, replay, err := repository.BeginTransition(ctx, operation)
	if err != nil || replay || stored.RequestID != operation.RequestID {
		t.Fatalf("begin transition = %+v, replay = %t, error = %v", stored, replay, err)
	}
	requireDatabaseStatement(t, recorder.Ended(), "begin isolation level serializable", "BEGIN", parent.SpanContext())
	requireDatabaseStatement(t, recorder.Ended(), insertOperationSQL, "INSERT", parent.SpanContext())
	requireDatabaseStatement(t, recorder.Ended(), "commit", "COMMIT", parent.SpanContext())

	beforeReplay := len(recorder.Ended())
	if replayed, replay, err := repository.BeginTransition(ctx, operation); err != nil || !replay || replayed.Attempt != 2 {
		t.Fatalf("idempotent replay = %+v, replay = %t, error = %v", replayed, replay, err)
	}
	requireDatabaseStatement(t, recorder.Ended()[beforeReplay:], "commit", "COMMIT", parent.SpanContext())
	beforeConflict := len(recorder.Ended())
	operation.RequestDigest = "telemetry-private-conflicting-digest"
	if _, _, err := repository.BeginTransition(ctx, operation); !errors.Is(err, repositoryport.ErrIdempotencyConflict) {
		t.Fatalf("idempotency conflict changed: %v", err)
	}
	rolledBack := requireDatabaseStatement(t, recorder.Ended()[beforeConflict:], "rollback", "ROLLBACK", parent.SpanContext())
	if rolledBack.Status().Code == codes.Error {
		t.Fatal("business conflict became a failed SQL rollback")
	}
	requireDatabasePrivacy(t, recorder.Ended(), operation.RequestID, operation.RequestDigest, operation.SpecDigest)
}

func TestRepositoryTelemetryDedicatedLocks(t *testing.T) {
	recorder := recordDatabaseSpans(t)
	repository, database, ctx := integrationRepository(t)
	if database.Stats().MaxOpenConnections != 20 || repository.lockDatabase.Stats().MaxOpenConnections != 8 {
		t.Fatal("production query and lock pool limits were not retained")
	}
	repository.mutationProbeInterval = time.Hour
	repository.leadershipProbeInterval = time.Hour
	ctx, parent := otel.Tracer("postgres-integration").Start(ctx, "locked-mutation")
	defer parent.End()
	const agentID = "telemetry-private-lock-agent"
	if err := repository.WithAgentLock(ctx, agentID, func(lockedCtx context.Context) error {
		_, err := queryTelemetryEcho(lockedCtx, database, agentID)
		return err
	}); err != nil {
		t.Fatal(err)
	}
	requireDatabaseStatement(t, recorder.Ended(), "SELECT pg_try_advisory_lock($1, hashtext($2))", "SELECT", parent.SpanContext())
	requireDatabaseStatement(t, recorder.Ended(), "SELECT pg_advisory_unlock($1, hashtext($2))", "SELECT", parent.SpanContext())
	requireDatabaseStatement(t, recorder.Ended(), telemetryEchoSQL, "SELECT", parent.SpanContext())
	leadership, acquired, err := repository.TryAcquireObservationLeadership(ctx)
	if err != nil || !acquired {
		t.Fatalf("observation leadership acquired = %t, error = %v", acquired, err)
	}
	t.Cleanup(func() {
		if err := leadership.Release(ctx); err != nil {
			t.Error(err)
		}
	})
	if err := leadership.Release(ctx); err != nil {
		t.Fatal(err)
	}
	requireDatabaseStatement(t, recorder.Ended(), "SELECT pg_try_advisory_lock($1, $2)", "SELECT", parent.SpanContext())
	requireDatabaseStatement(t, recorder.Ended(), "SELECT pg_advisory_unlock($1, $2)", "SELECT", parent.SpanContext())
	requireDatabasePrivacy(t, recorder.Ended(), agentID)
}

func TestRepositoryTelemetryListenerEndsSQLSpanBeforeNotifications(t *testing.T) {
	recorder := recordDatabaseSpans(t)
	repository, _, ctx := integrationRepository(t)
	ctx, parent := otel.Tracer("postgres-integration").Start(ctx, "notification-start")
	defer parent.End()
	listenerCtx, cancel := context.WithCancel(ctx)
	ready := make(chan struct{})
	notifications := make(chan string, 1)
	done := make(chan struct{})
	var listenerErr error
	go func() {
		defer close(done)
		listenerErr = repository.ListenObservationNotifications(listenerCtx, func() { close(ready) }, func(payload string) {
			select {
			case notifications <- payload:
			case <-listenerCtx.Done():
			}
		})
	}()
	t.Cleanup(func() {
		cancel()
		<-done
	})
	select {
	case <-ready:
	case <-done:
		t.Fatalf("listener stopped before readiness: %v", listenerErr)
	case <-ctx.Done():
		t.Fatal(ctx.Err())
	}
	requireDatabaseStatement(t, recorder.Ended(), "LISTEN runtime_controller_observation", "LISTEN", parent.SpanContext())
	if len(recorder.Started()) != len(recorder.Ended())+1 {
		t.Fatal("LISTEN retained a database span for the notification session")
	}
	const payload = "readiness_probe:telemetry-private-notification"
	if err := repository.ProbeObservationNotification(ctx, payload); err != nil {
		t.Fatal(err)
	}
	select {
	case received := <-notifications:
		if received != payload {
			t.Fatalf("notification payload = %q", received)
		}
	case <-ctx.Done():
		t.Fatal(ctx.Err())
	}
	cancel()
	<-done
	if !errors.Is(listenerErr, context.Canceled) {
		t.Fatalf("listener cancellation changed: %v", listenerErr)
	}
	requireDatabaseStatement(t, recorder.Ended(), probeObservationNotificationSQL, "SELECT", parent.SpanContext())
	requireDatabasePrivacy(t, recorder.Ended(), payload)
}

func TestRepositoryTelemetryNativeBatch(t *testing.T) {
	recorder := recordDatabaseSpans(t)
	_, database, ctx := integrationRepository(t)
	ctx, parent := otel.Tracer("postgres-integration").Start(ctx, "batch-request")
	defer parent.End()
	connection, err := database.Conn(ctx)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if err := connection.Close(); err != nil {
			t.Error(err)
		}
	})
	const privateValue = "telemetry-private-batch-value"
	const lengthSQL = "SELECT length($1::text)"
	err = connection.Raw(func(raw any) (resultErr error) {
		stdlibConnection, ok := raw.(*transactionConnection)
		if !ok {
			return fmt.Errorf("expected native pgx stdlib connection, got %T", raw)
		}
		batch := &pgx.Batch{}
		batch.Queue(telemetryEchoSQL, privateValue)
		batch.Queue(lengthSQL, privateValue)
		results := stdlibConnection.Conn.Conn().SendBatch(ctx, batch)
		defer joinCloseError(&resultErr, "telemetry batch", results.Close)
		var value string
		if err := results.QueryRow().Scan(&value); err != nil {
			return err
		}
		var length int
		if err := results.QueryRow().Scan(&length); err != nil {
			return err
		}
		if value != privateValue || length != len(privateValue) {
			return fmt.Errorf("batch query results changed")
		}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	var batchSpan sdktrace.ReadOnlySpan
	for _, span := range recorder.Ended() {
		if span.Name() == "batch start" {
			if batchSpan != nil {
				t.Fatal("duplicate batch span")
			}
			batchSpan = span
		}
	}
	if batchSpan == nil || !batchSpan.Parent().Equal(parent.SpanContext()) {
		t.Fatal("batch did not retain the request parent")
	}
	requireDatabaseStatement(t, recorder.Ended(), telemetryEchoSQL, "SELECT", batchSpan.SpanContext())
	requireDatabaseStatement(t, recorder.Ended(), lengthSQL, "SELECT", batchSpan.SpanContext())
	requireDatabasePrivacy(t, recorder.Ended(), privateValue)
}

// This new SQL caller has no repository method or telemetry wrapper.
func queryTelemetryEcho(ctx context.Context, database *sql.DB, value string) (string, error) {
	var result string
	err := database.QueryRowContext(ctx, telemetryEchoSQL, value).Scan(&result)
	return result, err
}

func requireDatabaseStatement(
	t *testing.T, spans []sdktrace.ReadOnlySpan, query, operation string, parent trace.SpanContext,
) sdktrace.ReadOnlySpan {
	t.Helper()
	var found sdktrace.ReadOnlySpan
	for _, span := range spans {
		if databaseSpanAttribute(span, "db.query.text") != query || databaseSpanAttribute(span, "pgx.prepare_stmt.name") != "" {
			continue
		}
		if found != nil {
			t.Fatalf("duplicate execution spans for %q", query)
		}
		found = span
	}
	if found == nil {
		t.Fatalf("no execution span for %q", query)
	}
	if found.Name() != operation || databaseSpanAttribute(found, "db.operation.name") != operation ||
		found.SpanKind() != trace.SpanKindClient || found.InstrumentationScope().Name != "github.com/exaring/otelpgx" {
		t.Fatalf("unexpected database span: %q, %v, %v", found.Name(), found.SpanKind(), found.Attributes())
	}
	owner := found.Parent()
	for _, span := range spans {
		if span.SpanContext().Equal(owner) && span.Name() == "postgresql transaction" && span.SpanKind() == trace.SpanKindInternal {
			owner = span.Parent()
			break
		}
	}
	if !owner.Equal(parent) || found.SpanContext().TraceID() != parent.TraceID() {
		t.Fatalf("database span %q lost its parent", query)
	}
	return found
}

func databaseSpanAttribute(span sdktrace.ReadOnlySpan, key string) string {
	for _, value := range span.Attributes() {
		if string(value.Key) == key {
			return value.Value.AsString()
		}
	}
	return ""
}

func requireDatabasePrivacy(t *testing.T, spans []sdktrace.ReadOnlySpan, privateValues ...string) {
	t.Helper()
	for _, span := range spans {
		if strings.HasPrefix(span.Name(), "runtime.repository.") || strings.HasSuffix(span.InstrumentationScope().Name, "/repository") {
			t.Errorf("legacy repository wrapper span remains: %q", span.Name())
		}
		if span.Name() == "pool.acquire" || databaseSpanAttribute(span, "pgx.prepare_stmt.name") != "" {
			t.Fatal("prepare or pool acquisition span adds execution noise")
		}
		for _, value := range span.Attributes() {
			key := string(value.Key)
			if key == "pgx.query.parameters" || key == "db.connection_string" || strings.HasPrefix(key, "db.query.parameter.") {
				t.Errorf("unexpected database content attribute %q", key)
			}
		}
		content := fmt.Sprint(span.Name(), span.Attributes(), span.Events(), span.Status())
		for _, value := range privateValues {
			if strings.Contains(content, value) {
				t.Errorf("database span %q exposed a bind value or result", span.Name())
			}
		}
	}
}
