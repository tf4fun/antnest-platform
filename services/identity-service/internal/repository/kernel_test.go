package repository

import (
	"context"
	"errors"
	"strings"
	"testing"

	"github.com/jackc/pgx/v5/pgconn"
	sdktrace "go.opentelemetry.io/otel/sdk/trace"
	"go.opentelemetry.io/otel/sdk/trace/tracetest"

	"github.com/tf4fun/antnest-platform/services/identity-service/internal/domain"
	"github.com/tf4fun/antnest-platform/services/identity-service/internal/telemetry"
)

func TestNormalizedDatabaseErrorPreservesCauseAndSQLState(t *testing.T) {
	cause := &pgconn.PgError{Code: "23505", Message: "PASSWORD-CANARY", Detail: "TOKEN-CANARY"}
	err := normalizeError(cause)
	if !errors.Is(err, domain.ErrConflict) || !errors.Is(err, cause) {
		t.Fatal("normalization lost public error or original cause")
	}
	recorder := tracetest.NewSpanRecorder()
	provider := sdktrace.NewTracerProvider(sdktrace.WithSpanProcessor(recorder))
	t.Cleanup(func() {
		if err := provider.Shutdown(context.Background()); err != nil {
			t.Errorf("shutdown tracer provider: %v", err)
		}
	})
	_, span := provider.Tracer("test").Start(t.Context(), "protocol")
	telemetry.RecordFailure(span, "protocol", err)
	span.End()
	found := false
	for _, attr := range recorder.Ended()[0].Attributes() {
		if string(attr.Key) == "db.response.status_code" && attr.Value.AsString() == "23505" {
			found = true
		}
		if strings.Contains(attr.Value.String(), "CANARY") {
			t.Fatal("database details leaked into protocol error summary")
		}
	}
	if !found {
		t.Fatal("SQLSTATE missing")
	}
}

func TestParsePoolConfigInstallsDriverTracerWithoutChangingPoolSettings(t *testing.T) {
	config, err := ParsePoolConfig("postgres://identity@localhost/identity?sslmode=disable&pool_max_conns=3&application_name=identity-test&search_path=identity_test")
	if err != nil {
		t.Fatal(err)
	}
	if _, ok := config.ConnConfig.Tracer.(databaseTracer); !ok {
		t.Fatalf("connection tracer=%T, want execution-only otelpgx adapter", config.ConnConfig.Tracer)
	}
	if config.MaxConns != 3 || config.ConnConfig.RuntimeParams["application_name"] != "identity-test" || config.ConnConfig.RuntimeParams["search_path"] != "identity_test" {
		t.Fatal("pool settings were not preserved")
	}
	if config, err := ParsePoolConfig("postgres://localhost/identity?pool_max_conns=invalid"); err == nil || config != nil {
		t.Fatal("invalid pool configuration did not preserve parse failure")
	}
}
