package domain

import (
	"errors"
	"fmt"
	"testing"
	"time"
)

func TestCredentialRateLimitKeepsFixedPublicErrorAndBoundedCeiling(t *testing.T) {
	for _, row := range []struct {
		delay time.Duration
		want  int
	}{
		{-time.Second, 1}, {0, 1}, {time.Nanosecond, 1}, {time.Second, 1},
		{time.Second + time.Nanosecond, 2}, {899*time.Second + time.Nanosecond, 900},
		{15 * time.Minute, 900}, {time.Duration(1<<63 - 1), 900},
	} {
		err := fmt.Errorf("private operation context: %w", CredentialRateLimited(row.delay))
		var limited *CredentialRateLimitError
		code, message, retryable := ErrorDetails(err)
		if !errors.Is(err, ErrCredentialRateLimited) || !errors.As(err, &limited) || limited.RetryAfterSeconds != row.want ||
			code != "credential_rate_limited" || message != "Too many password attempts" || !retryable {
			t.Fatalf("rate-limit metadata for delay %s: code=%s message=%s retryable=%t", row.delay, code, message, retryable)
		}
	}
}
