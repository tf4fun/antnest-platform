package main

import (
	"context"
	"sync/atomic"
	"testing"
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
