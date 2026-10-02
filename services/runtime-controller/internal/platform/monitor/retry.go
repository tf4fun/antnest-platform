package monitor

import (
	"math/rand/v2"
	"time"

	"github.com/tf4fun/antnest-platform/services/runtime-controller/internal/diagnostics"
)

// PermanentError marks a configuration, schema or programming failure that
// retrying cannot repair. Dependency transport errors remain transient.
type PermanentError struct{ Err error }

func (e *PermanentError) Error() string {
	if e.Err == nil {
		return "permanent observation monitor error"
	}
	return e.Err.Error()
}

func (e *PermanentError) Unwrap() error { return e.Err }
func (*PermanentError) Permanent() bool { return true }

func isPermanent(err error) bool { return diagnostics.IsPermanent(err) }

type retryBackoff struct {
	initial time.Duration
	maximum time.Duration
	current time.Duration
	jitter  func(time.Duration) time.Duration
}

func newRetryBackoff(initial, maximum time.Duration) *retryBackoff {
	return &retryBackoff{initial: initial, maximum: maximum, current: initial,
		jitter: func(limit time.Duration) time.Duration {
			return time.Duration(rand.Int64N(int64(limit) + 1))
		},
	}
}

func (b *retryBackoff) next() time.Duration {
	base := b.current
	jitterLimit := min(base/5, b.maximum-base)
	delay := base + b.jitter(jitterLimit)
	if base >= b.maximum-base {
		b.current = b.maximum
	} else {
		b.current = base * 2
	}
	return delay
}

func (b *retryBackoff) reset() { b.current = b.initial }
