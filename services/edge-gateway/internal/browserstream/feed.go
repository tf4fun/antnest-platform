package browserstream

import (
	"context"
	"time"

	"github.com/tf4fun/antnest-platform/services/edge-gateway/internal/identity"
)

type FeedSource interface {
	ListSessionRevocations(context.Context, int64, int) (identity.SessionRevocationPage, error)
}

// Poll is a single process-owned loop. The Identity client validates ordered
// pages; this loop retains only a cursor, reset to zero on every process start.
// Feed outages and subscription races never disable independent live checks.
func (registry *Registry) Poll(ctx context.Context, source FeedSource) {
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
			page, err := source.ListSessionRevocations(callCtx, cursor, 500)
			if callCtx.Err() != nil {
				err = callCtx.Err()
			}
			cancel()
			if err != nil {
				break
			}
			for _, event := range page.Events {
				registry.Revoke(event)
			}
			cursor = page.NextSequence
			if len(page.Events) < 500 {
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
