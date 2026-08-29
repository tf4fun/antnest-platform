package postgres

import (
	"errors"
	"fmt"
	"testing"

	"github.com/jackc/pgx/v5/pgconn"
)

func TestRetryableTransactionErrors(t *testing.T) {
	for _, code := range []string{"40001", "40P01"} {
		err := fmt.Errorf("wrapped: %w", &pgconn.PgError{Code: code})
		if !isRetryableTransactionError(err) {
			t.Fatalf("expected PostgreSQL error %s to be retryable", code)
		}
	}
	if isRetryableTransactionError(errors.New("application failure")) {
		t.Fatal("application failures must not be retried")
	}
}
