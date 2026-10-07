package postgres

import (
	"context"
	"errors"
	"fmt"
	"testing"

	"github.com/jackc/pgx/v5/pgconn"
)

func serializationFailure() error {
	return fmt.Errorf("commit Runtime transition: %w", &pgconn.PgError{Code: "40001"})
}

func TestRetrySerializableRerunsOnlySerializationFailures(t *testing.T) {
	calls := 0
	result, err := retrySerializable(t.Context(), func() (int, error) {
		calls++
		if calls < 3 {
			return 0, serializationFailure()
		}
		return calls, nil
	})
	if err != nil || result != 3 || calls != 3 {
		t.Fatalf("result=%d calls=%d err=%v", result, calls, err)
	}

	for _, failure := range []error{
		errors.New("platform unavailable"),
		&pgconn.PgError{Code: "23505"},
		&pgconn.PgError{Code: "40P01"},
	} {
		calls = 0
		_, err := retrySerializable(t.Context(), func() (int, error) {
			calls++
			return 0, failure
		})
		if !errors.Is(err, failure) || calls != 1 {
			t.Fatalf("%v retried %d times", failure, calls)
		}
	}
}

func TestRetrySerializableIsBounded(t *testing.T) {
	calls := 0
	_, err := retrySerializable(t.Context(), func() (int, error) {
		calls++
		return 0, serializationFailure()
	})
	if !isSerializationFailure(err) || calls != serializableAttempts {
		t.Fatalf("calls=%d err=%v", calls, err)
	}

	ctx, cancel := context.WithCancel(t.Context())
	calls = 0
	_, err = retrySerializable(ctx, func() (int, error) {
		calls++
		cancel()
		return 0, serializationFailure()
	})
	if !isSerializationFailure(err) || calls != 1 {
		t.Fatalf("cancelled retry: calls=%d err=%v", calls, err)
	}
}
