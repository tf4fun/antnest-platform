package main

import (
	"context"
	"net/http"
	"sync"

	"github.com/gorilla/websocket"
)

// http.Server drains ordinary requests but does not own hijacked connections.
// Wrap telemetry too, so draining includes each completed connection span.
type webSocketLifecycle struct {
	next     http.Handler
	mu       sync.Mutex
	stopping bool
	active   int
	done     chan struct{}
	ctx      context.Context
	cancel   context.CancelFunc
}

func newWebSocketLifecycle(next http.Handler) *webSocketLifecycle {
	ctx, cancel := context.WithCancel(context.Background())
	return &webSocketLifecycle{next: next, ctx: ctx, cancel: cancel, done: make(chan struct{})}
}

func (lifecycle *webSocketLifecycle) ServeHTTP(response http.ResponseWriter, request *http.Request) {
	if !websocket.IsWebSocketUpgrade(request) {
		lifecycle.next.ServeHTTP(response, request)
		return
	}
	lifecycle.mu.Lock()
	if lifecycle.stopping {
		lifecycle.mu.Unlock()
		http.Error(response, "Gateway is stopping", http.StatusServiceUnavailable)
		return
	}
	lifecycle.active++
	lifecycle.mu.Unlock()
	defer lifecycle.finish()
	ctx, cancel := context.WithCancel(request.Context())
	defer cancel()
	stop := context.AfterFunc(lifecycle.ctx, cancel)
	defer stop()
	lifecycle.next.ServeHTTP(response, request.WithContext(ctx))
}

func (lifecycle *webSocketLifecycle) finish() {
	lifecycle.mu.Lock()
	defer lifecycle.mu.Unlock()
	lifecycle.active--
	if lifecycle.stopping && lifecycle.active == 0 {
		close(lifecycle.done)
	}
}

func (lifecycle *webSocketLifecycle) stop() {
	lifecycle.mu.Lock()
	defer lifecycle.mu.Unlock()
	if lifecycle.stopping {
		return
	}
	lifecycle.stopping = true
	lifecycle.cancel()
	if lifecycle.active == 0 {
		close(lifecycle.done)
	}
}

func (lifecycle *webSocketLifecycle) wait(ctx context.Context) error {
	select {
	case <-lifecycle.done:
		return nil
	case <-ctx.Done():
		return ctx.Err()
	}
}
