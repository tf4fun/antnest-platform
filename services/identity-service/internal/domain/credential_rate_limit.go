package domain

import "time"

type CredentialRateLimitError struct {
	RetryAfterSeconds int
}

func (e *CredentialRateLimitError) Error() string { return ErrCredentialRateLimited.Error() }
func (e *CredentialRateLimitError) Unwrap() error { return ErrCredentialRateLimited }

func CredentialRateLimited(remaining time.Duration) *CredentialRateLimitError {
	// Clamp before adding the ceiling offset, including for invalid durations.
	remaining = min(max(remaining, time.Nanosecond), 15*time.Minute)
	seconds := int((remaining + time.Second - 1) / time.Second)
	return &CredentialRateLimitError{RetryAfterSeconds: seconds}
}
