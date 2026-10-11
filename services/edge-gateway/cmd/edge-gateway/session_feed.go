package main

import (
	"context"

	"github.com/tf4fun/antnest-platform/services/edge-gateway/internal/browserstream"
)

func startSessionRevocationFeed(parent context.Context, registry *browserstream.Registry, source browserstream.FeedSource, observers ...browserstream.FeedObserver) func() {
	ctx, cancel := context.WithCancel(parent)
	done := make(chan struct{})
	go func() { defer close(done); registry.Poll(ctx, source, observers...) }()
	return func() { cancel(); <-done }
}
