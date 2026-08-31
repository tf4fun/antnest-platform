package repository

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"

	sdktrace "go.opentelemetry.io/otel/sdk/trace"
	"go.opentelemetry.io/otel/sdk/trace/tracetest"

	"soft/antnest-platform/services/identity-service/internal/domain"
)

func TestRepositoryErrorClassIsBounded(t *testing.T) {
	tests := []struct {
		name string
		err  error
		want string
	}{
		{name: "not found", err: domain.ErrNotFound, want: "not_found"},
		{name: "conflict", err: domain.ErrConflict, want: "conflict"},
		{name: "forbidden", err: domain.ErrForbidden, want: "forbidden"},
		{name: "invalid argument", err: domain.InvalidArgument("bad filter"), want: "invalid_argument"},
		{name: "unauthenticated", err: domain.ErrUnauthenticated, want: "unauthenticated"},
		{name: "inactive", err: domain.ErrInactive, want: "inactive_principal"},
		{
			name: "specific domain rejection",
			err:  domain.NewError("oidc_exchange_in_progress", "callback is already claimed", false),
			want: "domain_error",
		},
		{name: "wrapped", err: errors.New("postgres://user:secret@example.test/identity"), want: "persistence_error"},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			if got := repositoryErrorClass(test.err); got != test.want {
				t.Fatalf("repository error class = %q, want %q", got, test.want)
			}
		})
	}
}

func TestRepositorySpanRecordsOnlyBoundedErrorClass(t *testing.T) {
	tests := []struct {
		name      string
		err       error
		wantClass string
		sensitive string
	}{
		{
			name: "persistence failure", err: errors.New("postgres://user:secret@example.test/identity"),
			wantClass: "persistence_error", sensitive: "secret",
		},
		{
			name: "domain rejection",
			err: domain.NewError(
				"oidc_exchange_in_progress", "provider response contains sensitive-value", false,
			),
			wantClass: "domain_error", sensitive: "sensitive-value",
		},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			recorder := tracetest.NewSpanRecorder()
			provider := sdktrace.NewTracerProvider(sdktrace.WithSpanProcessor(recorder))
			t.Cleanup(func() { _ = provider.Shutdown(context.Background()) })
			ctx, span := provider.Tracer("test").Start(context.Background(), "repository operation")

			finishRepositoryOperation(ctx, span, time.Now(), "test", test.err)

			spans := recorder.Ended()
			if len(spans) != 1 {
				t.Fatalf("ended spans = %d, want 1", len(spans))
			}
			exceptionMessage := ""
			for _, event := range spans[0].Events() {
				for _, attr := range event.Attributes {
					if string(attr.Key) == "exception.message" {
						exceptionMessage = attr.Value.AsString()
					}
				}
			}
			if exceptionMessage != test.wantClass {
				t.Fatalf("exception message = %q, want %q", exceptionMessage, test.wantClass)
			}
			if strings.Contains(exceptionMessage, test.sensitive) {
				t.Fatalf("repository span leaked raw error: %q", exceptionMessage)
			}
		})
	}
}
