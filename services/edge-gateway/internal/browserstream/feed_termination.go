package browserstream

import (
	"context"
	"time"

	"github.com/tf4fun/antnest-platform/services/edge-gateway/internal/identity"
	"go.opentelemetry.io/otel/propagation"
	"go.opentelemetry.io/otel/trace"
)

// FeedTermination is a bounded diagnostic receipt, never a retained credential
// or a new authority decision. The context's first cancellation cause owns it.
type FeedTermination struct {
	At       time.Time
	Reason   string
	Sequence int64
	Source   trace.SpanContext
}

type feedTerminationCause struct{ receipt FeedTermination }

func (*feedTerminationCause) Error() string { return ErrRejected.Error() }
func (*feedTerminationCause) Unwrap() error { return ErrRejected }

func feedCause(event identity.SessionRevocation) error {
	reason := "unknown"
	switch event.Reason {
	case "session_revoked", "password_changed", "role_changed", "user_deactivated", "membership_deactivated", "membership_deleted":
		reason = event.Reason
	}
	parent := propagation.TraceContext{}.Extract(context.Background(), propagation.MapCarrier{"traceparent": event.TraceParent})
	return &feedTerminationCause{FeedTermination{At: time.Now(), Reason: reason, Sequence: event.Sequence, Source: trace.SpanContextFromContext(parent)}}
}

func (guard *Guard) FeedTermination() (FeedTermination, bool) {
	cause, ok := context.Cause(guard.ctx).(*feedTerminationCause)
	if !ok {
		return FeedTermination{}, false
	}
	return cause.receipt, true
}
