package ports

import (
	"context"
	"errors"
	"time"
)

var ErrLifecycleRecoveryClaimLost = errors.New("lifecycle recovery claim lost")

type lifecycleRecoveryTokenKey struct{}

type LifecycleRecoveryToken struct {
	RequestID string
	WorkerID  string
	Attempt   int64
}

func WithLifecycleRecoveryToken(
	ctx context.Context, token LifecycleRecoveryToken,
) context.Context {
	return context.WithValue(ctx, lifecycleRecoveryTokenKey{}, token)
}

func LifecycleRecoveryTokenFromContext(
	ctx context.Context,
) (LifecycleRecoveryToken, bool) {
	token, ok := ctx.Value(lifecycleRecoveryTokenKey{}).(LifecycleRecoveryToken)
	return token, ok
}

type ClaimLifecycleRecovery struct {
	WorkerID      string
	LeaseDuration time.Duration
}

type LifecycleRecoveryClaim struct {
	Operation           LifecycleOperationRecord
	WorkerID            string
	Attempt             int64
	LeaseUntil          time.Time
	ConsecutiveFailures int64
}

type StartLifecycleRecoveryAttempt struct {
	RequestID   string
	WorkerID    string
	Attempt     int64
	TraceParent string
}

type ReleaseLifecycleRecoveryClaim struct {
	RequestID  string
	WorkerID   string
	Attempt    int64
	Failed     bool
	RetryAfter time.Duration
}

type QuarantineLifecycleRecoveryClaim struct {
	RequestID   string
	WorkerID    string
	Attempt     int64
	ErrorCode   string
	ErrorDetail string
	EventID     string
	TraceID     string
}

type LifecycleRecoveryStore interface {
	ClaimLifecycleRecovery(
		context.Context, ClaimLifecycleRecovery,
	) (LifecycleRecoveryClaim, bool, error)
	StartLifecycleRecoveryAttempt(context.Context, StartLifecycleRecoveryAttempt) error
	ReleaseLifecycleRecoveryClaim(context.Context, ReleaseLifecycleRecoveryClaim) error
	QuarantineLifecycleRecoveryClaim(
		context.Context, QuarantineLifecycleRecoveryClaim,
	) error
}
