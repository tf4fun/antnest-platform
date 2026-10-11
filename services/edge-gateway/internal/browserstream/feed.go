package browserstream

import (
	"context"
	"time"

	"github.com/tf4fun/antnest-platform/services/edge-gateway/internal/identity"
)

type FeedSource interface {
	ListSessionRevocations(context.Context, int64, int) (identity.SessionRevocationPage, error)
}

// FeedObserver applies events synchronously. Catch-up is published only after
// the stream registry and every observer have applied a validated terminal page.
type FeedObserver interface {
	ApplySessionRevocation(identity.SessionRevocation)
	SessionFeedCaughtUp(time.Time)
}

// Poll is a single process-owned loop. The Identity client validates ordered
// pages; this loop retains only a cursor, reset to zero on every process start.
// Feed outages and subscription races never disable independent live checks.
func (registry *Registry) Poll(ctx context.Context, source FeedSource, observers ...FeedObserver) {
	var cursor int64
	timer := time.NewTimer(time.Hour)
	defer timer.Stop()
	for ctx.Err() == nil {
		// Bounded catchup prevents a continuously growing feed from monopolizing
		// the process; no historical event or private SID cache is accumulated.
		for range 4 {
			if ctx.Err() != nil {
				return
			}
			callCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
			started := time.Now()
			page, err := source.ListSessionRevocations(callCtx, cursor, 500)
			if callCtx.Err() != nil {
				err = callCtx.Err()
			}
			cancel()
			if err != nil {
				break
			}
			for _, event := range page.Events {
				if ctx.Err() != nil {
					return
				}
				registry.Revoke(event)
				for _, observer := range observers {
					if ctx.Err() != nil {
						return
					}
					observer.ApplySessionRevocation(event)
				}
			}
			if ctx.Err() != nil {
				return
			}
			cursor = page.NextSequence
			if len(page.Events) < 500 {
				for _, observer := range observers {
					if ctx.Err() != nil {
						return
					}
					observer.SessionFeedCaughtUp(started)
				}
				break
			}
		}
		timer.Reset(time.Second)
		select {
		case <-ctx.Done():
			return
		case <-timer.C:
		}
	}
}
