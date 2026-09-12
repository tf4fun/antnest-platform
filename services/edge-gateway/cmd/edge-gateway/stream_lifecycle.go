package main

import (
	"context"
	"log/slog"
	"net/http"
	"strings"
	"sync"

	"github.com/gorilla/websocket"
)

// Count all handlers through telemetry completion; cancel only receive streams.
type streamLifecycle struct {
	next     http.Handler
	logger   *slog.Logger
	mu       sync.Mutex
	stopping bool
	active   int
	done     chan struct{}
	ctx      context.Context
	cancel   context.CancelFunc
}

func newStreamLifecycle(next http.Handler, logger *slog.Logger) *streamLifecycle {
	if logger == nil {
		logger = slog.Default()
	}
	ctx, cancel := context.WithCancel(context.Background())
	return &streamLifecycle{next: next, logger: logger, ctx: ctx, cancel: cancel, done: make(chan struct{})}
}

func (lifecycle *streamLifecycle) ServeHTTP(response http.ResponseWriter, request *http.Request) {
	lifecycle.mu.Lock()
	if lifecycle.stopping {
		lifecycle.mu.Unlock()
		http.Error(response, "Gateway is stopping", http.StatusServiceUnavailable)
		return
	}
	lifecycle.active++
	lifecycle.mu.Unlock()
	defer lifecycle.finish()
	if !managedStream(request) {
		lifecycle.next.ServeHTTP(response, request)
		return
	}
	ctx, cancel := context.WithCancel(request.Context())
	defer cancel()
	stop := context.AfterFunc(lifecycle.ctx, cancel)
	defer stop()
	if !websocket.IsWebSocketUpgrade(request) {
		writer, finish := cancelHTTPStreamWrites(ctx, response, lifecycle.logger)
		defer finish()
		response = writer
	}
	lifecycle.next.ServeHTTP(response, request.WithContext(ctx))
}

func (lifecycle *streamLifecycle) finish() {
	lifecycle.mu.Lock()
	defer lifecycle.mu.Unlock()
	lifecycle.active--
	if lifecycle.stopping && lifecycle.active == 0 {
		close(lifecycle.done)
	}
}

func (lifecycle *streamLifecycle) stop() {
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

func (lifecycle *streamLifecycle) wait(ctx context.Context) error {
	select {
	case <-lifecycle.done:
		return nil
	case <-ctx.Done():
		return ctx.Err()
	}
}

func managedStream(request *http.Request) bool {
	if websocket.IsWebSocketUpgrade(request) {
		return true
	}
	if request.Method != http.MethodGet {
		return false
	}
	parts := strings.Split(strings.TrimPrefix(request.URL.Path, "/"), "/")
	if len(parts) < 5 || parts[0] != "api" || parts[2] != "agents" || parts[3] == "" {
		return false
	}
	receivePath := strings.Join(parts[4:], "/")
	switch parts[1] {
	case "app":
		return receivePath == "state/watch" || receivePath == "v1/acp" || receivePath == "acp"
	case "admin":
		return receivePath == "events/watch"
	default:
		return false
	}
}
