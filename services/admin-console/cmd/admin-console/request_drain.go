package main

import (
	"context"
	"net/http"
	"sync"
)

// http.Server.Close cancels connections but does not wait for request telemetry.
type requestDrain struct {
	next     http.Handler
	mu       sync.Mutex
	stopping bool
	active   int
	done     chan struct{}
}

func newRequestDrain(next http.Handler) *requestDrain {
	return &requestDrain{next: next, done: make(chan struct{})}
}

func (d *requestDrain) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	d.mu.Lock()
	if d.stopping {
		d.mu.Unlock()
		http.Error(w, "Console is stopping", http.StatusServiceUnavailable)
		return
	}
	d.active++
	d.mu.Unlock()
	defer d.finish()
	d.next.ServeHTTP(w, r)
}

func (d *requestDrain) finish() {
	d.mu.Lock()
	defer d.mu.Unlock()
	d.active--
	if d.stopping && d.active == 0 {
		close(d.done)
	}
}

func (d *requestDrain) stop() {
	d.mu.Lock()
	defer d.mu.Unlock()
	if d.stopping {
		return
	}
	d.stopping = true
	if d.active == 0 {
		close(d.done)
	}
}

func (d *requestDrain) wait(ctx context.Context) error {
	select {
	case <-d.done:
		return nil
	case <-ctx.Done():
		return ctx.Err()
	}
}
