package postgres

import (
	"context"
	"errors"
	"math/rand/v2"
	"time"

	"github.com/jackc/pgx/v5/pgconn"
)

const (
	serializableAttempts = 10
	serializableBackoff  = 5 * time.Millisecond
	serializableMaxDelay = 200 * time.Millisecond
)

// The Agent lock serializes one Agent's mutations only. SERIALIZABLE
// transactions of different Agents still share predicate locks, so PostgreSQL
// may abort one with SQLSTATE 40001; the whole transaction must be rerun.
func isSerializationFailure(err error) bool {
	var postgresError *pgconn.PgError
	return errors.As(err, &postgresError) && postgresError.Code == "40001"
}

// retrySerializable reruns attempt, which must own one complete transaction
// and have no effect outside it, after a serialization failure.
func retrySerializable[T any](ctx context.Context, attempt func() (T, error)) (T, error) {
	delay := serializableBackoff
	for remaining := serializableAttempts; ; remaining-- {
		result, err := attempt()
		if err == nil || remaining == 1 || !isSerializationFailure(err) {
			return result, err
		}
		timer := time.NewTimer(delay/2 + rand.N(delay))
		select {
		case <-ctx.Done():
			timer.Stop()
			return result, err
		case <-timer.C:
		}
		delay = min(2*delay, serializableMaxDelay)
	}
}
