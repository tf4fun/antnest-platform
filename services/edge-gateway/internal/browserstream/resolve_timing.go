package browserstream

import (
	"time"

	"github.com/tf4fun/antnest-platform/services/edge-gateway/internal/identity"
)

// ValidateTiming returns the actual Resolve start that anchors authority age.
// The current invocation has its own reply budget, even for a fast cache hit.
// Legacy direct adapters without private metadata retain their original timing.
func ValidateTiming(principal identity.Principal, probeStarted time.Time, maximumStale time.Duration, now time.Time) (time.Time, error) {
	interval := Interval(maximumStale, principal.ActivityIntervalMS)
	if probeStarted.IsZero() || probeStarted.After(now) || now.Sub(probeStarted) > interval {
		return time.Time{}, ErrUnavailable
	}
	started, completed, validUntil := principal.ResolveStartedAt, principal.ResolveCompletedAt, principal.ResolveValidUntil
	if started.IsZero() && completed.IsZero() && validUntil.IsZero() && !principal.ResolveCacheHit {
		return probeStarted, nil
	}
	if started.IsZero() || completed.IsZero() || validUntil.IsZero() || started.After(completed) || completed.After(now) ||
		!validUntil.After(now) || validUntil.After(principal.IdleExpiresAt) || validUntil.After(principal.ExpiresAt) ||
		principal.ContextExpiresAt.IsZero() || validUntil.After(principal.ContextExpiresAt) ||
		!started.Add(maximumStale-CloseGrace(maximumStale)).After(now) ||
		!principal.ResolveCacheHit && completed.Sub(started) > interval {
		return time.Time{}, ErrUnavailable
	}
	return started, nil
}
