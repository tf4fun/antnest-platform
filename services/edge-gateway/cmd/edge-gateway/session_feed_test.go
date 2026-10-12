package main

import (
	"context"
	"sync/atomic"
	"testing"
	"testing/synctest"
	"time"

	"github.com/tf4fun/antnest-platform/services/edge-gateway/internal/browserstream"
	"github.com/tf4fun/antnest-platform/services/edge-gateway/internal/identity"
)

type blockingSessionFeed struct {
	entered chan struct{}
	joined  atomic.Bool
	calls   atomic.Int32
}

func (source *blockingSessionFeed) ListSessionRevocations(ctx context.Context, after int64, limit int) (identity.SessionRevocationPage, error) {
	source.calls.Add(1)
	close(source.entered)
	<-ctx.Done()
	source.joined.Store(true)
	return identity.SessionRevocationPage{}, ctx.Err()
}

func TestProcessOwnsAndJoinsSessionFeed(t *testing.T) {
	for _, termination := range []string{"parent-cancel", "serve-return"} {
		t.Run(termination, func(t *testing.T) {
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			source := &blockingSessionFeed{entered: make(chan struct{})}
			registry := browserstream.NewRegistry()
			if source.calls.Load() != 0 {
				t.Fatal("registry constructor started hidden work")
			}
			stop := startSessionRevocationFeed(ctx, registry, source)
			defer stop()
			select {
			case <-source.entered:
			case <-time.After(time.Second):
				t.Fatal("process did not start feed")
			}
			if termination == "parent-cancel" {
				cancel()
			}
			stop()
			if !source.joined.Load() || source.calls.Load() != 1 {
				t.Fatal("process did not join its one feed poller")
			}
		})
	}
}

type cacheAwareFeed struct {
	calls  atomic.Int64
	events atomic.Int64
	proofs atomic.Int64
}

func (source *cacheAwareFeed) ListSessionRevocations(context.Context, int64, int) (identity.SessionRevocationPage, error) {
	source.calls.Add(1)
	return identity.SessionRevocationPage{Events: []identity.SessionRevocation{{Sequence: 1, TokenID: "session", UserID: "user", OrganizationID: "org", Reason: "session_revoked", OccurredAt: time.Now()}}, NextSequence: 1}, nil
}

func (source *cacheAwareFeed) ApplySessionRevocation(identity.SessionRevocation) {
	source.events.Add(1)
}

func (source *cacheAwareFeed) SessionFeedCaughtUp(time.Time) { source.proofs.Add(1) }

func TestProcessFeedFansOutToResolveCacheAndJoins(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		source := &cacheAwareFeed{}
		ctx, cancel := context.WithCancel(context.Background())
		defer cancel()
		stop := startSessionRevocationFeed(ctx, browserstream.NewRegistry(), source, source)
		defer stop()
		synctest.Wait()
		stop()
		if source.calls.Load() != 1 || source.events.Load() != 1 || source.proofs.Load() != 1 {
			t.Fatalf("process omitted cache invalidation/proof observer: calls=%d events=%d proofs=%d", source.calls.Load(), source.events.Load(), source.proofs.Load())
		}
		time.Sleep(2 * time.Second)
		synctest.Wait()
		if source.calls.Load() != 1 {
			t.Fatal("joined feed restarted after process shutdown")
		}
	})
}
